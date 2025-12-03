// yahoo_nyse_fx_scanner.js
// Node.js scanner that fetches 15m candles from Yahoo Finance for NYSE stocks + FX pairs,
// computes indicators and sends Telegram alerts (structure similar to your crypto bot).

const axios = require("axios");
const technicalIndicators = require("technicalindicators");
const { EMA, Stochastic, MACD, ATR, BollingerBands } = technicalIndicators;
const fs = require("fs");

// ===== CONFIG =====
const TELEGRAM_BOT_TOKEN = "8379995077:AAEvVrzeIi6tQpFWb4ZZqITcUOsRHJiylJs";
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const TELEGRAM_CHAT_IDS = ["7326321618"]; // replace
const ADMIN_ID = "7326321618";

const FX_SYMBOLS_YAHOO = [
  // Yahoo FX format examples:
  "EURUSD=X",
  "GBPUSD=X",
  "USDNGN=X", // may or may not exist on Yahoo — verify
  "USDJPY=X",
  "USDCAD=X",
  "NZDUSD=X",
  "USDCHF=X",
  "AUDUSD=X",
  "GC=F",
  "SI=F",
  "CL=F",
];

const ALL_SYMBOLS = [...FX_SYMBOLS_YAHOO];

const RUN_INTERVAL_MS = 15 * 60 * 1000; // every 15 minutes
const MOMENTUM_THRESHOLD = 0.5;
const VOLUME_SPIKE_FACTOR = 1.5;
const SWEEP_LOOKBACK = 10;
const PERSIST_OBV_WINDOW = 8;

let lastPotentialAlert = {};
let lastStrongAlert = {};
let lastPersistenceAlert = {};
let activeStrongCycle = {};
let lastLiqManipAlert = {};
let lastDailyDirectionSent = {};
let lastBBSqueezeAlert = {};
let lastBBExpandAlert = {};
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

/**
 * Fetch candles from Yahoo Finance chart endpoint
 * symbol: Yahoo ticker (eg "EURUSD=X" or "DANGOTE.NG" — ensure correct Yahoo symbol)
 * interval: one of '1m','2m','5m','15m','60m','1d' - we'll use '15m' and '60m'/'4h' converted
 * limit: number of candles desired
 *
 * returns: [{ time, open, high, low, close, volume }, ...] - time in ms
 */
