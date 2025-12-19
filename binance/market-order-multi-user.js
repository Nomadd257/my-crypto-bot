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
const TRADE_PERCENT = 0.1; // 10% of USDT balance
const LEVERAGE = 20;
const TP_PCT = 2.5;
const SL_PCT = -1.5;
const TRAILING_STOP_PCT = 1.5;
const MONITOR_INTERVAL_MS = 5 * 1000;
const SIGNAL_CHECK_INTERVAL_MS = 60 * 1000;
const SIGNAL_EXPIRY_MS = 60 * 60 * 1000; // 1 hour as requested

// --- In-memory ---
let activePositions = {}; // { symbol: { userId: { side, entryPrice, qty, highest, lowest, trailingStop, openedAt } } }
let pendingSignals = {}; // { symbol: { direction, expiresAt } }
let userClients = {}; // { userId: client }

// --- Logging ---
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// --- Utility: load users (object -> array of user entries) ---
function loadUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) return [];
    const raw = fs.readFileSync(USERS_FILE, "utf8").trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);

    // If file contains an array, keep backward compatibility
    if (Array.isArray(parsed)) {
      return parsed
        .filter((u) => u && u.active && u.apiKey && u.apiSecret)
        .map((u) => ({ id: String(u.id), apiKey: u.apiKey, apiSecret: u.apiSecret }));
    }

    // If an object map: keys are chat ids
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

// --- Create Binance clients for all active users ---
function createBinanceClients() {
  const userList = loadUsers();
  const clients = [];
  userClients = {};
  for (const u of userList) {
    try {
      // NOTE: create instance first, then call .options() on it.
      // Some versions of the library may return boolean from .options() if misused.
      // Creating instance separately avoids assigning a boolean to `client`.
      const clientInstance = new Binance();
      clientInstance.options({
        APIKEY: u.apiKey,
        APISECRET: u.apiSecret,
        useServerTime: true,
        recvWindow: 60000,
      });
      clients.push({ userId: u.id, client: clientInstance });
      userClients[u.id] = clientInstance;
    } catch (err) {
      log(`❌ createBinanceClients failed for ${u.id}: ${err?.message || err}`);
    }
  }
  return clients;
}

// --- Telegram send helper ---
async function sendMessage(msg) {
  try {
    await bot.sendMessage(GROUP_CHAT_ID, msg, { parse_mode: "Markdown" });
  } catch (e) {
    log(`tg group send error: ${e?.message || e}`);
  }
  try {
    await bot.sendMessage(ADMIN_ID, msg, { parse_mode: "Markdown" });
  } catch (e) {
    log(`tg admin send error: ${e?.message || e}`);
  }
}

