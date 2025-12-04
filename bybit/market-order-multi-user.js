// =====================================================
// Bybit v5 multi-user market bot (Derivatives-only) with robust execution and TP/SL
// =====================================================

const config = require("../config");
const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const crypto = require("crypto");
const fetch = require("node-fetch");
globalThis.fetch = fetch;

// --- TELEGRAM ---
const TELEGRAM_BOT_TOKEN = config.TELEGRAM_BOT_TOKEN_BYBIT_MKT_ORDER_MULTI_USER;
const GROUP_CHAT_ID = "-1003489385113";
const PERSONAL_CHAT_ID = "7476742687";
const ADMIN_ID = "7476742687";
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// --- USERS FILE ---
const USERS_FILE = "./users_bybit.json";

// --- EMBEDDED TEST ACCOUNT ---
const EMBEDDED_TEST_API_KEY = "zSp8QKUJ32DhKiKBCK";
const EMBEDDED_TEST_API_SECRET = "cgjumc48T5bFwEmfz5haVC2lP7xxJaW18WIi";

// --- SETTINGS ---
const TRADE_PERCENT = 0.1; // % of derivatives USDT balance to risk
const LEVERAGE = 20;
const TP_PCT = 3.0;
const SL_PCT = 1.5;
const TRAILING_STOP_PCT = 1.5;
const SIGNAL_CHECK_INTERVAL_MS = 60 * 1000;
const MONITOR_INTERVAL_MS = 5000;
const SIGNAL_EXPIRY_MS = 60 * 60 * 1000; // 1 hour expiry

// --- IN-MEMORY ---
let activePositions = {}; // key = `${userId}:${symbol}`
let pendingSignals = {}; // { symbol: { direction, expiresAt, intervalId } }

// --- LOGGING ---
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// --- TELEGRAM sender ---
async function sendMessage(msg) {
  try {
    await bot.sendMessage(GROUP_CHAT_ID, msg, { parse_mode: "Markdown" });
  } catch (e) {
    log(`tg group send err: ${e?.message || e}`);
  }
  if (PERSONAL_CHAT_ID) {
    try {
      await bot.sendMessage(PERSONAL_CHAT_ID, msg, { parse_mode: "Markdown" });
    } catch (e) {
      log(`tg personal send err: ${e?.message || e}`);
    }
  }
}

// --- LOAD USERS ---
function loadUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) return [];
    const raw = fs.readFileSync(USERS_FILE, "utf8").trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((u) => u && u.active && u.apiKey && u.apiSecret)
        .map((u) => ({ id: String(u.id), apiKey: u.apiKey, apiSecret: u.apiSecret }));
    }
    const users = [];
    for (const [key, val] of Object.entries(parsed)) {
      if (val && val.active && val.apiKey && val.apiSecret)
        users.push({ id: String(key), apiKey: val.apiKey, apiSecret: val.apiSecret });
    }
    return users;
  } catch (e) {
    log(`loadUsers error: ${e?.message || e}`);
    return [];
  }
}

// --- CREATE CLIENT MAP ---
function createClientsMap() {
  const map = new Map();
  const users = loadUsers();
  if (users.length === 0) {
    log("No active users found in JSON — using embedded test API key for testing.");
    map.set("EMBEDDED_TEST", { apiKey: EMBEDDED_TEST_API_KEY, apiSecret: EMBEDDED_TEST_API_SECRET });
    return map;
  }
  for (const u of users) {
    map.set(u.id, { apiKey: u.apiKey, apiSecret: u.apiSecret });
  }
  return map;
}

// --- BYBIT v5 signing helper ---
function signV5(apiSecret, queryString) {
  return crypto.createHmac("sha256", apiSecret).update(queryString).digest("hex");
}

function buildV5Query(params) {
  const usp = new URLSearchParams();
  Object.keys(params)
    .sort()
    .forEach((k) => {
      if (params[k] === undefined || params[k] === null) return;
      usp.append(k, String(params[k]));
    });
  return usp.toString();
}

async function bybitV5SignedRequest(apiKey, apiSecret, method, path, params = {}) {
  const timestamp = Date.now().toString();
  const baseParams = { apiKey, timestamp, recvWindow: 5000, ...params };
  const qs = buildV5Query(baseParams);
  const signature = signV5(apiSecret, qs);
  const url = `https://api.bybit.com${path}?${qs}&sign=${signature}`;
  const res = await fetch(url, { method });
  const json = await res.json();
  return json;
}

async function bybitV5Public(path, params = {}) {
  const qs = buildV5Query(params);
  const url = `https://api.bybit.com${path}?${qs}`;
  const res = await fetch(url);
  const json = await res.json();
  return json;
}

