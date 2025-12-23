// =====================================================
// MULTI-USER MARKET ORDER BOT - ADMIN-CONTROLLED SIGNALS
// =====================================================
const config = require("../config");
const Binance = require("node-binance-api");
const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const fetch = require("node-fetch");
globalThis.fetch = fetch;
// =====================================================
// MULTI-USER MARKET ORDER BOT - BINANCE FUTURES (USDT-PERP)
// ADMIN-CONTROLLED SIGNALS
// (TP 3%, SL 1.5%, Trailing Stop 1.5%, 1H Signal Expiry)
// BOS & Break-even Removed
// =====================================================

// --- TELEGRAM ---
const TELEGRAM_BOT_TOKEN = config.TELEGRAM_BOT_TOKEN_BINANCE_MKT_ORDER_MULTI_USER;
const GROUP_CHAT_ID = "-1003419090746";
const ADMIN_ID = "7476742687";
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// --- USERS FILE ---
// NOTE: users.json expected as an object mapping: { "<chatId>": { apiKey, apiSecret, active, ... }, ... }
const USERS_FILE = "./users.json";

// --- Settings ---
const TRADE_PERCENT = 0.1;
const LEVERAGE = 20;
const TP_PCT = 2.5;
const SL_PCT = -1.5;
const TRAILING_STOP_PCT = 1.5;
const MONITOR_INTERVAL_MS = 5 * 1000;
const SIGNAL_CHECK_INTERVAL_MS = 60 * 1000;
const SIGNAL_EXPIRY_MS = 60 * 60 * 1000;

// --- MEMORY ---
let activePositions = {};
let pendingSignals = {};
let userClients = {};

// --- LOG ---
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// --- LOAD USERS ---
function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) return [];
  const data = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  return Object.entries(data)
    .filter(([_, u]) => u.active && u.apiKey && u.apiSecret)
    .map(([id, u]) => ({ id, apiKey: u.apiKey, apiSecret: u.apiSecret }));
}

// --- CREATE BINANCE CLIENTS ---
function createBinanceClients() {
  userClients = {};
  const users = loadUsers();
  return users.map((u) => {
    const client = new Binance().options({
      APIKEY: u.apiKey,
      APISECRET: u.apiSecret,
      useServerTime: true,
      recvWindow: 60000,
    });
    userClients[u.id] = client;
    return { userId: u.id, client };
  });
}

// --- TELEGRAM SEND ---
async function sendMessage(msg) {
  try {
    await bot.sendMessage(GROUP_CHAT_ID, msg, { parse_mode: "Markdown" });
  } catch {}
  try {
    await bot.sendMessage(ADMIN_ID, msg, { parse_mode: "Markdown" });
  } catch {}
}

// --- FETCH KLINES ---
async function fetchFuturesKlines(symbol, interval = "1h", limit = 200) {
  const res = await fetch(
    `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
  );
  const data = await res.json();
  return data.map((c) => ({ close: +c[4] }));
}

// --- EMA ---
function calculateEMA(values, period) {
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

async function getEMATrend(symbol, period = 10) {
  const klines = await fetchFuturesKlines(symbol);
  const closes = klines.map((k) => k.close);
  const ema = calculateEMA(closes, period);
  const last = closes[closes.length - 1];
  if (last > ema) return "bullish";
  if (last < ema) return "bearish";
  return "neutral";
}

// =====================================================
// 🚨 LIVE /CLOSEALL (ADMIN ONLY)
// =====================================================
async function closeAllLivePositions(symbolFilter = "ALL") {
  const clients = createBinanceClients();

  for (const { userId, client } of clients) {
    try {
      const positions = await client.futuresPositionRisk();

      for (const p of positions) {
        const amt = parseFloat(p.positionAmt);
        if (amt === 0) continue;
        if (symbolFilter !== "ALL" && p.symbol !== symbolFilter) continue;

        const qty = Math.abs(amt);
        const side = amt > 0 ? "SELL" : "BUY";

        try {
          await client.futuresMarketOrder(p.symbol, side, qty, {
            reduceOnly: true,
          });
        } catch (err) {
          log(`❌ Error closing position for user ${userId} ${p.symbol}: ${err.message}`);
          continue;
        }

        await sendMessage(`🔴 *LIVE CLOSE*\nUser: ${userId}\nSymbol: ${p.symbol}\nQty: ${qty}\nSide: ${side}`);
      }
    } catch (err) {
      log(`CloseAll error for ${userId}: ${err.message}`);
    }
  }
}

// =====================================================
// TELEGRAM HANDLER
// =====================================================
bot.on("message", async (msg) => {
  if (!msg.text) return;
  const text = msg.text.trim();
  const fromAdmin = String(msg.from.id) === String(ADMIN_ID);

  // --- /closeall ---
  if (fromAdmin && text.toLowerCase().startsWith("/closeall")) {
    const parts = text.split(" ");
    const symbol = parts[1] ? parts[1].toUpperCase() : "ALL";

    await sendMessage(`⚠️ *ADMIN CLOSEALL INITIATED*\nTarget: ${symbol}`);
    await closeAllLivePositions(symbol);
    return;
  }

  // --- CID SIGNAL ---
  if (!text.toUpperCase().includes("CONFIRMED CHANGE IN DIRECTION")) return;

  const match = text.match(/ON\s+([A-Z]+USDT).*NOW\s+(BULLISH|BEARISH)/i);
  if (!match) return;

  const symbol = match[1];
  const direction = match[2];

  if (pendingSignals[symbol]) return;

  pendingSignals[symbol] = Date.now() + SIGNAL_EXPIRY_MS;

  await sendMessage(`📢 CID Signal: *${symbol}* (${direction})\nWaiting for EMA10 alignment...`);

  const timer = setInterval(async () => {
    if (Date.now() > pendingSignals[symbol]) {
      delete pendingSignals[symbol];
      clearInterval(timer);
      await sendMessage(`⌛ Signal expired for ${symbol}`);
      return;
    }

    const trend = await getEMATrend(symbol, 10);
    if ((direction === "BULLISH" && trend === "bullish") || (direction === "BEARISH" && trend === "bearish")) {
      clearInterval(timer);
      delete pendingSignals[symbol];

      await sendMessage(`✅ EMA Confirmed for ${symbol}\nExecuting trades...`);

      // 🔥 THIS IS THE MISSING LINE
      await executeMarketOrderForAllUsers(symbol, direction);
    }
  }, SIGNAL_CHECK_INTERVAL_MS);
});

// --- POSITION MONITOR ---
// Keep your TP / SL / Trailing Stop monitoring as in your original code
setInterval(() => {}, MONITOR_INTERVAL_MS);
