// =====================================================
// MULTI-USER MARKET ORDER BOT - BINANCE FUTURES (USDT-PERP)
// ADMIN-CONTROLLED SIGNALS
// TP 2%, SL 1.5%, Trailing Stop 2%, 1H Signal Expiry
// CID signals using last candle volume imbalance only
// =====================================================

// --- Polyfill fetch ---
import fetch from "node-fetch";
globalThis.fetch = fetch;

// --- Dependencies ---
import Binance from "node-binance-api";
import TelegramBot from "node-telegram-bot-api";
import fs from "fs";

// --- TELEGRAM DETAILS ---
const TELEGRAM_BOT_TOKEN = "8247817335:AAEKf92ex9eiDZKoan1O8uzZ3ls5uEjJsQw"; // Bot token
const GROUP_CHAT_ID = "-1003419090746"; // Telegram group chat ID
const ADMIN_ID = "7476742687"; // Admin chat ID
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// --- USERS FILE ---
const USERS_FILE = "./users.json";

// --- Settings ---
const TRADE_PERCENT = 0.1; // 10% of USDT balance
const LEVERAGE = 20;
const TP_PCT = 2.0;
const SL_PCT = -1.5;
const TRAILING_STOP_PCT = 2.0;
const MONITOR_INTERVAL_MS = 5 * 1000;
const SIGNAL_CHECK_INTERVAL_MS = 60 * 1000;
const SIGNAL_EXPIRY_MS = 60 * 60 * 1000; // 1 hour

// --- In-memory ---
let activePositions = {}; // { symbol: { userId: { side, entryPrice, qty, highest, lowest, trailingStop, openedAt } } }
let pendingSignals = {}; // { symbol: { direction, expiresAt } }
let userClients = {}; // { userId: client }

// --- Logging ---
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// --- Load Users ---
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
      if (val && val.active && val.apiKey && val.apiSecret) {
        users.push({ id: String(key), apiKey: val.apiKey, apiSecret: val.apiSecret });
      }
    }
    return users;
  } catch (err) {
    log(`❌ loadUsers error: ${err?.message || err}`);
    return [];
  }
}

// --- Create Binance clients ---
function createBinanceClients() {
  const userList = loadUsers();
  userClients = {};
  for (const u of userList) {
    try {
      const client = new Binance();
      client.options({
        APIKEY: u.apiKey,
        APISECRET: u.apiSecret,
        useServerTime: true,
        recvWindow: 60000,
      });
      userClients[u.id] = client;
    } catch (err) {
      log(`❌ createBinanceClients failed for ${u.id}: ${err?.message || err}`);
    }
  }
  return Object.entries(userClients).map(([userId, client]) => ({ userId, client }));
}

// --- Telegram send helper ---
async function sendMessage(msg) {
  try {
    await bot.sendMessage(GROUP_CHAT_ID, msg, { parse_mode: "Markdown" });
  } catch {}
  try {
    await bot.sendMessage(ADMIN_ID, msg, { parse_mode: "Markdown" });
  } catch {}
}

// --- Fetch Binance Futures klines ---
async function fetchFuturesKlines(symbol, interval = "15m", limit = 3) {
  try {
    const res = await fetch(
      `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.map((c) => ({ time: c[0], open: +c[1], high: +c[2], low: +c[3], close: +c[4], volume: +c[5] }));
  } catch (err) {
    log(`❌ fetchFuturesKlines error for ${symbol}: ${err?.message || err}`);
    return null;
  }
}

// --- Volume imbalance: last closed candle ---
async function checkVolumeImbalance(symbol, direction) {
  try {
    // Fetch last 2 candles (15m)
    const candles = await fetchFuturesKlines(symbol, "15m", 2);
    if (!candles || candles.length < 2) return false;

    const lastCandle = candles[candles.length - 2]; // last closed candle
    const startTime = lastCandle.time;
    const endTime = lastCandle.time + 15 * 60 * 1000; // add 15 minutes to cover full candle

    const res = await fetch(
      `https://fapi.binance.com/fapi/v1/aggTrades?symbol=${symbol}&startTime=${startTime}&endTime=${endTime}`,
    );
    if (!res.ok) return false;
    const trades = await res.json();

    let buyVolume = 0;
    let sellVolume = 0;

    for (const t of trades) {
      // t.m === true → maker is buyer → aggressive sell
      if (t.m) sellVolume += parseFloat(t.q);
      else buyVolume += parseFloat(t.q);
    }

    const totalVolume = buyVolume + sellVolume;
    if (totalVolume === 0) return false;

    const buyAggression = buyVolume / totalVolume;
    const sellAggression = sellVolume / totalVolume;

    if (direction === "BUY") return buyAggression >= 0.6;
    if (direction === "SELL") return sellAggression >= 0.6;

    return false;
  } catch (err) {
    console.log(`❌ checkVolumeImbalance error for ${symbol}: ${err?.message || err}`);
    return false;
  }
}

