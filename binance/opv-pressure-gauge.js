const axios = require("axios");
const technicalIndicators = require("technicalindicators");
const { EMA } = technicalIndicators;

// ===== CONFIG =====
const TELEGRAM_BOT_TOKEN = "8322504485:AAGycxBbdDIO54iQONd_SbOzfDYelUFv4Qc";
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const CHAT_ID = "7476742687"; // your personal chat ID

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
  "FTMUSDT",
  "TRXUSDT",
];

const RUN_INTERVAL_MS = 30 * 60 * 1000; // scan every 30 mins
const EMA_PERIOD = 10;
const FLAT_THRESHOLD_PCT = 0.2;

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

async function fetchCandles(symbol, interval = "2h", limit = 60) {
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

function determinePressure(obvValues) {
  if (!obvValues || obvValues.length < EMA_PERIOD + 1) return "FLAT";

  const emaArr = EMA.calculate({ period: EMA_PERIOD, values: obvValues });
  const lastEMA = emaArr[emaArr.length - 1];
  const lastOBV = obvValues[obvValues.length - 1];

  const pctDist = Math.abs((lastOBV - lastEMA) / lastEMA) * 100;

  if (pctDist < FLAT_THRESHOLD_PCT) return "FLAT";
  return lastOBV > lastEMA ? "BULLISH" : "BEARISH";
}

// ===== MAIN LOOP =====
async function scanOBV() {
  for (const symbol of SYMBOLS) {
    try {
      const candles = await fetchCandles(symbol, "2h", 60);
      const obvValues = calculateOBV(candles);
      const pressure = determinePressure(obvValues);

      const message =
        `📊 *OBV Signal Detected*\n` +
        `Pair: ${symbol}\n` +
        `${
          pressure === "BULLISH"
            ? "Buying Pressure: Increasing"
            : pressure === "BEARISH"
            ? "Selling Pressure: Increasing"
            : "Pressure: Flat"
        }\n` +
        `Direction: ${pressure}\n` +
        `Timeframe: 2h\n` +
        `(OBV ${
          pressure === "BULLISH" ? "crossed above" : pressure === "BEARISH" ? "crossed below" : "near"
        } EMA${EMA_PERIOD})`;

      await sendTelegramMessage(message);
    } catch (err) {
      console.error(`Error scanning ${symbol}:`, err?.message || err);
    }
  }
}

// Run immediately and then every 30 mins
scanOBV();
setInterval(scanOBV, RUN_INTERVAL_MS);
