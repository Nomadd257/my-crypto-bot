// =====================================================
//  MARKET ORDER BOT (CID + 1H EMA-10 Trend Filter) - MULTI-MONITOR
//  - Listens to Confirmed Change in Direction messages in group
//  - Executes market futures orders (10% balance, 20x leverage)
//  - Monitors multiple active positions for TP (3%) and SL (1.5%), and manual closes
//  - Provides /close SYMBOL command to manually close a position
// =====================================================
// --- Polyfill fetch for Node.js ---
const fetch = require("node-fetch");
globalThis.fetch = fetch;

// --- Dependencies ---
const Binance = require("node-binance-api");
const TelegramBot = require("node-telegram-bot-api");
const { MACD, Stochastic, ATR } = require("technicalindicators"); // ATR kept for other uses if needed
const config = require("../config");
// =====================================================
// MARKET ORDER BOT (CID + 1H EMA-10 Trend + 15m BOS + 15m Volume + OBV + TP + Trailing Stop + Dual Telegram Notifications)
// =====================================================
// =====================================================
// MARKET ORDER BOT (CID + 1H EMA-10 Trend + 15m BOS + 15m Volume + OBV + TP + Trailing Stop + Dual Telegram Notifications)
// =====================================================

// --- API KEYS (Direct) ---
const BINANCE_API_KEY = "RkTt37KfeAtlMpzJhsmK84rJPM2jLUjnzIg3F8ckdTEYNGUrJjIYBpovBAU2Uhzh";
const BINANCE_API_SECRET = "9Mekox5DKhzi4BC22635uic3BpfnhovgjzQYpmfYqNb2E4PwZe1DHvaA73zUNmks";

// --- TELEGRAM ---
const TELEGRAM_BOT_TOKEN = config.TELEGRAM_BOT_TOKEN_BINANCE_MKT_ORDER_MULTI_USER;
const GROUP_CHAT_ID = "-1003419090746"; // group
const PERSONAL_CHAT_ID = "7476742687"; // personal chat

// --- Binance Setup ---
const binance = new Binance().options({
  APIKEY: BINANCE_API_KEY,
  APISECRET: BINANCE_API_SECRET,
  useServerTime: true,
});

// --- Telegram Bot ---
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// --- Settings ---
const TRADE_PERCENT = 0.1; // 10% of USDT futures balance
const LEVERAGE = 20;
const TP_PCT = 3.0; // +3% take profit
const SL_PCT = -1.5; // -1.5% stop loss
const TRAILING_STOP_PCT = 1.5; // dynamic trailing stop distance
const MONITOR_INTERVAL_MS = 5000;
const SIGNAL_CHECK_INTERVAL_MS = 60 * 1000;
const SIGNAL_EXPIRY_MS = 20 * 60 * 1000;

// Time durations
const candle1hMs = 60 * 60 * 1000;
const candle15mMs = 15 * 60 * 1000;

// In-memory stores
let activePositions = {};
let pendingSignals = {};