// --- Floor to step size ---
function floorToStep(qty, step) {
  const s = Number(step);
  if (!s || s <= 0) return qty;
  const factor = Math.round(1 / s);
  const floored = Math.floor(qty * factor) / factor;
  const prec = (s.toString().split(".")[1] || "").length;
  return Number(floored.toFixed(prec));
}

// --- Execute market order for all users ---
async function executeMarketOrderForAllUsers(symbol, direction) {
  try {
    const clients = createBinanceClients();
    if (!clients.length) {
      await sendMessage(`⚠️ No active users found.`);
      return;
    }

    for (const { userId, client } of clients) {
      try {
        await client.futuresLeverage(symbol, LEVERAGE).catch(() => {});
        const balances = await client.futuresBalance();
        const usdtBal = balances.find((b) => b.asset === "USDT");
        const balAmount = usdtBal ? parseFloat(usdtBal.balance) : 0;
        if (!balAmount || balAmount <= 0) continue;

        let markPrice = null;
        try {
          const mp = await client.futuresMarkPrice(symbol);
          markPrice = mp.markPrice || parseFloat(mp[0]?.markPrice || 0);
        } catch {}
        if (!markPrice) {
          const k = await fetchFuturesKlines(symbol, "1m", 1);
          if (k && k.length) markPrice = k[0].close;
        }
        if (!markPrice) continue;

        const tradeValue = balAmount * TRADE_PERCENT;
        const rawQty = (tradeValue * LEVERAGE) / markPrice;

        let lotStep = 0.001;
        try {
          const info = await client.futuresExchangeInfo();
          const s = info.symbols.find((s) => s.symbol === symbol);
          if (s) lotStep = parseFloat(s.filters.find((f) => f.filterType === "LOT_SIZE")?.stepSize || lotStep);
        } catch {}

        const qty = floorToStep(rawQty, lotStep);
        if (!qty || qty <= 0) continue;

        const side = direction === "BULLISH" ? "BUY" : "SELL";
        if (side === "BUY") await client.futuresMarketBuy(symbol, qty);
        else await client.futuresMarketSell(symbol, qty);

        await sendMessage(`✅ *${side} EXECUTED* on *${symbol}* for User ${userId} (qty ${qty})`);

        if (!activePositions[symbol]) activePositions[symbol] = {};
        activePositions[symbol][userId] = {
          side,
          entryPrice: markPrice,
          qty,
          openedAt: Date.now(),
          trailingStop: null,
          highest: markPrice,
          lowest: markPrice,
        };
      } catch (err) {
        log(`❌ executeMarketOrder user ${userId} ${symbol}: ${err?.message || err}`);
      }
    }
  } catch (err) {
    log(`❌ executeMarketOrder error ${symbol}: ${err?.message || err}`);
  }
}

// --- Monitor Positions (TP / SL / Trailing Stop) ---
async function monitorPositions() {
  for (const [symbol, users] of Object.entries(activePositions)) {
    for (const [userId, pos] of Object.entries(users)) {
      const client = userClients[userId];
      if (!client) {
        delete activePositions[symbol][userId];
        continue;
      }

      try {
        const positions = await client.futuresPositionRisk();
        const p = Array.isArray(positions) ? positions.find((x) => x.symbol === symbol) : null;
        const positionAmt = p ? parseFloat(p.positionAmt || "0") : 0;
        if (!p || positionAmt === 0) {
          delete activePositions[symbol][userId];
          continue;
        }

        const mp = await client.futuresMarkPrice(symbol);
        const markPrice = mp.markPrice ? parseFloat(mp.markPrice) : parseFloat(mp[0]?.markPrice || 0);
        if (!markPrice) continue;

        // Trailing Stop
        if (pos.side === "BUY") {
          pos.highest = Math.max(pos.highest, markPrice);
          const trail = pos.highest * (1 - TRAILING_STOP_PCT / 100);
          if (!pos.trailingStop || trail > pos.trailingStop) pos.trailingStop = trail;
          if (markPrice <= pos.trailingStop) {
            const qty = Math.abs(positionAmt);
            await client.futuresMarketSell(symbol, qty);
            await sendMessage(`🔒 [User ${userId}] Trailing Stop Triggered on *${symbol}*`);
            delete activePositions[symbol][userId];
            continue;
          }
        } else {
          pos.lowest = Math.min(pos.lowest, markPrice);
          const trail = pos.lowest * (1 + TRAILING_STOP_PCT / 100);
          if (!pos.trailingStop || trail < pos.trailingStop) pos.trailingStop = trail;
          if (markPrice >= pos.trailingStop) {
            const qty = Math.abs(positionAmt);
            await client.futuresMarketBuy(symbol, qty);
            await sendMessage(`🔒 [User ${userId}] Trailing Stop Triggered on *${symbol}*`);
            delete activePositions[symbol][userId];
            continue;
          }
        }

        // TP / SL
        const move =
          pos.side === "BUY"
            ? ((markPrice - pos.entryPrice) / pos.entryPrice) * 100
            : ((pos.entryPrice - markPrice) / pos.entryPrice) * 100;
        if (move >= TP_PCT) {
          const qty = Math.abs(positionAmt);
          await sendMessage(`🎯 TAKE PROFIT HIT for User ${userId} on *${symbol}* (+${move.toFixed(2)}%)`);
          if (pos.side === "BUY") await client.futuresMarketSell(symbol, qty);
          else await client.futuresMarketBuy(symbol, qty);
          delete activePositions[symbol][userId];
          continue;
        }
        if (move <= SL_PCT) {
          const qty = Math.abs(positionAmt);
          await sendMessage(`🔻 STOP LOSS HIT for User ${userId} on *${symbol}* (${move.toFixed(2)}%)`);
          if (pos.side === "BUY") await client.futuresMarketSell(symbol, qty);
          else await client.futuresMarketBuy(symbol, qty);
          delete activePositions[symbol][userId];
          continue;
        }
      } catch (err) {
        log(`❌ monitorPositions error for ${userId} ${symbol}: ${err?.message || err}`);
      }
    }
  }
}
setInterval(monitorPositions, MONITOR_INTERVAL_MS);