// ===============================
// FETCH BYBIT KLINE (v5 endpoint)
// ===============================
async function fetchCandles(symbol, interval = "60", limit = 200) {
  try {
    const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=${limit}`;

    const response = await fetch(url);
    const text = await response.text();

    // Sometimes Bybit returns HTML "Not Found" → Catch BEFORE parsing
    if (!text.startsWith("{")) {
      console.log(`❌ fetchCandles v5 error for ${symbol}: Non-JSON response`);
      console.log("Returned text:", text);
      return null;
    }

    const data = JSON.parse(text);

    if (data.retCode !== 0) {
      console.log(`❌ fetchCandles v5 API error for ${symbol}:`, data);
      return null;
    }

    return data.result.list; // Array of kline candles
  } catch (err) {
    console.error(`❌ fetchCandles v5 error for ${symbol}:`, err.message);
    return null;
  }
}

// --- EMA / Volume / OBV helpers ---
function calculateEMA(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  let sma = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let ema = sma;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);}
  return ema;
}

async function getEMATrend(symbol, period = 10) {
  const klines = await fetchFuturesKlines(symbol, "1h", 200);
  if (!klines || klines.length === 0) return null;
  const closes = klines.map(k => k.close);
  const ema = calculateEMA(closes, period);
  if (ema === null) return null;
  const lastClose = closes[closes.length - 1];
  if (lastClose > ema) return "bullish";
  if (lastClose < ema) return "bearish";
  return "neutral";
}

async function checkVolume15m(symbol) {
  try {
    const candles = await fetchCandles(symbol, "15m", 50);
    if (!candles || candles.length < 22) return false;

    const last = candles[candles.length - 2];
    const prev20 = candles.slice(candles.length - 22, candles.length - 2);
    const avgVolume = prev20.reduce((sum, c) => sum + c.volume, 0) / prev20.length;

    return last.volume >= avgVolume;
  } catch (e) {
    log(`checkVolume15m error: ${e?.message || e}`);
    return false;
  }
}

async function checkOBV15m(symbol, direction) {
  try {
    const candles = await fetchCandles(symbol, "15m", 60);
    if (!candles || candles.length < 4) return false;

    const closed = candles.slice(0, -1);
    let obv = 0;
    const series = [0];

    for (let i = 1; i < closed.length; i++) {
      const diff = closed[i].close - closed[i - 1].close;
      obv += diff > 0 ? closed[i].volume : diff < 0 ? -closed[i].volume : 0;
      series.push(obv);
    }

    const last = series[series.length - 1];
    const prev = series[series.length - 2];
    return direction === "long" ? last > prev : last < prev;
  } catch (e) {
    log(`checkOBV15m error: ${e?.message || e}`);
    return false;
  }
}

// --- MARKET ORDER EXECUTION WITH TP/SL ---
async function executeMarketOrderForAllUsers(symbol, direction) {
  const clientsMap = createClientsMap();
  if (!clientsMap.size) {
    await sendMessage(`⚠️ No active users for ${symbol}`);
    return;
  }

  for (const [userId, creds] of clientsMap.entries()) {
    const { apiKey, apiSecret } = creds;
    try {
      const kl = await fetchCandles(symbol, "1m", 1);
      const markPrice = kl?.[0]?.close || 0;
      if (!markPrice) {
        await sendMessage(`⚠️ Cannot get price for ${symbol} for user ${userId}`);
        continue;
      }

      const balance = await getDerivativesUSDTBalance(apiKey, apiSecret);
      if (!balance || balance <= 0) {
        await sendMessage(`⚠️ User ${userId} has no USDT balance.`);
        continue;
      }

      const tradeValue = balance * TRADE_PERCENT;
      const qty = Number(((tradeValue * LEVERAGE) / markPrice).toFixed(3));
      if (!qty || qty <= 0) {
        await sendMessage(`⚠️ Computed qty <=0 for ${symbol} user ${userId}`);
        continue;
      }

      const side = direction.toLowerCase() === "bullish" ? "Buy" : "Sell";
      const res = await placeMarketOrderV5(apiKey, apiSecret, symbol, side, qty);
      if (!res || (res.retCode && res.retCode !== 0)) {
        await sendMessage(`❌ Order failed for ${symbol} user ${userId}: ${JSON.stringify(res)}`);
        continue;
      }

      activePositions[`${userId}:${symbol}`] = {
        userId,
        symbol,
        side: side === "Buy" ? "BUY" : "SELL",
        entryPrice: markPrice,
        qty,
        openedAt: Date.now(),
      };
      await sendMessage(`✅ ${side.toUpperCase()} EXECUTED for ${symbol} user ${userId} qty ${qty}`);

      // Place TP/SL orders
      await placeTPSL(apiKey, apiSecret, symbol, side, qty, markPrice);
    } catch (e) {
      log(`executeMarketOrder error for ${userId}: ${e?.message || e}`);
    }
  }
}

// --- PLACE TP/SL ORDERS ---
async function placeTPSL(apiKey, apiSecret, symbol, side, qty, entryPrice) {
  try {
    const tpPrice = side === "Buy" ? entryPrice * (1 + TP_PCT / 100) : entryPrice * (1 - TP_PCT / 100);
    const slPrice = side === "Buy" ? entryPrice * (1 - SL_PCT / 100) : entryPrice * (1 + SL_PCT / 100);

    // Take Profit
    await bybitV5SignedRequest(apiKey, apiSecret, "POST", "/v5/order/create", {
      symbol,
      side: side === "Buy" ? "Sell" : "Buy",
      orderType: "Limit",
      price: tpPrice.toFixed(2),
      qty,
      timeInForce: "PostOnly",
      reduceOnly: true,
    });
    // Stop Loss
    await bybitV5SignedRequest(apiKey, apiSecret, "POST", "/v5/order/create", {
      symbol,
      side: side === "Buy" ? "Sell" : "Buy",
      orderType: "Stop",
      stopPrice: slPrice.toFixed(2),
      qty,
      timeInForce: "GoodTillCancel",
      reduceOnly: true,
    });
  } catch (e) {
    log(`placeTPSL error: ${e?.message || e}`);
  }
}

// --- FETCH DERIVATIVES USDT BALANCE ---
async function getDerivativesUSDTBalance(apiKey, apiSecret) {
  try {
    const res = await bybitV5SignedRequest(apiKey, apiSecret, "GET", "/v5/account/wallet-balance", { coin: "USDT" });
    if (res?.result?.USDT?.available_balance !== undefined) return parseFloat(res.result.USDT.available_balance);
    if (res?.result?.list) {
      const item = res.result.list.find((x) => x.coin === "USDT");
      if (item) return parseFloat(item.available_balance);
    }
    return 0;
  } catch (e) {
    log(`getDerivativesUSDTBalance error: ${e?.message || e}`);
    return 0;
  }
}

// --- PLACE SINGLE MARKET ORDER ---
async function placeMarketOrderV5(apiKey, apiSecret, symbol, side, qty) {
  try {
    const params = { symbol, side, orderType: "Market", qty, timeInForce: "ImmediateOrCancel", reduceOnly: false };
    const res = await bybitV5SignedRequest(apiKey, apiSecret, "POST", "/v5/order/create", params);
    return res;
  } catch (e) {
    log(`placeMarketOrderV5 error: ${e?.message || e}`);
    return null;
  }
}

// --- SIGNAL PARSING ---
function parseSignalText(text) {
  const t = text.toUpperCase();
  if (!t.includes("CONFIRMED CHANGE IN DIRECTION")) return null;
  const rx = /ON\s+([A-Z0-9]+USDT).*NOW[:\s]+(BULLISH|BEARISH)/i;
  const m = text.match(rx);
  if (m && m[1] && m[2]) return { symbol: m[1].toUpperCase(), direction: m[2].toUpperCase() };
  const sym = text.match(/([A-Z0-9]+USDT)/i);
  const dir = text.match(/\b(BULLISH|BEARISH)\b/i);
  if (sym && dir) return { symbol: sym[1].toUpperCase(), direction: dir[1].toUpperCase() };
  return null;
}

// --- TELEGRAM SIGNAL LISTENER ---
bot.on("message", async (msg) => {
  try {
    if (!msg.text) return;
    const chatId = msg.chat.id.toString();
    if (chatId !== GROUP_CHAT_ID && chatId !== PERSONAL_CHAT_ID) return;

    const text = msg.text.trim();
    if (text.toLowerCase().startsWith("/closeall") && msg.from?.id?.toString() === ADMIN_ID) {
      const symbolArg = text.split(" ")[1]?.toUpperCase() || "ALL";
      const keys = Object.keys(activePositions);
      if (!keys.length) {
        await sendMessage("⚠️ No active positions to close.");
        return;
      }
      await sendMessage(`⚠️ Closing positions for all users (${symbolArg})...`);
      const clientsMap = createClientsMap();
      for (const k of keys) {
        const pos = activePositions[k];
        if (symbolArg !== "ALL" && pos.symbol !== symbolArg) continue;
        const creds = clientsMap.get(String(pos.userId));
        if (!creds) continue;
        await closeUserPositionMarket(
          creds.apiKey,
          creds.apiSecret,
          pos.userId,
          pos.symbol,
          pos.qty,
          pos.side === "BUY" ? "Sell" : "Buy"
        );
        delete activePositions[k];
      }
      await sendMessage("✅ Manual close-all completed.");
      return;
    }

    const parsed = parseSignalText(text);
    if (!parsed) return;

    const { symbol, direction } = parsed;
    if (pendingSignals[symbol]) return;

    pendingSignals[symbol] = { direction, expiresAt: Date.now() + SIGNAL_EXPIRY_MS };

    await sendMessage(
      `📢 CID signal received for *${symbol}* (${direction}).\n⏱️ *Expires in 1 hour*\n\nChecking EMA/BOS/Volume/OBV...`
    );

    const intervalId = setInterval(async () => {
      const sig = pendingSignals[symbol];
      if (!sig) {
        clearInterval(intervalId);
        return;
      }
      if (Date.now() > sig.expiresAt) {
        delete pendingSignals[symbol];
        clearInterval(intervalId);
        await sendMessage(`⌛ CID signal expired for *${symbol}*`);
        return;
      }

      const trend = await getEMATrend(symbol, 10);
      const emaOk =
        (direction.toLowerCase() === "bullish" && trend === "bullish") ||
        (direction.toLowerCase() === "bearish" && trend === "bearish");
      const volOk = await checkVolume15m(symbol);
      const obvOk = await checkOBV15m(symbol, direction.toLowerCase() === "bullish" ? "long" : "short");

      if (!emaOk) await sendMessage(`⏳ EMA (1H) check not passed yet for *${symbol}* (trend: ${trend})`);
      if (!volOk) await sendMessage(`⏳ Volume (15m) check not passed yet for *${symbol}*`);
      if (!obvOk) await sendMessage(`⏳ OBV (15m) check not passed yet for *${symbol}*`);

      if (emaOk && volOk && obvOk) {
        clearInterval(intervalId);
        delete pendingSignals[symbol];
        await sendMessage(`✅ All checks passed for *${symbol}*. Executing orders for all configured clients...`);
        await executeMarketOrderForAllUsers(symbol, direction);
      }
    }, SIGNAL_CHECK_INTERVAL_MS);

    pendingSignals[symbol].intervalId = intervalId;
  } catch (err) {
    log(`bot.on message error: ${err?.message || err}`);
  }
});

log("Bybit v5 multi-user market bot (Derivatives-only) started.");

// --- CLOSE USER POSITION HELPER ---
async function closeUserPositionMarket(apiKey, apiSecret, userId, symbol, qty, side) {
  try {
    const params = {
      symbol,
      side, // "Buy" or "Sell"
      orderType: "Market",
      qty,
      timeInForce: "ImmediateOrCancel",
      reduceOnly: true,
    };
    const res = await bybitV5SignedRequest(apiKey, apiSecret, "POST", "/v5/order/create", params);
    if (!res || (res.retCode && res.retCode !== 0)) {
      log(`❌ Close position failed for ${symbol} user ${userId}: ${JSON.stringify(res)}`);
      return res;
    }
    delete activePositions[`${userId}:${symbol}`];
    log(`✅ Closed position for ${symbol} user ${userId}`);
    await sendMessage(`✅ Closed position for *${symbol}* user ${userId}`);
    return res;
  } catch (e) {
    log(`closeUserPositionMarket error for ${userId} ${symbol}: ${e?.message || e}`);
    return null;
  }
}

// --- MONITOR OPEN POSITIONS (trailing stop / TP/SL) ---
async function monitorPositions() {
  setInterval(async () => {
    const clientsMap = createClientsMap();
    for (const [key, pos] of Object.entries(activePositions)) {
      const creds = clientsMap.get(String(pos.userId));
      if (!creds) continue;

      try {
        const kl = await fetchCandles(pos.symbol, "1m", 1);
        const markPrice = kl?.[0]?.close;
        if (!markPrice) continue;

        const side = pos.side === "BUY" ? "Buy" : "Sell";
        const entryPrice = pos.entryPrice;

        // Trailing Stop logic
        if (TRAILING_STOP_PCT > 0) {
          if (side === "Buy") {
            const tsPrice = markPrice * (1 - TRAILING_STOP_PCT / 100);
            if (tsPrice > entryPrice * (1 + 0.001)) {
              // minimal movement threshold
              await closeUserPositionMarket(creds.apiKey, creds.apiSecret, pos.userId, pos.symbol, pos.qty, "Sell");
            }
          } else {
            const tsPrice = markPrice * (1 + TRAILING_STOP_PCT / 100);
            if (tsPrice < entryPrice * (1 - 0.001)) {
              await closeUserPositionMarket(creds.apiKey, creds.apiSecret, pos.userId, pos.symbol, pos.qty, "Buy");
            }
          }
        }

        // Optional: TP/SL checks could also be implemented here for extra safety
      } catch (e) {
        log(`monitorPositions error for ${pos.userId} ${pos.symbol}: ${e?.message || e}`);
      }
    }
  }, MONITOR_INTERVAL_MS);
}

// Start monitoring positions in the background
monitorPositions();

log("Bybit v5 multi-user market bot (Derivatives-only) fully initialized.");