// Logging helper
function log(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

// =====================================================
// Telegram helper
// =====================================================
async function sendMessage(msg) {
  await bot.sendMessage(GROUP_CHAT_ID, msg, { parse_mode: "Markdown" });
  await bot.sendMessage(PERSONAL_CHAT_ID, msg, { parse_mode: "Markdown" });
}

// =====================================================
// Fetch futures klines
// =====================================================
async function fetchFuturesKlines(symbol, interval = "1h", limit = 200) {
  try {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.map((c) => ({
      time: c[0],
      open: +c[1],
      high: +c[2],
      low: +c[3],
      close: +c[4],
      volume: +c[5],
    }));
  } catch (err) {
    log(`❌ fetch klines error for ${symbol}: ${err?.message || err}`);
    return null;
  }
}

// =====================================================
// EMA calculation
// =====================================================
function calculateEMA(values, period) {
  if (!values || values.length < period) return null;
  let sma = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let ema = sma;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

// =====================================================
// 1H EMA Trend
// =====================================================
async function getEMATrend(symbol, period = 10) {
  const klines = await fetchFuturesKlines(symbol, "1h", 200);
  if (!klines) return null;
  const closes = klines.map((k) => k.close);
  const ema = calculateEMA(closes, period);
  const lastClose = closes[closes.length - 1];
  if (ema === null) return null;
  if (lastClose > ema) return "bullish";
  if (lastClose < ema) return "bearish";
  return "neutral";
}

// =====================================================
// 15m BOS
// =====================================================
async function checkBOS_15m(symbol, direction) {
  const candles = await fetchFuturesKlines(symbol, "15m", 50);
  if (!candles || candles.length < 18) return null;
  const lastClosed = candles[candles.length - 2];
  if (Date.now() < lastClosed.time + candle15mMs) return null;
  const previous14 = candles.slice(candles.length - 16, candles.length - 2);
  const highestHigh = Math.max(...previous14.map((c) => c.high));
  const lowestLow = Math.min(...previous14.map((c) => c.low));
  if (direction === "long" && lastClosed.close > highestHigh) return "BULLISH_BOS";
  if (direction === "short" && lastClosed.close < lowestLow) return "BEARISH_BOS";
  return null;
}

// =====================================================
// Volume Confirmation (15m)
// =====================================================
async function checkVolume_15m(symbol) {
  const candles = await fetchFuturesKlines(symbol, "15m", 50);
  if (!candles || candles.length < 22) return false;
  const lastClosed = candles[candles.length - 2];
  const previous20 = candles.slice(candles.length - 22, candles.length - 2);
  const avgVol = previous20.reduce((s, c) => s + c.volume, 0) / previous20.length;
  return lastClosed.volume >= avgVol;
}

// =====================================================
// OBV Confirmation (15m)
// =====================================================
async function checkOBV_15m(symbol, direction) {
  const candles = await fetchFuturesKlines(symbol, "15m", 60);
  if (!candles || candles.length < 4) return false;
  const closed = candles.slice(0, -1);
  if (closed.length < 2) return false;
  let obv = 0;
  const obvSeries = [0];
  for (let i = 1; i < closed.length; i++) {
    const prevClose = closed[i - 1].close;
    const currClose = closed[i].close;
    const currVol = closed[i].volume;
    if (currClose > prevClose) obv += currVol;
    else if (currClose < prevClose) obv -= currVol;
    obvSeries.push(obv);
  }
  const lastOBV = obvSeries[obvSeries.length - 1];
  const prevOBV = obvSeries[obvSeries.length - 2];
  if (direction === "long") return lastOBV > prevOBV;
  if (direction === "short") return lastOBV < prevOBV;
  return false;
}

// =====================================================
// Ensure One-Way Mode
// =====================================================
async function ensureOneWayMode() {
  try {
    await binance.futuresPositionSideDual(false);
  } catch {}
}

// =====================================================
// Get USDT balance
// =====================================================
async function getUsdtBalance() {
  try {
    const balances = await binance.futuresBalance();
    const entry = balances.find((b) => b.asset === "USDT");
    return entry ? parseFloat(entry.balance) : 0;
  } catch {
    return 0;
  }
}

// =====================================================
// Get mark price
// =====================================================
async function getMarkPrice(symbol) {
  try {
    const m = await binance.futuresMarkPrice(symbol);
    return parseFloat(m.markPrice);
  } catch {
    return null;
  }
}

// =====================================================
// Execute Market Order
// =====================================================
async function executeMarketOrder(symbol, direction) {
  try {
    log(`📥 EXECUTING ${direction} on ${symbol}`);
    await ensureOneWayMode();
    await binance.futuresLeverage(symbol, LEVERAGE);
    const balance = await getUsdtBalance();
    if (balance <= 0) throw new Error("USDT balance unavailable");
    const tradeValue = balance * TRADE_PERCENT;
    const mark = await binance.futuresMarkPrice(symbol);
    const markPrice = parseFloat(mark.markPrice);
    const info = await binance.futuresExchangeInfo();
    const s = info.symbols.find((x) => x.symbol === symbol);
    const qtyPrecision = s.quantityPrecision ?? 3;
    const qty = Number(((tradeValue * LEVERAGE) / markPrice).toFixed(qtyPrecision));
    if (qty <= 0) throw new Error("Qty computed as zero");
    const side = direction === "BULLISH" ? "BUY" : "SELL";
    if (side === "BUY") await binance.futuresMarketBuy(symbol, qty);
    else await binance.futuresMarketSell(symbol, qty);
    await new Promise((r) => setTimeout(r, 1500));
    activePositions[symbol] = {
      side,
      entryPrice: markPrice,
      qty,
      tradeValue,
      leverage: LEVERAGE,
      openedAt: Date.now(),
      trailingStop: null,
      highest: markPrice,
      lowest: markPrice,
    };
    await sendMessage(
      `✅ *${side} EXECUTED* on *${symbol}*\nEntry ≈ ${markPrice}\nLeverage: ${LEVERAGE}x\nTrade Value: $${tradeValue.toFixed(
        2
      )}`
    );
    return { ok: true };
  } catch (err) {
    const msg = err?.body || err?.message || String(err);
    log(`❌ Market order error: ${msg}`);
    await sendMessage(`❌ *Order Failed* for ${symbol}: ${msg}`);
    return { ok: false, error: msg };
  }
}

// =====================================================
// Monitor positions (TP, SL + trailing stop) - CORRECTED
// =====================================================
async function monitorPositions() {
  const symbols = Object.keys(activePositions);
  if (!symbols.length) return;
  const snapshot = await binance.futuresPositionRisk();
  for (const symbol of symbols) {
    const local = activePositions[symbol];
    const p = snapshot.find((x) => x.symbol === symbol);
    if (!p || parseFloat(p.positionAmt) === 0) {
      delete activePositions[symbol];
      continue;
    }
    const markPrice = await getMarkPrice(symbol);
    if (!markPrice) continue;

    // Update trailing stop
    if (local.side === "LONG") {
      local.highest = Math.max(local.highest, markPrice);
      const trailStop = local.highest * (1 - TRAILING_STOP_PCT / 100);
      if (!local.trailingStop || trailStop > local.trailingStop) local.trailingStop = trailStop;
      if (markPrice <= local.trailingStop) {
        await sendMessage(`🔻 Trailing Stop hit on *${symbol}* @ ${markPrice}`);
        await executeMarketOrder(symbol, "BEARISH");
        delete activePositions[symbol];
        continue;
      }
    } else {
      local.lowest = Math.min(local.lowest, markPrice);
      const trailStop = local.lowest * (1 + TRAILING_STOP_PCT / 100);
      if (!local.trailingStop || trailStop < local.trailingStop) local.trailingStop = trailStop;
      if (markPrice >= local.trailingStop) {
        await sendMessage(`🔻 Trailing Stop hit on *${symbol}* @ ${markPrice}`);
        await executeMarketOrder(symbol, "BULLISH");
        delete activePositions[symbol];
        continue;
      }
    }

    // Check TP/SL correctly
    const movePct =
      local.side === "LONG"
        ? ((markPrice - local.entryPrice) / local.entryPrice) * 100
        : ((local.entryPrice - markPrice) / local.entryPrice) * 100;

    if (movePct >= TP_PCT) {
      await sendMessage(`🎯 *TAKE PROFIT HIT* on *${symbol}* (+${movePct.toFixed(2)}%)`);
      await executeMarketOrder(symbol, local.side === "LONG" ? "BEARISH" : "BULLISH");
      delete activePositions[symbol];
    } else if (movePct <= Math.abs(SL_PCT)) {
      await sendMessage(`🔻 *STOP LOSS HIT* on *${symbol}* (${movePct.toFixed(2)}%)`);
      await executeMarketOrder(symbol, local.side === "LONG" ? "BEARISH" : "BULLISH");
      delete activePositions[symbol];
    }
  }
}
setInterval(monitorPositions, MONITOR_INTERVAL_MS);

// =====================================================
// TELEGRAM LISTENER - CID Signals
// =====================================================
bot.on("message", async (msg) => {
  if (!msg.text) return;
  const text = msg.text.trim().toUpperCase();
  if (!text.includes("CONFIRMED CHANGE IN DIRECTION")) return;

  const match = text.match(/ON\s+([A-Z]+USDT).*NOW\s+(BULLISH|BEARISH)/i);
  if (!match) return;
  const symbol = match[1].toUpperCase();
  const direction = match[2].toUpperCase();

  if (pendingSignals[symbol]) {
    await sendMessage(`⚠️ Signal for ${symbol} already pending. Ignoring duplicate.`);
    return;
  }

  const expiresAt = Date.now() + SIGNAL_EXPIRY_MS;
  pendingSignals[symbol] = { direction, expiresAt };

  await sendMessage(
    `📢 *Confirmed Change in Direction (CID)* detected for *${symbol}*\nChecking EMA, BOS, Volume, OBV — Valid for 20 minutes.`
  );

  const timerId = setInterval(async () => {
    const sig = pendingSignals[symbol];
    if (!sig) {
      clearInterval(timerId);
      return;
    }
    if (Date.now() > sig.expiresAt) {
      await sendMessage(`⌛ CID signal expired for *${symbol}* (20 mins elapsed)`);
      delete pendingSignals[symbol];
      clearInterval(timerId);
      return;
    }

    // Perform all checks
    const checkResults = { EMA: false, BOS: false, Volume: false, OBV: false };
    const trend = await getEMATrend(symbol, 10);
    if (trend && ((direction === "BULLISH" && trend === "bullish") || (direction === "BEARISH" && trend === "bearish")))
      checkResults.EMA = true;
    const bos = await checkBOS_15m(symbol, direction === "BULLISH" ? "long" : "short");
    if (bos) checkResults.BOS = true;
    const vol = await checkVolume_15m(symbol);
    if (vol) checkResults.Volume = true;
    const obvOk = await checkOBV_15m(symbol, direction === "BULLISH" ? "long" : "short");
    if (obvOk) checkResults.OBV = true;

    // Notify if some checks failed
    for (const [check, passed] of Object.entries(checkResults)) {
      if (!passed) {
        await sendMessage(`⏳ ${check} check not passed yet for *${symbol}*.`);
      }
    }

    if (Object.values(checkResults).every((v) => v)) {
      clearInterval(timerId);
      delete pendingSignals[symbol];
      if (activePositions[symbol]) return;
      await sendMessage(`✅ All checks passed for *${symbol}*. Executing ${direction} market order...`);
      await executeMarketOrder(symbol, direction);
    }
  }, SIGNAL_CHECK_INTERVAL_MS);
});