// --- Telegram handler (CID + /closeall) ---
bot.on("message", async (msg) => {
  try {
    if (!msg.text) return;
    const chatId = msg.chat.id;
    const text = msg.text.trim();

    // --- ADMIN COMMAND: /closeall ---
    if (String(msg.from.id) === String(ADMIN_ID) && text.toLowerCase().startsWith("/closeall")) {
      const parts = text.split(" ");
      const symbolArg = parts[1]?.toUpperCase() || null;
      if (!symbolArg)
        return bot.sendMessage(chatId, "❌ Usage:\n/closeall BTCUSDT\n/closeall ALL", { parse_mode: "Markdown" });
      await bot.sendMessage(chatId, `📢 *Manual Close-All Triggered:* ${symbolArg}`, { parse_mode: "Markdown" });

      for (const sym of Object.keys(activePositions)) {
        for (const userId of Object.keys(activePositions[sym])) {
          if (symbolArg !== "ALL" && symbolArg !== sym) continue;
          const pos = activePositions[sym][userId];
          const client = userClients[userId];
          if (!client) continue;
          const closeSide = pos.side === "BUY" ? "SELL" : "BUY";
          try {
            if (closeSide === "BUY") await client.futuresMarketBuy(sym, pos.qty);
            else await client.futuresMarketSell(sym, pos.qty);
            delete activePositions[sym][userId];
            await sendMessage(
              `🔴 *MANUAL CLOSE:* User ${userId}\nSymbol: ${sym}\nQty: ${pos.qty}\nAction: ${closeSide}`,
            );
          } catch (err) {
            await sendMessage(`❌ Failed to close User ${userId} on ${sym}: ${err?.message || err}`);
          }
        }
      }
      return bot.sendMessage(chatId, "✅ Manual Close-All Completed.", { parse_mode: "Markdown" });
    }

    // --- CID signals ---
    if (!text.toUpperCase().includes("CONFIRMED CHANGE IN DIRECTION")) return;
    const match = text.match(/ON\s+([A-Z]+USDT).*NOW\s+(BULLISH|BEARISH)/i);
    if (!match) return;

    const symbol = match[1].toUpperCase();
    const direction = match[2].toUpperCase();

    if (pendingSignals[symbol]) return;
    pendingSignals[symbol] = { direction, expiresAt: Date.now() + SIGNAL_EXPIRY_MS };
    await sendMessage(
      `📢 CID Signal for *${symbol}* (${direction})\n⏱ Expires in ${Math.round(SIGNAL_EXPIRY_MS / 60000)} minutes\nChecking Volume Imbalance...`,
    );

    const timer = setInterval(async () => {
      const sig = pendingSignals[symbol];
      if (!sig) {
        clearInterval(timer);
        return;
      }
      if (Date.now() > sig.expiresAt) {
        clearInterval(timer);
        delete pendingSignals[symbol];
        await sendMessage(`⌛ CID signal expired for *${symbol}*`);
        return;
      }

      const volOk = await checkVolumeImbalance(symbol);
      if (!volOk) return;

      clearInterval(timer);
      delete pendingSignals[symbol];
      await sendMessage(`✅ Volume Imbalance Passed for *${symbol}* — Executing Market Orders...`);
      await executeMarketOrderForAllUsers(symbol, direction);
    }, SIGNAL_CHECK_INTERVAL_MS);
  } catch (err) {
    log(`❌ bot.on message error: ${err?.message || err}`);
  }
});
