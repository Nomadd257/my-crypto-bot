const config = require("../config");
const axios = require("axios");
const technicalIndicators = require("technicalindicators");
const { EMA, Stochastic, MACD, ATR, BollingerBands } = technicalIndicators;
const fs = require("fs");

// ===== CONFIG =====
const TELEGRAM_BOT_TOKEN = config.TELEGRAM_BOT_TOKEN_BINANCE_FVG;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const TELEGRAM_CHAT_IDS = [
  "1718404728",
  // "6199134135",
  "6852065235",
  "7232112905",
  "6622824400",
  // "6578705929",
  // "7509587784",
  // "7059800284",
  // "6890599914",
  "6335276048",
  // "-1003419090746",
];
const ADMIN_ID = "1718404728";

const SYMBOLS = [
  "BTCUSDT",
  "ETHUSDT",
  "LTCUSDT",
  "XRPUSDT",
  "APTUSDT",
  "BNBUSDT",
  "SOLUSDT",
  "UNIUSDT",
  "TRUMPUSDT",
  "BCHUSDT",
  "AAVEUSDT",
  "ADAUSDT",
  "TONUSDT",
];

// const NEW_CHANNEL_CHAT_ID = ["1003187242241"];

const RUN_INTERVAL_MS = 5 * 60 * 1000;
const MOMENTUM_THRESHOLD = 0.5; // percent move threshold for momentum tag
const VOLUME_SPIKE_FACTOR = 1.5; // 1.5x avg volume considered spike
const SWEEP_LOOKBACK = 10; // bars to form a prior high/low reference for sweep
const PERSIST_OBV_WINDOW = 8; // OBV window (15m) to judge pressure

// Bollinger thresholds (percent bandwidth)
const BB_SQUEEZE_PCT = 1.5; // squeeze threshold (bandwidth <= this)
const BB_EXPAND_PCT = 3.5; // expansion threshold (bandwidth >= this)

// ===== STATE =====
let lastPotentialAlert = {};
let lastNormalAlert = {};
let lastStrongAlert = {};
let lastPersistenceAlert = {};
let activeStrongCycle = {};
let lastLiqManipAlert = {};
let lastDailyDirectionSent = {}; // { symbol: 'YYYY-MM-DD' }
let lastBBSqueezeAlert = {};
let lastBBExpandAlert = {};
// dedupe for extended manipulation alerts
let lastExtendedManipAlert = {};

// ===== HELPERS =====
async function sendTelegramAlert(message) {
  const requests = TELEGRAM_CHAT_IDS.map((chat_id) =>
    axios
      .post(`${TELEGRAM_API}/sendMessage`, {
        chat_id,
        text: message,
        parse_mode: "Markdown",
      })
      .catch((err) => {
        console.error(`sendMessage to ${chat_id} failed:`, err?.response?.data || err.message);
        return null;
      })
  );
  await Promise.all(requests);
}

async function fetchCandles(symbol, interval, limit = 120) {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await axios.get(url, { timeout: 15000 });
  return res.data.map((c) => ({
    time: c[0],
    open: +c[1],
    high: +c[2],
    low: +c[3],
    close: +c[4],
    volume: +c[5],
  }));
}

