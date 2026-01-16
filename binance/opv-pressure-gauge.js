const axios = require("axios");
const technicalIndicators = require("technicalindicators");
const { EMA } = technicalIndicators;

// ===== CONFIG =====
const TELEGRAM_BOT_TOKEN = "8322504485:AAGycxBbdDIO54iQONd_SbOzfDYelUFv4Qc";
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const CHAT_ID = "7476742687";

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
  "DOGEUSDT",
  "LINKUSDT",
  "MATICUSDT",
  "ATOMUSDT",
  "FILUSDT",
  "XMRUSDT",
  "NEARUSDT",
  "ALGOUSDT",
  "VETUSDT",
  "SANDUSDT",
  "AVAXUSDT",
  "XLMUSDT",
  "TRXUSDT",
];

const RUN_INTERVAL_MS = 60 * 60 * 1000; // every 1 hour
const EMA_PERIOD = 10;
const FLAT_THRESHOLD_PCT = 0.2;

// ===== STATE =====
const lastSignal = {};

// ===== HELPERS =====
async function sendTelegramMessage(text) {
  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: CHAT_ID,
      text,
      parse_mode: "Markdown",
    });
  } catch (err) {
    console.error("Telegram send error:", err?.response?.data || err.message);
  }
}

async function fetchCandles(symbol, interval = "1h", limit = 60) {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await axios.get(url, { timeout: 15000 });

  return res.data.map((c) => ({
    time: c[0],
    close: +c[4],
    volume: +c[5],
  }));
}

// ===== OBV =====
function calculateOBV(candles) {
  if (!candles || candles.length < 2) return null;

  const obv = [0];
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].close > candles[i - 1].close) {
      obv.push(obv[i - 1] + candles[i].volume);
    } else if (candles[i].close < candles[i - 1].close) {
      obv.push(obv[i - 1] - candles[i].volume);
    } else {
      obv.push(obv[i - 1]);
    }
  }
  return obv;
}

// ===== CROSS DETECTION =====
function detectOBVCross(obvValues) {
  if (!obvValues || obvValues.length < EMA_PERIOD + 2) return null;

  const emaArr = EMA.calculate({ period: EMA_PERIOD, values: obvValues });

  const prevOBV = obvValues[obvValues.length - 2];
  const lastOBV = obvValues[obvValues.length - 1];

  const prevEMA = emaArr[emaArr.length - 2];
  const lastEMA = emaArr[emaArr.length - 1];

  const pctDist = Math.abs((lastOBV - lastEMA) / lastEMA) * 100;

  if (pctDist < FLAT_THRESHOLD_PCT) {
    return { type: "FLAT" };
  }

  if (prevOBV <= prevEMA && lastOBV > lastEMA) {
    return { type: "BULLISH" };
  }

  if (prevOBV >= prevEMA && lastOBV < lastEMA) {
    return { type: "BEARISH" };
  }

  return null;
}

// ===== MAIN LOOP =====
async function scanOBV() {
  for (const symbol of SYMBOLS) {
    try {
      const candles = await fetchCandles(symbol, "1h", 60);
      const obvValues = calculateOBV(candles);
      const signal = detectOBVCross(obvValues);

      if (!signal) continue;

      if (lastSignal[symbol] === signal.type) continue;
      lastSignal[symbol] = signal.type;

      let message = `📊 *OBV Signal Detected*\nPair: ${symbol}\n`;

      if (signal.type === "BULLISH") {
        message += `Buying Pressure: Increasing\nDirection: BULLISH\nTimeframe: 1h\n(OBV crossed above EMA${EMA_PERIOD})`;
      } else if (signal.type === "BEARISH") {
        message += `Selling Pressure: Increasing\nDirection: BEARISH\nTimeframe: 1h\n(OBV crossed below EMA${EMA_PERIOD})`;
      } else {
        message += `Pressure: Flat\nDirection: FLAT\nTimeframe: 1h\n(OBV near EMA${EMA_PERIOD})`;
      }

      await sendTelegramMessage(message);
    } catch (err) {
      console.error(`Error scanning ${symbol}:`, err?.message || err);
    }
  }
}

// ===== START =====
scanOBV();
setInterval(scanOBV, RUN_INTERVAL_MS);
