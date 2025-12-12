const axios = require("axios");
const technicalIndicators = require("technicalindicators");
const EMA = technicalIndicators.EMA;

// ===== CONFIG =====
const TELEGRAM_BOT_TOKEN = "8322504485:AAGycxBbdDIO54iQONd_SbOzfDYelUFv4Qc";
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const TELEGRAM_CHAT_ID = "7476742687"; // your personal chat ID

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

const INTERVAL = "30m";
const RUN_INTERVAL_MS = 30 * 60 * 1000; // 30 mins
const EMA_PERIOD = 10;
const FLAT_THRESHOLD_PCT = 0.1; // OBV too close to EMA: flat

// ===== HELPERS =====
async function sendTelegramAlert(message) {
  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: "Markdown",
    });
  } catch (err) {
    console.error(`sendMessage failed:`, err.response ? err.response.data : err.message);
  }
}

async function fetchCandles(symbol, interval, limit = 100) {
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
  let obv = 0;
  const obvArr = [];
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].close > candles[i - 1].close) obv += candles[i].volume;
    else if (candles[i].close < candles[i - 1].close) obv -= candles[i].volume;
    obvArr.push(obv);
  }
  return obvArr;
}

function calculateEMA(values, period) {
  const arr = EMA.calculate({ period, values });
  return arr.length ? arr[arr.length - 1] : values[values.length - 1];
}

// ===== MAIN LOOP =====
async function runOBVScanner() {
  for (let i = 0; i < SYMBOLS.length; i++) {
    const symbol = SYMBOLS[i];
    try {
      const candles = await fetchCandles(symbol, INTERVAL, 100);
      if (!candles || candles.length < EMA_PERIOD + 2) continue;

      const closes = candles.map((c) => c.close);
      const obvArr = calculateOBV(candles);
      const obvLast = obvArr[obvArr.length - 1];
      const obvEMA = calculateEMA(obvArr, EMA_PERIOD);

      const diffPct = (Math.abs(obvLast - obvEMA) / obvEMA) * 100;
      let pressure = "Flat";
      let direction = "NEUTRAL";

      if (diffPct <= FLAT_THRESHOLD_PCT) {
        pressure = "Flat";
        direction = "NEUTRAL";
      } else if (obvLast > obvEMA) {
        pressure = "Increasing";
        direction = "BULLISH";
      } else if (obvLast < obvEMA) {
        pressure = "Decreasing";
        direction = "BEARISH";
      }

      if (direction !== "NEUTRAL") {
        const message =
          "📊 OBV Signal Detected\n" +
          `Pair: ${symbol}\n` +
          `${direction === "BULLISH" ? "Buying" : "Selling"} Pressure: ${pressure}\n` +
          `Direction: ${direction}\n` +
          `Timeframe: ${INTERVAL}\n` +
          `(OBV crossed ${direction === "BULLISH" ? "above" : "below"} EMA${EMA_PERIOD})`;
        await sendTelegramAlert(message);
      }
    } catch (err) {
      console.error(`Error scanning ${symbol}:`, err.response ? err.response.data : err.message);
    }
  }
}

setInterval(runOBVScanner, RUN_INTERVAL_MS);
runOBVScanner();