// STC proxy (using stochastic for now)
function calculateSTC(closes) {
  MACD.calculate({
    values: closes,
    fastPeriod: 10,
    slowPeriod: 20,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
  const stoch = Stochastic.calculate({
    high: closes,
    low: closes,
    close: closes,
    period: 14,
    signalPeriod: 3,
  });
  return stoch.map((s) => s.k);
}
function stcCycleShift(closes) {
  const stc = calculateSTC(closes);
  if (!stc || stc.length < 2) return null;
  const curr = stc[stc.length - 1];
  const prev = stc[stc.length - 2];
  if (curr > 25 && prev <= 25) return "bullish";
  if (curr < 75 && prev >= 75) return "bearish";
  return null;
}
function ema(values, period) {
  const arr = EMA.calculate({ period, values });
  return arr.length ? arr[arr.length - 1] : values[values.length - 1];
}

/* Supporting helpers reused by alerts */
function hasRecentSpike(candles, lookback = 3) {
  if (!candles || candles.length < 25) return false;
  const volumes = candles.map((c) => c.volume);
  const closes = candles.map((c) => c.close);
  const avgVol = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;

  const start = Math.max(1, candles.length - lookback);
  for (let i = start; i < candles.length; i++) {
    const v = volumes[i];
    const c0 = closes[i - 1];
    const c1 = closes[i];
    const movePct = Math.abs(((c1 - c0) / c0) * 100);
    if ((avgVol > 0 && v >= avgVol * VOLUME_SPIKE_FACTOR) || movePct >= MOMENTUM_THRESHOLD) {
      return true;
    }
  }
  return false;
}

function detectLiquiditySweepGeneric(candles, lookback = SWEEP_LOOKBACK) {
  if (!candles || candles.length < lookback + 2) return null;
  const last = candles[candles.length - 1];
  const ref = candles.slice(-(lookback + 1), -1);
  const priorHigh = Math.max(...ref.map((c) => c.high));
  const priorLow = Math.min(...ref.map((c) => c.low));

  const upSweep = last.high > priorHigh && last.close < priorHigh && last.close < last.open;
  const downSweep = last.low < priorLow && last.close > priorLow && last.close > last.open;

  if (upSweep) return { side: "up", time: last.time };
  if (downSweep) return { side: "down", time: last.time };
  return null;
}

function calcOBVTrend(candles, window = PERSIST_OBV_WINDOW) {
  if (!candles || candles.length < window + 2) return 0;
  let obv = 0;
  const arr = [];
  for (let i = 1; i < candles.length; i++) {
    const delta =
      candles[i].close > candles[i - 1].close
        ? candles[i].volume
        : candles[i].close < candles[i - 1].close
        ? -candles[i].volume
        : 0;
    obv += delta;
    arr.push(obv);
  }
  const a = arr[arr.length - 1];
  const b = arr[Math.max(0, arr.length - 1 - window)];
  return a - b;
}

function estimateMoveAndTimeFrom30(candles30m, dir, pressureLabel) {
  if (!candles30m || candles30m.length < 20) return { movePct: 0.5, minsMin: 60, minsMax: 180 };
  const atrArr = ATR.calculate({
    high: candles30m.map((c) => c.high),
    low: candles30m.map((c) => c.low),
    close: candles30m.map((c) => c.close),
    period: 14,
  });
  if (!atrArr.length) return { movePct: 0.5, minsMin: 60, minsMax: 180 };

  const atr = atrArr[atrArr.length - 1];
  const price = candles30m[candles30m.length - 1].close;
  const atrPct = (atr / price) * 100;
  const pf = pressureLabel === "Increasing" ? 1.6 : 0.95;
  const estMove = atrPct * 1.2 * pf;
  const hours = Math.max(0.5, Math.min(12, Math.abs(estMove) / Math.max(0.0001, atrPct * 2)));
  const minsMin = Math.round(Math.max(15, hours * 60 * 0.8));
  const minsMax = Math.round(Math.max(minsMin + 15, hours * 60 * 1.2));
  return { movePct: estMove, minsMin, minsMax };
}

// 1) Potential Change in Direction (15m)
function detectPotentialCycle15(symbol, candles15m) {
  if (!candles15m || candles15m.length < 30) return;

  // Use only closed candles: exclude the latest (possibly in-progress) candle
  const closedCandles = candles15m.slice(0, -1);
  if (!closedCandles || closedCandles.length < 2) return;

  const closesClosed = closedCandles.map((c) => c.close);

  // Determine STC on closed data (so we only alert after the candle has closed)
  const dir = stcCycleShift(closesClosed);
  if (!dir) return;

  const ema20 = ema(closesClosed, 20);
  const lastClosed = closedCandles[closedCandles.length - 1];
  const prev1Closed = closedCandles[closedCandles.length - 2];
  const emaOk =
    (dir === "bullish" && lastClosed.close >= ema20 && lastClosed.close >= prev1Closed.close) ||
    (dir === "bearish" && lastClosed.close <= ema20 && lastClosed.close <= prev1Closed.close);
  if (!emaOk) return;

  if (lastPotentialAlert[symbol] === lastClosed.time) return;
  lastPotentialAlert[symbol] = lastClosed.time;

  const supporting = hasRecentSpike(closedCandles, 3);
  const msg = [
    `🔁 *Potential Change in Direction* on *${symbol}* *(15m)*: Now *${dir.toUpperCase()}* ${
      dir === "bullish" ? "🟢" : "🔴"
    }`,
    supporting ? `⚡ Supporting Signal: Volume/Momentum Spike detected` : null,
    `⏳ Awaiting 30m confirmation...`,
  ]
    .filter(Boolean)
    .join("\n");

  sendTelegramAlert(msg);
}

/* 2) Normal/Strong Confirmed Change in Direction (30m) */
function detectConfirmedCycle30(symbol, candles30m, candles15m) {
  if (!candles30m || candles30m.length < 30) return;

  // Use only closed 30m candles
  const closed30 = candles30m.slice(0, -1);
  if (!closed30 || closed30.length < 2) return;

  const closes30Closed = closed30.map((c) => c.close);

  // Determine STC on closed 30m data
  const dir = stcCycleShift(closes30Closed);
  if (!dir) return;

  const ema20_30 = ema(closes30Closed, 20);
  const last30Closed = closed30[closed30.length - 1];
  const prev30Closed = closed30[closed30.length - 2];
  const emaOk =
    (dir === "bullish" && last30Closed.close >= ema20_30 && last30Closed.close >= prev30Closed.close) ||
    (dir === "bearish" && last30Closed.close <= ema20_30 && last30Closed.close <= prev30Closed.close);
  if (!emaOk) return;

  // Check sweeps on closed candles (15m and 30m)
  const sweep15 = detectLiquiditySweepGeneric(candles15m.slice(0, -1));
  const sweep30 = detectLiquiditySweepGeneric(closed30);
  let sweepOk = null;
  if (dir === "bullish") {
    if (sweep15 && sweep15.side === "down") sweepOk = { tf: "15m", side: "Downside" };
    else if (sweep30 && sweep30.side === "down") sweepOk = { tf: "30m", side: "Downside" };
  } else {
    if (sweep15 && sweep15.side === "up") sweepOk = { tf: "15m", side: "Upside" };
    else if (sweep30 && sweep30.side === "up") sweepOk = { tf: "30m", side: "Upside" };
  }

  if (lastStrongAlert[symbol] === last30Closed.time) return;
  lastStrongAlert[symbol] = last30Closed.time;

  const supporting = hasRecentSpike(candles15m.slice(0, -1), 3) || hasRecentSpike(closed30, 2);

  if (sweepOk) {
    // Strong confirmed (with sweep)
    activeStrongCycle[symbol] = { direction: dir, startTime: last30Closed.time };

    const msg = [
      `🔁 *Confirmed Change in Direction (Strong)* on *${symbol}* *(30m)*: Now *${dir.toUpperCase()}* ${
        dir === "bullish" ? "🟢" : "🔴"
      }`,
      `🫧 Liquidity Sweep: *${sweepOk.side}* (${sweepOk.tf})`,
      supporting ? `⚡ Supporting Signal: Volume/Momentum Spike adds strength` : null,
    ]
      .filter(Boolean)
      .join("\n");

    sendTelegramAlert(msg);
  } else {
    // Normal confirmed (without sweep)
    const msg = [
      `🔁 *Confirmed Change in Direction* on *${symbol}* *(30m)*: Now *${dir.toUpperCase()}* ${
        dir === "bullish" ? "🟢" : "🔴"
      }`,
      supporting ? `⚡ Supporting Signal: Volume/Momentum Spike detected` : null,
    ]
      .filter(Boolean)
      .join("\n");

    sendTelegramAlert(msg);
  }
}

/* 3) Cycle Persistence → Price Movement Status (15m) */
function detectCyclePersistence15(symbol, candles15m, candles30m) {
  const state = activeStrongCycle[symbol];
  if (!state) return;
  if (!candles15m || candles15m.length < 25 || !candles30m || candles30m.length < 20) return;

  const closed30 = candles30m.slice(0, -1);
  if (!closed30 || closed30.length < 2) return;
  const closes30Closed = closed30.map((c) => c.close);
  const flip = stcCycleShift(closes30Closed);
  if (flip && flip !== state.direction) {
    delete activeStrongCycle[symbol];
    return;
  }

  const closed15 = candles15m.slice(0, -1);
  if (!closed15 || closed15.length < 1) return;

  const last15Closed = closed15[closed15.length - 1];
  if (lastPersistenceAlert[symbol] === last15Closed.time) return;
  lastPersistenceAlert[symbol] = last15Closed.time;

  const obvSlope = calcOBVTrend(closed15, PERSIST_OBV_WINDOW);
  let pressureLabel;
  if (state.direction === "bullish") {
    pressureLabel = obvSlope > 0 ? "Increasing" : obvSlope < 0 ? "Decreasing" : "Flat";
  } else {
    pressureLabel = obvSlope < 0 ? "Increasing" : obvSlope > 0 ? "Decreasing" : "Flat";
  }

  const atr15Arr = ATR.calculate({
    high: closed15.map((c) => c.high),
    low: closed15.map((c) => c.low),
    close: closed15.map((c) => c.close),
    period: 14,
  });
  const atr15 = atr15Arr.length ? atr15Arr[atr15Arr.length - 1] : null;
  const price15 = last15Closed.close;
  const atrPullbackPct = atr15 ? (atr15 / price15) * 100 : null;

  const { movePct, minsMin, minsMax } = estimateMoveAndTimeFrom30(closed30, state.direction, pressureLabel);
  const sign = state.direction === "bullish" ? "+" : "−";
  const supporting = hasRecentSpike(closed15, 2);

  const lines = [
    `${state.direction === "bullish" ? "📈" : "📉"} *Price Movement Status* on *${symbol}*: *Strong ${
      state.direction === "bullish" ? "Bullish" : "Bearish"
    }*`,
    `• ${state.direction === "bullish" ? "Buying" : "Selling"} Pressure: *${pressureLabel}*`,
    atrPullbackPct !== null ? `• Expected short-term reversal size: ~${atrPullbackPct.toFixed(2)}%` : null,
    `• Estimated Move: ${sign}${Math.abs(movePct).toFixed(2)}%`,
    `• Expected within: *${minsMin}–${minsMax} min*`,
    supporting ? `⚡ Supporting Signal: Recent Volume/Momentum Spike` : null,
  ]
    .filter(Boolean)
    .join("\n");

  sendTelegramAlert(lines);
}

// ===== EXTENDED MANIPULATION DETECTION (UPDATED) =====
const EXT_MANIP_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours per symbol
const EXT_MANIP_WHIPSAW_PCT = 4; // Whipsaw threshold
const EXT_MANIP_VOL_FACTOR = 2; // Volume spike factor
const EXT_MANIP_MIN_SPIKES = 4; // Minimum volume spikes in tight range
const EXT_MANIP_STC_FLIPS = 5; // STC flips threshold

function checkExtendedManipulation(symbol, candles15m) {
  try {
    if (!candles15m || candles15m.length < 48) return; // need reasonable history
    const closed = candles15m.slice(0, -1);
    if (closed.length < 48) return;

    const now = Date.now();
    const lastAlertTime = lastExtendedManipAlert[symbol]?.time || 0;
    if (now - lastAlertTime < EXT_MANIP_COOLDOWN_MS) return;

    // Determine session
    const hourUTC = new Date().getUTCHours();
    let session = "";
    if (hourUTC >= 0 && hourUTC < 8) session = "Asia";
    else if (hourUTC >= 8 && hourUTC < 16) session = "London";
    else session = "New York";

    const windowArr = closed.slice(-48);
    const closes = windowArr.map((c) => c.close);
    const volumes = windowArr.map((c) => c.volume);

    // 1) Whipsaw detection (>4% up then >4% down or vice versa)
    let whipsaw = false;
    const priceHigh = Math.max(...closes);
    const priceLow = Math.min(...closes);
    const pctHighFromLow = ((priceHigh - priceLow) / priceLow) * 100;
    if (pctHighFromLow >= EXT_MANIP_WHIPSAW_PCT) {
      const idxHigh = closes.indexOf(priceHigh);
      const idxLow = closes.indexOf(priceLow);
      if (Math.abs(idxHigh - idxLow) >= 1) {
        const upThenDown = (priceHigh / priceLow - 1) * 100 >= 4 && ((priceHigh - priceLow) / priceHigh) * 100 >= 4;
        if (upThenDown) whipsaw = true;
      }
    }

    // 2) High-volume clusters
    const avgVol = volumes.slice(0, -1).reduce((a, b) => a + b, 0) / Math.max(1, volumes.length - 1);
    const spikeIdxs = [];
    for (let i = 0; i < volumes.length; i++) {
      if (avgVol > 0 && volumes[i] >= avgVol * EXT_MANIP_VOL_FACTOR) spikeIdxs.push(i);
    }
    let volumeCluster = false;
    if (spikeIdxs.length >= EXT_MANIP_MIN_SPIKES) {
      const spikePrices = spikeIdxs.map((i) => closes[i]);
      const maxS = Math.max(...spikePrices);
      const minS = Math.min(...spikePrices);
      const bandPct = ((maxS - minS) / minS) * 100;
      if (bandPct <= 1.0) volumeCluster = true;
    }

    // 3) STC flips multiple times
    const stcVals = calculateSTC(closes);
    let flips = 0;
    for (let i = 1; i < stcVals.length; i++) {
      const prev = stcVals[i - 1];
      const curr = stcVals[i];
      if ((prev <= 25 && curr > 25) || (prev >= 75 && curr < 75)) flips++;
    }
    const stcChoppy = flips >= EXT_MANIP_STC_FLIPS;

    // Trigger if ≥2 characteristics detected
    const detected = [whipsaw, volumeCluster, stcChoppy];
    const trueCount = detected.filter(Boolean).length;
    if (trueCount >= 2) {
      const lastClosed = closed[closed.length - 1];
      lastExtendedManipAlert[symbol] = { time: now };

      const charList = [];
      if (whipsaw) charList.push("• Whipsaw swings (>4% up/down)");
      if (volumeCluster) charList.push("• High-volume cluster in tight range");
      if (stcChoppy) charList.push("• STC flipping multiple times (choppy)");

      const header = `🕵️ *Manipulation in progress* on *${symbol}* (15m)`;
      const body =
        `Fake Price movements are being made. Be Cautious.\n` +
        `Session: *${session}*\n\n` +
        `Detected characteristics:\n` +
        charList.join("\n") +
        `\n\nTime: ${new Date(lastClosed.time).toISOString()}`;

      sendTelegramAlert(`${header}\n\n${body}`);
    }
  } catch (err) {
    console.error(`checkExtendedManipulation error for ${symbol}:`, err?.message || err);
  }
}

/* ========== LIQUIDITY / MANIPULATION (15m) ========== */
function detectLiquidityAndManipulation15(symbol, candles15m) {
  if (!candles15m || candles15m.length < 30) return;
  const last = candles15m[candles15m.length - 1];
  const price = last.close;
  const lookback = candles15m.slice(-30);

  const swingHigh = Math.max(...lookback.map((c) => c.high));
  const swingLow = Math.min(...lookback.map((c) => c.low));

  const atrArr = ATR.calculate({
    high: lookback.map((c) => c.high),
    low: lookback.map((c) => c.low),
    close: lookback.map((c) => c.close),
    period: 14,
  });
  if (!atrArr.length) return;
  const atr = atrArr[atrArr.length - 1];

  const distToHigh = Math.abs(price - swingHigh);
  const distToLow = Math.abs(price - swingLow);
  const nearestIsSupport = distToLow <= distToHigh;
  const nearestLabel = nearestIsSupport ? "Support" : "Resistance";
  const nearestLevel = nearestIsSupport ? swingLow : swingHigh;

  const expectedSweepBuffer = price * 0.005;
  const estimatedManipRange = 0.5 * atr + expectedSweepBuffer;

  let suggestedEntry, suggestedStop;
  if (nearestIsSupport) {
    suggestedEntry = swingLow + expectedSweepBuffer;
    suggestedStop = swingLow - 0.5 * atr;
  } else {
    suggestedEntry = swingHigh - expectedSweepBuffer;
    suggestedStop = swingHigh + 0.5 * atr;
  }

  const highZoneMin = swingHigh - 0.5 * atr;
  const highZoneMax = swingHigh + 0.5 * atr;
  const lowZoneMin = swingLow - 0.5 * atr;
  const lowZoneMax = swingLow + 0.5 * atr;

  const dedupKey = `${symbol}_${last.time}`;
  if (lastLiqManipAlert[dedupKey]) return;
  lastLiqManipAlert[dedupKey] = true;

  const header = `💧 Potential Fake Price Movements on *${symbol}* (15m)`;
  const body =
    `${nearestLabel}: ${nearestLevel.toFixed(4)}\n` +
    `ATR(14): ${atr.toFixed(4)}\n` +
    `Expected Sweep Buffer: ${expectedSweepBuffer.toFixed(4)} (0.50%)\n` +
    `Estimated Manipulation Range: ${estimatedManipRange.toFixed(4)}\n\n` +
    `📍 Suggested Entry: ${suggestedEntry.toFixed(4)}\n` +
    `🛑 Suggested Stop Loss: ${suggestedStop.toFixed(4)}\n\n` +
    `Potential Entry Zones (±0.5 ATR):\n` +
    `- Around Swing High: ${highZoneMin.toFixed(4)} - ${highZoneMax.toFixed(4)}\n` +
    `- Around Swing Low: ${lowZoneMin.toFixed(4)} - ${lowZoneMax.toFixed(4)}`;

  sendTelegramAlert(`${header}\n${body}`);
}

/* ========== PRICE ACTION SPEED (15m, percent-change over closed last 24 candles) ========== */
function detectPriceActionSpeed15(symbol, candles15m) {
  if (!candles15m || candles15m.length < 25) return;
  const closed = candles15m.slice(0, -1);
  const lookback = 24; // last 24 closed 15m candles = 6 hours
  if (closed.length < lookback) return;

  const oldest = closed[closed.length - lookback].close;
  const latest = closed[closed.length - 1].close;
  const pctChange = ((latest - oldest) / oldest) * 100;
  const lastCandleTime = closed[closed.length - 1].time;
  const key = `${symbol}_${lastCandleTime}`;

  // thresholds per your instruction: squeeze <1.3, expansion >1.3
  if (Math.abs(pctChange) <= 1.3) {
    if (lastBBSqueezeAlert[key]) return;
    lastBBSqueezeAlert[key] = true;
    const msg =
      `📊 *Price Action Speed* on *${symbol}* (15m)\n` +
      `• Change: ${pctChange.toFixed(2)}%\n` +
      `• *Squeeze* (Price movements slowing down)`;
    sendTelegramAlert(msg);
  } else if (Math.abs(pctChange) > 1.3) {
    if (lastBBExpandAlert[key]) return;
    lastBBExpandAlert[key] = true;
    const direction = pctChange > 0 ? "Upside" : "Downside";
    const msg =
      `📊 *Price Action Speed* on *${symbol}* (15m)\n` +
      `• Change: ${pctChange.toFixed(2)}%\n` +
      `• *Expansion* (${direction})`;
    sendTelegramAlert(msg);
  }
}

/* ========== DAILY DIRECTION (4h, once per UTC day) ========== */
function detectDailyDirection(symbol, candles4h) {
  if (!candles4h || candles4h.length < 1) return;
  const today = new Date().toISOString().split("T")[0];
  if (lastDailyDirectionSent[symbol] === today) return;

  const open = candles4h[0].open;
  const close = candles4h[candles4h.length - 1].close;
  const change = ((close - open) / open) * 100;

  let dir = "Sideways";
  if (change > 0.5) dir = "Bullish 🟢";
  else if (change < -0.5) dir = "Bearish 🔴";

  sendTelegramAlert(`🗓️ *Daily Direction* on *${symbol}*: ${dir}`);
  lastDailyDirectionSent[symbol] = today;
}

/* ========== MAIN SCANNER LOOP ========== */
async function runScanner() {
  for (const symbol of SYMBOLS) {
    try {
      const [candles15m, candles30m, candles4h] = await Promise.all([
        fetchCandles(symbol, "15m", 120),
        fetchCandles(symbol, "30m", 120),
        fetchCandles(symbol, "4h", 6),
      ]);

      // 1) Potential Change in Direction (15m)
      detectPotentialCycle15(symbol, candles15m);

      // 2) Confirmed Change in Direction (30m)
      detectConfirmedCycle30(symbol, candles30m, candles15m);

      // 3) Price Movement Status (Cycle Persistence)
      detectCyclePersistence15(symbol, candles15m, candles30m);

      // 4) Potential Fake Price Movements (Liquidity/Manipulation)
      detectLiquidityAndManipulation15(symbol, candles15m);

      // 4b) Extended manipulation scanning (new) — separate long-running manipulation thread detection
      checkExtendedManipulation(symbol, candles15m);

      // 5) Price Action Speed (percent-change over closed 24 x 15m bars)
      detectPriceActionSpeed15(symbol, candles15m);

      // 6) Daily Direction Snapshot (4h once per UTC day)
      detectDailyDirection(symbol, candles4h);
    } catch (err) {
      console.error(`Scanner error for ${symbol}:`, err?.message || err);
    }
  }
}

// Start scanner
setInterval(runScanner, RUN_INTERVAL_MS);
runScanner();
