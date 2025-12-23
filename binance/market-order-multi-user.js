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
const SIGNAL_EXPIRY_MS = 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 1000;
const MONITOR_INTERVAL_MS = 5000;

// --- MEMORY ---
let pendingSignals = {};
let activePositions = {};
let userClients = {};

// --- LOG ---
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

// =====================================================
// USERS
// =====================================================
function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) return [];
  const data = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  return Object.entries(data)
    .filter(([_, u]) => u.active && u.apiKey && u.apiSecret)
    .map(([id, u]) => ({ id, apiKey: u.apiKey, apiSecret: u.apiSecret }));
}

function createBinanceClients() {
  userClients = {};
  return loadUsers().map((u) => {
    const c = new Binance();
    c.options({
      APIKEY: u.apiKey,
      APISECRET: u.apiSecret,
      useServerTime: true,
    });
    userClients[u.id] = c;
    return { userId: u.id, client: c };
  });
}

// =====================================================
// EMA
// =====================================================
async function fetchCloses(symbol, limit = 200) {
  const r = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=${limit}`);
  const d = await r.json();
  return d.map((x) => +x[4]);
}

function ema(values, p) {
  const k = 2 / (p + 1);
  let e = values.slice(0, p).reduce((a, b) => a + b) / p;
  for (let i = p; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

async function getTrend(symbol) {
  const closes = await fetchCloses(symbol);
  const e = ema(closes, 10);
  const last = closes.at(-1);
  if (last > e) return "BULLISH";
  if (last < e) return "BEARISH";
  return null;
}

// =====================================================
// EXECUTION
// =====================================================
async function executeMarketOrderForAllUsers(symbol, direction) {
  const clients = createBinanceClients();
  for (const { userId, client } of clients) {
    try {
      await client.futuresLeverage(symbol, LEVERAGE);

      const bal = (await client.futuresBalance()).find((b) => b.asset === "USDT");
      if (!bal || bal.availableBalance <= 0) continue;

      const price = +(await client.futuresMarkPrice(symbol)).markPrice;
      const qty = ((bal.availableBalance * TRADE_PERCENT * LEVERAGE) / price).toFixed(3);
      const side = direction === "BULLISH" ? "BUY" : "SELL";

      await client.futuresMarketOrder(symbol, side, qty);

      activePositions[symbol] ??= {};
      activePositions[symbol][userId] = {
        side,
        entry: price,
        qty,
        high: price,
        low: price,
      };

      bot.sendMessage(GROUP_CHAT_ID, `✅ *${side} EXECUTED*\n${symbol}\nUser: ${userId}`);
    } catch (e) {
      log(`Execution failed ${userId} ${symbol}: ${e.message}`);
    }
  }
}

// =====================================================
// MONITOR TP / SL / TRAILING
// =====================================================
async function monitorPositions() {
  for (const symbol in activePositions) {
    for (const userId in activePositions[symbol]) {
      const pos = activePositions[symbol][userId];
      const client = userClients[userId];
      if (!client) continue;

      const price = +(await client.futuresMarkPrice(symbol)).markPrice;

      if (pos.side === "BUY") {
        pos.high = Math.max(pos.high, price);
        if (
          ((price - pos.entry) / pos.entry) * 100 >= TP_PCT ||
          ((pos.entry - price) / pos.entry) * 100 <= SL_PCT ||
          price <= pos.high * (1 - TRAILING_STOP_PCT / 100)
        ) {
          await client.futuresMarketSell(symbol, pos.qty);
          delete activePositions[symbol][userId];
        }
      } else {
        pos.low = Math.min(pos.low, price);
        if (
          ((pos.entry - price) / pos.entry) * 100 >= TP_PCT ||
          ((price - pos.entry) / pos.entry) * 100 <= SL_PCT ||
          price >= pos.low * (1 + TRAILING_STOP_PCT / 100)
        ) {
          await client.futuresMarketBuy(symbol, pos.qty);
          delete activePositions[symbol][userId];
        }
      }
    }
  }
}
setInterval(monitorPositions, MONITOR_INTERVAL_MS);

// =====================================================
// TELEGRAM
// =====================================================
bot.on("message", async (msg) => {
  const t = msg.text?.trim();
  if (!t) return;

  // /closeall
  if (msg.from.id == ADMIN_ID && t.startsWith("/closeall")) {
    const sym = t.split(" ")[1] || "ALL";
    const clients = createBinanceClients();

    for (const { userId, client } of clients) {
      const pos = await client.futuresPositionRisk();
      for (const p of pos) {
        if (p.positionAmt == 0) continue;
        if (sym !== "ALL" && p.symbol !== sym) continue;
        await client.futuresMarketOrder(p.symbol, p.positionAmt > 0 ? "SELL" : "BUY", Math.abs(p.positionAmt), {
          reduceOnly: true,
        });
      }
    }
    return bot.sendMessage(GROUP_CHAT_ID, "🔴 CLOSEALL DONE");
  }

  // CID
  if (!t.includes("CONFIRMED CHANGE IN DIRECTION")) return;
  const m = t.match(/ON\s+([A-Z]+USDT).*NOW\s+(BULLISH|BEARISH)/i);
  if (!m) return;

  const [_, symbol, direction] = m;
  if (pendingSignals[symbol]) return;

  pendingSignals[symbol] = Date.now() + SIGNAL_EXPIRY_MS;
  bot.sendMessage(GROUP_CHAT_ID, `📢 CID ${symbol} (${direction}) — waiting for EMA10`);

  const timer = setInterval(async () => {
    if (Date.now() > pendingSignals[symbol]) {
      clearInterval(timer);
      delete pendingSignals[symbol];
      return bot.sendMessage(GROUP_CHAT_ID, `⌛ Signal expired for ${symbol}`);
    }

    const trend = await getTrend(symbol);
    if (trend === direction) {
      clearInterval(timer);
      delete pendingSignals[symbol];
      await executeMarketOrderForAllUsers(symbol, direction);
    }
  }, CHECK_INTERVAL_MS);
});