// --- Fetch Binance Futures klines via public REST (used for EMA, volume, OBV checks) ---
async function fetchFuturesKlines(symbol, interval = "1h", limit = 200) {
  try {
    const res = await fetch(
      `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.map((c) => ({ time: c[0], open: +c[1], high: +c[2], low: +c[3], close: +c[4], volume: +c[5] }));
  } catch (err) {
    log(`❌ fetchFuturesKlines error for ${symbol}: ${err?.message || err}`);
    return null;
  }
}

// --- EMA calculation ---
function calculateEMA(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  let sma = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let ema = sma;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

async function getEMATrend(symbol, period = 10) {
  const klines = await fetchFuturesKlines(symbol, "1h", 200);
  if (!klines || klines.length === 0) return null;
  const closes = klines.map((k) => k.close);
  const ema = calculateEMA(closes, period);
  if (ema === null) return null;
  const lastClose = closes[closes.length - 1];
  if (lastClose > ema) return "bullish";
  if (lastClose < ema) return "bearish";
  return "neutral";
}

// --- Volume check (15m) ---
async function checkVolume_15m(symbol) {
  const candles = await fetchFuturesKlines(symbol, "15m", 50);
  if (!candles || candles.length < 22) return false;
  const lastClosed = candles[candles.length - 2];
  const previous20 = candles.slice(candles.length - 22, candles.length - 2);
  const avgVol = previous20.reduce((s, c) => s + c.volume, 0) / previous20.length;
  return lastClosed.volume >= avgVol;
}

// --- OBV 15m check ---
async function checkOBV_15m(symbol, direction) {
  const candles = await fetchFuturesKlines(symbol, "15m", 60);
  if (!candles || candles.length < 4) return false;
  const closed = candles.slice(0, -1);
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

// --- Helper: floor quantity to step size safely ---
function floorToStep(qty, step) {
  // step like "0.001" or 0.001
  const s = Number(step);
  if (!s || isNaN(s) || s <= 0) return qty;
  const factor = Math.round(1 / s);
  // avoid floating point issues:
  const floored = Math.floor(qty * factor) / factor;
  // round to max precision of step
  const prec = (s.toString().split(".")[1] || "").length;
  return Number(floored.toFixed(prec));
}

// --- Execute Market Order for All Users ---
async function executeMarketOrderForAllUsers(symbol, direction) {
  try {
    // Global EMA check (public data)
    const requiredTrend = direction === "BULLISH" ? "bullish" : "bearish";
    const trend = await getEMATrend(symbol, 10);
    if (!trend) {
      await sendMessage(`⚠️ EMA trend unavailable for ${symbol}. Aborting.`);
      return;
    }
    if (trend !== requiredTrend) {
      await sendMessage(`⚠️ EMA trend mismatch for ${symbol} (signal=${direction}, trend=${trend}). Skipping.`);
      return;
    }

    const clients = createBinanceClients();
    if (!clients.length) {
      await sendMessage(`⚠️ No active users found. Skipping execution.`);
      return;
    }

    for (const { userId, client } of clients) {
      try {
        // per-user extra verification: ensure user's keys valid by calling account endpoint
        // set position side mode off (one-way) and set leverage
        try {
          await client.futuresPositionSideDual(false);
        } catch (e) {
          /* non-fatal */
        }
        try {
          await client.futuresLeverage(symbol, LEVERAGE);
        } catch (e) {
          log(`warn: set leverage failed for ${userId} ${symbol}: ${e?.message || e}`);
        }

        // fetch user USDT balance
        const balances = await client.futuresBalance();
        const usdtBal = Array.isArray(balances) ? balances.find((b) => b.asset === "USDT") : null;
        const balAmount = usdtBal ? parseFloat(usdtBal.balance || usdtBal.availableBalance || usdtBal.balance) : 0;
        if (!balAmount || balAmount <= 0) {
          log(`Skipping user ${userId}: USDT balance unavailable/zero.`);
          continue;
        }

        // per-user EMA safety check (public data is OK but double-check is allowed)
        const userTrend = await getEMATrend(symbol, 10);
        if (!userTrend || userTrend !== requiredTrend) {
          await sendMessage(`⚠️ Skipping user ${userId} for ${symbol} — EMA trend check failed (trend=${userTrend}).`);
          continue;
        }

        // mark price
        let markPrice = null;
        try {
          const mp = await client.futuresMarkPrice(symbol);
          // API may return object or array - handle common shapes
          if (mp && typeof mp === "object") {
            if (mp.markPrice) markPrice = parseFloat(mp.markPrice);
            else if (mp.price) markPrice = parseFloat(mp.price);
            else if (mp[0] && mp[0].markPrice) markPrice = parseFloat(mp[0].markPrice);
          }
        } catch (e) {
          /* fallback */
        }
        if (!markPrice) {
          const k = await fetchFuturesKlines(symbol, "1m", 1);
          if (k && k.length) markPrice = k[k.length - 1].close;
        }
        if (!markPrice) {
          await sendMessage(`⚠️ Could not get market price for ${symbol} for user ${userId}. Skipping.`);
          continue;
        }

        // calculate quantity using user's balance
        const tradeValue = balAmount * TRADE_PERCENT;
        const rawQty = (tradeValue * LEVERAGE) / markPrice;

        // get exchange info for lot step
        let lotStep = 0.001;
        try {
          const info = await client.futuresExchangeInfo();
          if (info && info.symbols) {
            const sym = info.symbols.find((s) => s.symbol === symbol);
            if (sym && Array.isArray(sym.filters)) {
              const lot = sym.filters.find((f) => f.filterType === "LOT_SIZE");
              if (lot && lot.stepSize) lotStep = parseFloat(lot.stepSize);
            }
          }
        } catch (e) {
          log(`warn: futuresExchangeInfo failed for ${userId} ${symbol}: ${e?.message || e}`);
        }

        let qty = floorToStep(rawQty, lotStep);
        // ensure minimal rounding to 1e-8 if step not found
        if (!qty || qty <= 0) {
          log(`Computed qty <=0 for user ${userId} symbol ${symbol}`);
          continue;
        }

        // place market order (BUY/SELL)
        const side = direction === "BULLISH" ? "BUY" : "SELL";
        try {
          if (side === "BUY") {
            await client.futuresMarketBuy(symbol, qty);
          } else {
            await client.futuresMarketSell(symbol, qty);
          }
        } catch (e) {
          // try alternate method names / fallback
          try {
            // some versions use client.futuresMarketOrder
            if (side === "BUY") await client.futuresMarketOrder(symbol, "BUY", qty);
            else await client.futuresMarketOrder(symbol, "SELL", qty);
          } catch (e2) {
            log(`❌ Order placement failed for user ${userId} on ${symbol}: ${e?.message || e2?.message || e2}`);
            await sendMessage(`❌ Unable to place order for user ${userId} on ${symbol}.`);
            continue;
          }
        }

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
        log(`❌ executeMarketOrderForAllUsers inner error user ${userId}: ${err?.message || err}`);
        await sendMessage(`❌ Trade failed for user ${userId} on ${symbol}: ${err?.message || err}`);
      }
    }
  } catch (err) {
    log(`❌ executeMarketOrderForAllUsers error for ${symbol}: ${err?.message || err}`);
    await sendMessage(`❌ Execution error for ${symbol}: ${err?.message || err}`);
  }
}

// --- Monitor positions & trailing stops ---
async function monitorPositions() {
  const clients = createBinanceClients();
  for (const symbol of Object.keys(activePositions)) {
    for (const userId of Object.keys(activePositions[symbol])) {
      const pos = activePositions[symbol][userId];
      const client = userClients[userId]; // using map
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

        // get mark price
        let markPrice = null;
        try {
          const mp = await client.futuresMarkPrice(symbol);
          if (mp && mp.markPrice) markPrice = parseFloat(mp.markPrice);
          else if (mp && mp[0] && mp[0].markPrice) markPrice = parseFloat(mp[0].markPrice);
        } catch (e) {
          /* fallback */
        }
        if (!markPrice) {
          const k = await fetchFuturesKlines(symbol, "1m", 1);
          if (k && k.length) markPrice = k[0].close;
        }
        if (!markPrice) continue;

        // trailing stop logic
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

        // TP / SL checks
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
        log(`monitorPositions error for ${userId} ${symbol}: ${err?.message || err}`);
      }
    }
  }
}
setInterval(monitorPositions, MONITOR_INTERVAL_MS);

// =======================================
// TELEGRAM MESSAGE HANDLER (CID + /closeall)
// =======================================
bot.on("message", async (msg) => {
  try {
    if (!msg.text) return;
    const chatId = msg.chat.id;
    const text = msg.text.trim();

    log(`Received message from ${msg.from.username || msg.from.id}: ${text}`);

    // --- ADMIN COMMAND: /closeall ---
    if (String(msg.from.id) === String(ADMIN_ID) && text.toLowerCase().startsWith("/closeall")) {
      const parts = text.split(" ");
      const symbolArg = parts[1] ? parts[1].toUpperCase() : null;
      if (!symbolArg) {
        return bot.sendMessage(chatId, "❌ Usage:\n/closeall BTCUSDT\n/closeall ALL", { parse_mode: "Markdown" });
      }
      bot.sendMessage(chatId, `📢 *Manual Close-All Triggered:* ${symbolArg}`, { parse_mode: "Markdown" });

      const clients = createBinanceClients();

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
              `🔴 *MANUAL CLOSE:* User ${userId}\nSymbol: ${sym}\nQty: ${pos.qty}\nAction: ${closeSide}`
            );
          } catch (err) {
            await sendMessage(`❌ Failed to close User ${userId} on ${sym}: ${err?.message || err}`);
          }
        }
      }
      return bot.sendMessage(chatId, "✅ Manual Close-All Completed.", { parse_mode: "Markdown" });
    }

    // --- CID Signals ---
    if (!text.toUpperCase().includes("CONFIRMED CHANGE IN DIRECTION")) return;

    const match = text.match(/ON\s+([A-Z]+USDT).*NOW\s+(BULLISH|BEARISH)/i);
    if (!match) return;

    const symbol = match[1].toUpperCase();
    const direction = match[2].toUpperCase();

    if (pendingSignals[symbol]) return;

    pendingSignals[symbol] = { direction, expiresAt: Date.now() + SIGNAL_EXPIRY_MS };
    await sendMessage(
      `📢 CID Signal for *${symbol}* (${direction})\n⏱ Expires in ${Math.round(
        SIGNAL_EXPIRY_MS / 60000
      )} minutes\nChecking EMA + Volume + OBV...`
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

      const trend = await getEMATrend(symbol, 10);
      const trendOk =
        trend && ((direction === "BULLISH" && trend === "bullish") || (direction === "BEARISH" && trend === "bearish"));
      const vol = await checkVolume_15m(symbol);
      const obvOk = await checkOBV_15m(symbol, direction === "BULLISH" ? "long" : "short");

      if (!trendOk) await sendMessage(`⏳ EMA (1H) trend not passed for *${symbol}* (trend: ${trend})`);
      if (!vol) await sendMessage(`⏳ Volume (15m) not passed for *${symbol}*`);
      if (!obvOk) await sendMessage(`⏳ OBV (15m) not passed for *${symbol}*`);

      if (trendOk && vol && obvOk) {
        clearInterval(timer);
        delete pendingSignals[symbol];
        await sendMessage(`✅ All Checks Passed for *${symbol}* — Executing Market Orders...`);
        await executeMarketOrderForAllUsers(symbol, direction);
      }
    }, SIGNAL_CHECK_INTERVAL_MS);
  } catch (err) {
    log(`❌ bot.on message error: ${err?.message || err}`);
  }
});
