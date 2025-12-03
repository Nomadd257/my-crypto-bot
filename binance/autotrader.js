const axios = require("axios");
const technicalIndicators = require("technicalindicators");
const { EMA, Stochastic, MACD } = technicalIndicators;

// ===== CONFIG =====
const TELEGRAM_BOT_TOKEN = "8519405906:AAFlRHAVfnggvpBxTjc0qxS9tlyeRq_Otjw";
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const TELEGRAM_GROUP_ID = "-1003419090746";

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
let lastStrongAlert = {}; // prevents duplicate cycle alerts

// ===== HELPERS =====
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

// ===== STC LOGIC + CYCLE SHIFT =====
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

function hasRecentSpike(candles, lookback = 3) {
  if (!candles || candles.length < 25) return false;

  const volumes = candles.map((c) => c.volume);
  const closes = candles.map((c) => c.close);
  const avgVol = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  const start = Math.max(1, candles.length - lookback);

  for (let i = start; i < candles.length; i++) {
    const v = volumes[i];
    const movePct = Math.abs(((closes[i] - closes[i - 1]) / closes[i - 1]) * 100);

    if (v >= avgVol * VOLUME_SPIKE_FACTOR || movePct >= MOMENTUM_THRESHOLD) return true;
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

// ===== MAIN DETECTION (BOS REMOVED) =====
async function detectConfirmedCycle30(symbol, candles30m, candles15m) {
  try {
    if (!candles30m || candles30m.length < 30) return;
    if (!candles15m || candles15m.length < 20) return;

    const closed30 = candles30m.slice(0, -1);
    const direction = stcCycleShiftFromCandles(closed30);
    if (!direction) return;

    const closes30 = closed30.map((c) => c.close);
    const ema20 = ema(closes30, 20);

    const last30 = closed30[closed30.length - 1];
    const prev30 = closed30[closed30.length - 2];

    const emaOk =
      (direction === "bullish" && last30.close >= ema20 && last30.close >= prev30.close) ||
      (direction === "bearish" && last30.close <= ema20 && last30.close <= prev30.close);

    if (!emaOk) return;

    // LIQUIDITY SWEEP CHECK
    const sweep15 = detectLiquiditySweepGeneric(candles15m.slice(0, -1));
    const sweep30 = detectLiquiditySweepGeneric(closed30);

    let sweepOk = null;

    if (direction === "bullish") {
      if (sweep15?.side === "down") sweepOk = { tf: "15m", side: "Downside" };
      if (sweep30?.side === "down") sweepOk = { tf: "30m", side: "Downside" };
    } else {
      if (sweep15?.side === "up") sweepOk = { tf: "15m", side: "Upside" };
      if (sweep30?.side === "up") sweepOk = { tf: "30m", side: "Upside" };
    }

    // Prevent duplicate alerts
    if (lastStrongAlert[symbol] === last30.time) return;
    lastStrongAlert[symbol] = last30.time;

    const supporting = hasRecentSpike(candles15m.slice(0, -1), 3);

    // MESSAGE
    if (sweepOk) {
      sendTelegramAlert(
        `🔁 *Strong Confirmed Change in Direction* on *${symbol}* (30m): *${direction.toUpperCase()}* ${
          direction === "bullish" ? "🟢" : "🔴"
        }\n` +
          `🫧 Liquidity Sweep: ${sweepOk.side} (${sweepOk.tf})\n` +
          `${supporting ? "⚡ Supporting Signal: Volume/Momentum Spike detected" : ""}`
      );
    } else {
      sendTelegramAlert(
        `🔁 *Confirmed Change in Direction* on *${symbol}* (30m): *${direction.toUpperCase()}* ${
          direction === "bullish" ? "🟢" : "🔴"
        }\n` + `${supporting ? "⚡ Supporting Signal: Volume/Momentum Spike detected" : ""}`
      );
    }
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
