const axios = require("axios");
const technicalIndicators = require("technicalindicators");
const { EMA, Stochastic, MACD } = technicalIndicators;
const config = require("../config");

// ===== CONFIG =====
const TELEGRAM_BOT_TOKEN = config.TELEGRAM_BOT_TOKEN_BYBIT_AUTOTRADER;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const TELEGRAM_GROUP_ID = "-1003489385113";

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

const RUN_INTERVAL_MS = 5 * 60 * 1000;
const MOMENTUM_THRESHOLD = 0.5;
const VOLUME_SPIKE_FACTOR = 1.5;
const SWEEP_LOOKBACK = 10;

// ===== STATE =====
let lastStrongAlert = {};

// ===== TELEGRAM =====
async function sendTelegramAlert(message) {
  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: TELEGRAM_GROUP_ID,
      text: message,
      parse_mode: "Markdown",
    });
  } catch (err) {
    console.error(`sendMessage failed:`, err?.response?.data || err.message);
  }
}

// ===== BYBIT CANDLES =====
async function fetchCandles(symbol, interval, limit = 120) {
  const map = {
    "1m": "1",
    "3m": "3",
    "5m": "5",
    "15m": "15",
    "30m": "30",
    "1h": "60",
    "4h": "240",
    "1d": "D",
  };

  const intv = map[interval];
  const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${intv}&limit=${limit}`;

  const res = await axios.get(url, { timeout: 15000 });
  const list = res.data?.result?.list;
  if (!list || !Array.isArray(list)) return [];

  return list
    .map((c) => ({
      time: +c[0],
      open: +c[1],
      high: +c[2],
      low: +c[3],
      close: +c[4],
      volume: +c[5],
    }))
    .reverse();
}

// ===== STC LOGIC =====
function calculateSTCFromCandles(candles) {
  if (!candles || candles.length < 20) return null;
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);

  try {
    MACD.calculate({
      values: closes,
      fastPeriod: 10,
      slowPeriod: 20,
      signalPeriod: 9,
      SimpleMAOscillator: false,
      SimpleMASignal: false,
    });

    const stoch = Stochastic.calculate({
      high: highs,
      low: lows,
      close: closes,
      period: 14,
      signalPeriod: 3,
    });

    if (!stoch || !stoch.length) return null;
    return stoch.map((s) => s.k);
  } catch {
    return null;
  }
}

function stcCycleShiftFromCandles(candles) {
  const stc = calculateSTCFromCandles(candles);
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

// ===== VOLUME / MOMENTUM =====
function hasRecentSpike(candles, lookback = 3) {
  if (!candles || candles.length < 25) return false;

  const volumes = candles.map((c) => c.volume);
  const closes = candles.map((c) => c.close);
  const avgVol = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;

  const start = Math.max(1, candles.length - lookback);
  for (let i = start; i < candles.length; i++) {
    const v = volumes[i];
    const movePct = Math.abs(((closes[i] - closes[i - 1]) / closes[i - 1]) * 100);
    if (v >= avgVol * VOLUME_SPIKE_FACTOR || movePct >= MOMENTUM_THRESHOLD) {
      return true;
    }
  }
  return false;
}

// ===== LIQUIDITY SWEEP =====
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

// ===== MAIN CHANGE IN DIRECTION LOGIC (NO BOS) =====
async function detectConfirmedCycle30(symbol, candles30m, candles15m) {
  try {
    if (!candles30m || candles30m.length < 30 || !candles15m || candles15m.length < 20) return;

    const last30Closed = candles30m.slice(0, -1);
    const dir = stcCycleShiftFromCandles(last30Closed);
    if (!dir) return;

    // === EMA trend filter ===
    const closes30 = last30Closed.map((c) => c.close);
    const ema20 = ema(closes30, 20);
    const last30 = last30Closed[last30Closed.length - 1];
    const prev30 = last30Closed[last30Closed.length - 2];

    const emaOk =
      (dir === "bullish" && last30.close >= ema20 && last30.close >= prev30.close) ||
      (dir === "bearish" && last30.close <= ema20 && last30.close <= prev30.close);

    if (!emaOk) return;

    // === Liquidity sweep Check ===
    const sweep15 = detectLiquiditySweepGeneric(candles15m.slice(0, -1));
    const sweep30 = detectLiquiditySweepGeneric(last30Closed);

    let sweepOk = null;
    if (dir === "bullish") {
      if (sweep15?.side === "down") sweepOk = { side: "Downside", tf: "15m" };
      if (sweep30?.side === "down") sweepOk = { side: "Downside", tf: "30m" };
    } else {
      if (sweep15?.side === "up") sweepOk = { side: "Upside", tf: "15m" };
      if (sweep30?.side === "up") sweepOk = { side: "Upside", tf: "30m" };
    }

    const spike = hasRecentSpike(candles15m.slice(0, -1));

    if (lastStrongAlert[symbol] === last30.time) return;
    lastStrongAlert[symbol] = last30.time;

    // ===== MESSAGE (NO BOS REFERENCING) =====
    let msg = `🔁 *Confirmed Change in Direction* on *${symbol}* (30m): Now *${dir.toUpperCase()}* ${
      dir === "bullish" ? "🟢" : "🔴"
    }\n`;

    if (sweepOk) {
      msg += `🫧 Liquidity Sweep: ${sweepOk.side} (${sweepOk.tf})\n`;
    }

    if (spike) {
      msg += `⚡ Supporting Signal: Volume/Momentum Spike detected`;
    }

    sendTelegramAlert(msg.trim());
  } catch (err) {
    console.error(`detectConfirmedCycle30 error for ${symbol}:`, err?.message || err);
  }
}

// ===== MAIN LOOP =====
async function runScanner() {
  for (const symbol of SYMBOLS) {
    try {
      const [candles15m, candles30m] = await Promise.all([
        fetchCandles(symbol, "15m", 120),
        fetchCandles(symbol, "30m", 120),
      ]);
      await detectConfirmedCycle30(symbol, candles30m, candles15m);
    } catch (err) {
      console.error(`Scanner error for ${symbol}:`, err?.message || err);
    }
  }
}

setInterval(runScanner, RUN_INTERVAL_MS);
runScanner();
