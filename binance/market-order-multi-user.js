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
const SL_PCT = 1.5;
const TRAILING_STOP_PCT = 1.5;

const SIGNAL_EXPIRY_MS = 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 1000;
const MONITOR_INTERVAL_MS = 5000;

let pendingSignals = {};
let activePositions = {};
let userClients = {};

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

// ================= USERS =================
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

// ================= EMA =================
async function fetchCloses(symbol) {
  try {
    const r = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=200`);
    const d = await r.json();
    return d.map((x) => +x[4]);
  } catch {
    return null;
  }
}

function ema(values, p) {
  if (!values || values.length < p) return null;
  const k = 2 / (p + 1);
  let e = values.slice(0, p).reduce((a, b) => a + b) / p;
  for (let i = p; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

async function getTrend(symbol) {
  const closes = await fetchCloses(symbol);
  if (!closes) return null;
  const e = ema(closes, 10);
  const last = closes.at(-1);
  if (last > e) return "BULLISH";
  if (last < e) return "BEARISH";
  return null;
}

// ================= EXECUTION =================
async function getMarkPrice(client, symbol) {
  const mp = await client.futuresMarkPrice(symbol);
  return Number(mp.markPrice || mp.price || mp[0]?.markPrice);
}

async function executeMarketOrderForAllUsers(symbol, direction) {
  const clients = createBinanceClients();
  for (const { userId, client } of clients) {
    try {
      await client.futuresLeverage(symbol, LEVERAGE);

      const bal = (await client.futuresBalance()).find((b) => b.asset === "USDT");
      if (!bal || bal.availableBalance <= 0) continue;

      const price = await getMarkPrice(client, symbol);
      if (!price) continue;

      const rawQty = (bal.availableBalance * TRADE_PERCENT * LEVERAGE) / price;
      const qty = Number(rawQty.toFixed(2)); // safe default

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

      await bot.sendMessage(GROUP_CHAT_ID, `✅ *${side} EXECUTED*\n${symbol}\nUser: ${userId}`, {
        parse_mode: "Markdown",
      });
    } catch (e) {
      log(`EXEC FAIL ${userId} ${symbol}: ${e.message}`);
    }
  }
}

// ================= MONITOR =================
async function monitorPositions() {
  for (const symbol in activePositions) {
    for (const userId in activePositions[symbol]) {
      const pos = activePositions[symbol][userId];
      const client = userClients[userId];
      if (!client) continue;

      const price = await getMarkPrice(client, symbol);
      if (!price) continue;

      const movePct =
        pos.side === "BUY" ? ((price - pos.entry) / pos.entry) * 100 : ((pos.entry - price) / pos.entry) * 100;

      if (movePct >= TP_PCT || movePct <= -SL_PCT) {
        await client.futuresMarketOrder(symbol, pos.side === "BUY" ? "SELL" : "BUY", pos.qty, { reduceOnly: true });
        delete activePositions[symbol][userId];
      }
    }
  }
}

setInterval(monitorPositions, MONITOR_INTERVAL_MS);

// ================= TELEGRAM =================
bot.on("message", async (msg) => {
  const t = msg.text?.trim();
  if (!t) return;

  if (msg.from.id == ADMIN_ID && t.startsWith("/closeall")) {
    const sym = t.split(" ")[1] || "ALL";
    const clients = createBinanceClients();

    for (const { client } of clients) {
      const pos = await client.futuresPositionRisk();
      for (const p of pos) {
        if (p.positionAmt == 0) continue;
        if (sym !== "ALL" && p.symbol !== sym) continue;
        await client.futuresMarketOrder(p.symbol, p.positionAmt > 0 ? "SELL" : "BUY", Math.abs(p.positionAmt), {
          reduceOnly: true,
        });
      }
    }
    activePositions = {};
    return bot.sendMessage(GROUP_CHAT_ID, "🔴 CLOSEALL DONE");
  }

  if (!t.includes("CONFIRMED CHANGE IN DIRECTION")) return;
  const m = t.match(/ON\s+([A-Z]+USDT).*NOW\s+(BULLISH|BEARISH)/i);
  if (!m) return;

  const [_, symbol, direction] = m;
  if (pendingSignals[symbol]) return;

  pendingSignals[symbol] = Date.now() + SIGNAL_EXPIRY_MS;
  bot.sendMessage(GROUP_CHAT_ID, `📢 CID ${symbol} (${direction})`);

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

log("🤖 BOT STARTED — LISTENING FOR SIGNALS");