async function fetchYahooCandles(symbol, interval = "15m", limit = 120) {
  // Yahoo chart endpoint mapping:
  // interval strings that Yahoo accepts: 1m,2m,5m,15m,30m,60m,90m,1h,1d,5d,1wk etc.
  const period = "7d"; // request 7 days which contains many 15m bars; adjust if needed
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?interval=${interval}&range=${period}&includePrePost=false&events=div%2Csplit%2Cearn`;
  const res = await axios.get(url, { timeout: 20000 });
  const data = res.data;

  if (!data || !data.chart || !data.chart.result || !data.chart.result[0]) {
    throw new Error(`Yahoo data missing for ${symbol}`);
  }
  const r = data.chart.result[0];
  const timestamps = r.timestamp || [];
  const indicators = r.indicators || {};
  const quote = indicators.quote && indicators.quote[0] ? indicators.quote[0] : null;

  if (!quote || !timestamps.length) {
    throw new Error(`Yahoo quote missing for ${symbol}`);
  }

  const opens = quote.open || [];
  const highs = quote.high || [];
  const lows = quote.low || [];
  const closes = quote.close || [];
  const volumes = quote.volume || [];

  const candles = [];
  for (let i = 0; i < timestamps.length; i++) {
    // Some points may be null (market closed or incomplete) - skip those
    if (opens[i] === null || highs[i] === null || lows[i] === null || closes[i] === null) continue;
    candles.push({
      time: timestamps[i] * 1000,
      open: +opens[i],
      high: +highs[i],
      low: +lows[i],
      close: +closes[i],
      volume: volumes[i] != null ? +volumes[i] : 0,
    });
  }

  // Keep only last `limit` candles
  return candles.slice(-limit);
}

// STC proxy (using stochastic for now)
function calculateSTC(closes) {
  // we call MACD.calculate just to follow earlier pattern, but we use Stochastic for STC proxy
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

/* Supporting helpers reused by alerts (same logic as your crypto bot) */
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
    if (!c0 || c0 === 0) continue;
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
  const price = candles30m[candles30m.length - 1].close || 1;
  const atrPct = (atr / price) * 100;
  const pf = pressureLabel === "Increasing" ? 1.6 : 0.95;
  const estMove = atrPct * 1.2 * pf;
  const hours = Math.max(0.5, Math.min(12, Math.abs(estMove) / Math.max(0.0001, atrPct * 2)));
  const minsMin = Math.round(Math.max(15, hours * 60 * 0.8));
  const minsMax = Math.round(Math.max(minsMin + 15, hours * 60 * 1.2));
  return { movePct: estMove, minsMin, minsMax };
}

// ---------- Alert functions (mirrored from your crypto bot) ----------

// 1) Potential Change in Direction (15m)
function detectPotentialCycle15(symbol, candles15m) {
  if (!candles15m || candles15m.length < 30) return;
  const closedCandles = candles15m.slice(0, -1);
  if (!closedCandles || closedCandles.length < 2) return;
  const closesClosed = closedCandles.map((c) => c.close);

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
  const closed30 = candles30m.slice(0, -1);
  if (!closed30 || closed30.length < 2) return;
  const closes30Closed = closed30.map((c) => c.close);

  const dir = stcCycleShift(closes30Closed);
  if (!dir) return;

  const ema20_30 = ema(closes30Closed, 20);
  const last30Closed = closed30[closed30.length - 1];
  const prev30Closed = closed30[closed30.length - 2];
  const emaOk =
    (dir === "bullish" && last30Closed.close >= ema20_30 && last30Closed.close >= prev30Closed.close) ||
    (dir === "bearish" && last30Closed.close <= ema20_30 && last30Closed.close <= prev30Closed.close);
  if (!emaOk) return;

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
const EXT_MANIP_WHIPSAW_PCT = 4;
const EXT_MANIP_VOL_FACTOR = 2;
const EXT_MANIP_MIN_SPIKES = 4;
const EXT_MANIP_STC_FLIPS = 5;

function checkExtendedManipulation(symbol, candles15m) {
  try {
    if (!candles15m || candles15m.length < 48) return;
    const closed = candles15m.slice(0, -1);
    if (closed.length < 48) return;

    const now = Date.now();
    const lastAlertTime = lastExtendedManipAlert[symbol]?.time || 0;
    if (now - lastAlertTime < EXT_MANIP_COOLDOWN_MS) return;

    const hourUTC = new Date().getUTCHours();
    let session = "";
    if (hourUTC >= 0 && hourUTC < 8) session = "Asia";
    else if (hourUTC >= 8 && hourUTC < 16) session = "London";
    else session = "New York";

    const windowArr = closed.slice(-48);
    const closes = windowArr.map((c) => c.close);
    const volumes = windowArr.map((c) => c.volume);

    // Whipsaw
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

    // High-volume clusters
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

    // STC flips
    const stcVals = calculateSTC(closes);
    let flips = 0;
    for (let i = 1; i < stcVals.length; i++) {
      const prev = stcVals[i - 1];
      const curr = stcVals[i];
      if ((prev <= 25 && curr > 25) || (prev >= 75 && curr < 75)) flips++;
    }
    const stcChoppy = flips >= EXT_MANIP_STC_FLIPS;

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

/* ========== PRICE ACTION SPEED (15m) ========== */
function detectPriceActionSpeed15(symbol, candles15m) {
  if (!candles15m || candles15m.length < 25) return;
  const closed = candles15m.slice(0, -1);
  const lookback = 24;
  if (closed.length < lookback) return;

  const oldest = closed[closed.length - lookback].close;
  const latest = closed[closed.length - 1].close;
  if (!oldest || oldest === 0) return;
  const pctChange = ((latest - oldest) / oldest) * 100;
  const lastCandleTime = closed[closed.length - 1].time;
  const key = `${symbol}_${lastCandleTime}`;

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
  if (!open || open === 0) return;
  const change = ((close - open) / open) * 100;

  let dir = "Sideways";
  if (change > 0.5) dir = "Bullish 🟢";
  else if (change < -0.5) dir = "Bearish 🔴";

  sendTelegramAlert(`🗓️ *Daily Direction* on *${symbol}*: ${dir}`);
  lastDailyDirectionSent[symbol] = today;
}

// ========== MAIN SCANNER LOOP ==========
async function runYahooScanner() {
  for (const symbol of ALL_SYMBOLS) {
    try {
      // fetch
      const [candles15m, candles30m, candles4h] = await Promise.all([
        fetchYahooCandles(symbol, "15m", 240), // 15m
        fetchYahooCandles(symbol, "30m", 240), // 30m
        fetchYahooCandles(symbol, "60m", 200), // we'll use 60m as proxy for 4h window (or adjust)
      ]);

      // Use the same detection pipeline
      detectPotentialCycle15(symbol, candles15m);
      detectConfirmedCycle30(symbol, candles30m, candles15m);
      detectCyclePersistence15(symbol, candles15m, candles30m);
      detectLiquidityAndManipulation15(symbol, candles15m);
      checkExtendedManipulation(symbol, candles15m);
      detectPriceActionSpeed15(symbol, candles15m);
      detectDailyDirection(symbol, candles4h);
    } catch (err) {
      console.error(`Scanner error for ${symbol}:`, err?.response?.data || err?.message || err);
    }
  }
}

// Start
setInterval(runYahooScanner, RUN_INTERVAL_MS);
runYahooScanner();

// EOF
