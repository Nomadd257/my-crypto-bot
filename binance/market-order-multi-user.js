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
const TP_PCT = 2;
const SL_PCT = -1.5;
const TRAILING_STOP_PCT = 2;
const MONITOR_INTERVAL_MS = 5 * 1000;
const SIGNAL_CHECK_INTERVAL_MS = 60 * 1000;
const SIGNAL_EXPIRY_MS = 60 * 60 * 1000; // 1 hour
const RETEST_ZONE_PCT = 0.2; // 0.2% retest zone

// --- In-memory ---
let activePositions = {};
let pendingSignals = {};
let userClients = {};
let pdhPdlMonitors = {};
let pdhPdlState = {}; // Track brokePDH / brokePDL for retests

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
  const clients = [];
  userClients = {};
  for (const u of userList) {
    try {
      const clientInstance = new Binance();
      clientInstance.options({ APIKEY: u.apiKey, APISECRET: u.apiSecret, useServerTime: true, recvWindow: 60000 });
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

// --- Fetch klines ---
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

// --- Volume Check 15m ---
async function volumeCheck15m(symbol) {
  const klines = await fetchFuturesKlines(symbol, "15m", 11);
  if (!klines || klines.length < 11) return false;
  const volumes = klines.map((k) => k.volume);
  const lastVolume = volumes.pop();
  const avgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length;
  return lastVolume > avgVolume;
}

// --- EMA3 15m ---
async function ema3_15m(symbol) {
  const klines = await fetchFuturesKlines(symbol, "15m", 3);
  if (!klines || klines.length < 3) return null;
  const sumClose = klines.reduce((acc, k) => acc + k.close, 0);
  return sumClose / 3;
}

// --- Floor quantity ---
function floorToStep(qty, step) {
  const s = Number(step);
  if (!s || isNaN(s) || s <= 0) return qty;
  const factor = Math.round(1 / s);
  const floored = Math.floor(qty * factor) / factor;
  const prec = (s.toString().split(".")[1] || "").length;
  return Number(floored.toFixed(prec));
}

// --- Execute Market Order ---
async function executeMarketOrderForAllUsers(symbol, direction) {
  try {
    const clients = createBinanceClients();
    if (!clients.length) {
      await sendMessage(`⚠️ No active users found. Skipping execution.`);
      return;
    }
    for (const { userId, client } of clients) {
      try {
        try {
          await client.futuresPositionSideDual(false);
        } catch (e) {}
        try {
          await client.futuresLeverage(symbol, LEVERAGE);
        } catch (e) {
          log(`warn: set leverage failed ${userId} ${symbol}`);
        }
        const balances = await client.futuresBalance();
        const usdtBal = Array.isArray(balances) ? balances.find((b) => b.asset === "USDT") : null;
        const balAmount = usdtBal ? parseFloat(usdtBal.balance || usdtBal.availableBalance || usdtBal.balance) : 0;
        if (!balAmount || balAmount <= 0) {
          log(`Skipping ${userId}: USDT balance zero`);
          continue;
        }

        let markPrice = null;
        try {
          const mp = await client.futuresMarkPrice(symbol);
          if (mp && mp.markPrice) markPrice = parseFloat(mp.markPrice);
        } catch (e) {}
        if (!markPrice) {
          const k = await fetchFuturesKlines(symbol, "1m", 1);
          if (k && k.length) markPrice = k[0].close;
        }
        if (!markPrice) {
          await sendMessage(`⚠️ Could not get market price for ${symbol} for ${userId}. Skipping.`);
          continue;
        }

        const tradeValue = balAmount * TRADE_PERCENT;
        const rawQty = (tradeValue * LEVERAGE) / markPrice;

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
          log(`warn: futuresExchangeInfo failed ${userId} ${symbol}`);
        }
        let qty = floorToStep(rawQty, lotStep);
        if (!qty || qty <= 0) {
          log(`Computed qty <=0 for ${userId} ${symbol}`);
          continue;
        }

        const side = direction === "BULLISH" || direction === "BUY" ? "BUY" : "SELL";
        try {
          if (side === "BUY") await client.futuresMarketBuy(symbol, qty);
          else await client.futuresMarketSell(symbol, qty);
        } catch (e) {
          try {
            if (side === "BUY") await client.futuresMarketOrder(symbol, "BUY", qty);
            else await client.futuresMarketOrder(symbol, "SELL", qty);
          } catch (e2) {
            log(`❌ Order failed ${userId} ${symbol}`);
            await sendMessage(`❌ Unable to place order for ${userId} on ${symbol}`);
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
        log(`❌ executeMarketOrderForAllUsers inner error ${userId}: ${err?.message || err}`);
      }
    }
  } catch (err) {
    log(`❌ executeMarketOrderForAllUsers error ${symbol}: ${err?.message || err}`);
    await sendMessage(`❌ Execution error for ${symbol}`);
  }
}

// --- Monitor Positions & Trailing Stop ---
async function monitorPositions() {
  const clients = createBinanceClients();
  for (const symbol of Object.keys(activePositions)) {
    for (const userId of Object.keys(activePositions[symbol])) {
      const pos = activePositions[symbol][userId];
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

        let markPrice = null;
        try {
          const mp = await client.futuresMarkPrice(symbol);
          if (mp && mp.markPrice) markPrice = parseFloat(mp.markPrice);
        } catch (e) {}
        if (!markPrice) {
          const k = await fetchFuturesKlines(symbol, "1m", 1);
          if (k && k.length) markPrice = k[0].close;
        }
        if (!markPrice) continue;

        // Trailing stop
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

        // TP/SL
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

// =========================
// TELEGRAM HANDLER - PART 1
// =========================
bot.on("message", async (msg) => {
  try {
    if (!msg.text) return;
    const chatId = msg.chat.id;
    const text = msg.text.trim();
    log(`Received message from ${msg.from.username || msg.from.id}: ${text}`);

    // --- /closeall ---
    if (String(msg.from.id) === String(ADMIN_ID) && text.toLowerCase().startsWith("/closeall")) {
      const parts = text.split(" ");
      const symbolArg = parts[1] ? parts[1].toUpperCase() : null;
      if (!symbolArg)
        return bot.sendMessage(chatId, "❌ Usage:\n/closeall BTCUSDT\n/closeall ALL", { parse_mode: "Markdown" });
      await bot.sendMessage(chatId, `📢 *ADMIN CLOSEALL INITIATED*\nTarget: ${symbolArg}`, { parse_mode: "Markdown" });
      const clients = createBinanceClients();
      for (const { userId, client } of clients) {
        try {
          const positions = await client.futuresPositionRisk();
          for (const p of positions) {
            const amt = parseFloat(p.positionAmt);
            if (amt === 0) continue;
            if (symbolArg !== "ALL" && p.symbol !== symbolArg) continue;
            const qty = Math.abs(amt);
            if (amt > 0) await client.futuresMarketSell(p.symbol, qty);
            else await client.futuresMarketBuy(p.symbol, qty);
            if (activePositions[p.symbol]) {
              delete activePositions[p.symbol][userId];
              if (Object.keys(activePositions[p.symbol]).length === 0) delete activePositions[p.symbol];
            }
            await sendMessage(`🔴 *MANUAL CLOSE EXECUTED*\nUser: ${userId}\nSymbol: ${p.symbol}\nQty: ${qty}`);
          }
        } catch (err) {
          log(`❌ Closeall error for user ${userId}: ${err?.message || err}`);
          await sendMessage(`❌ Closeall failed for User ${userId}`);
        }
      }
      return bot.sendMessage(chatId, "✅ *Manual Close-All Completed*", { parse_mode: "Markdown" });
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
      `📢 *CID SIGNAL DETECTED*\nSymbol: *${symbol}*\nDirection: *${direction}*\n⏱ Expires in ${Math.round(
        SIGNAL_EXPIRY_MS / 60000
      )} minutes\nChecking 15m Volume...`
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
      const volumeOk = await volumeCheck15m(symbol);
      if (!volumeOk) {
        await sendMessage(`⏳ Volume (15m) NOT passed for *${symbol}*`);
        return;
      }
      clearInterval(timer);
      delete pendingSignals[symbol];
      await sendMessage(`✅ Volume confirmed for *${symbol}* — Executing *CID Trade*...`);
      await executeMarketOrderForAllUsers(symbol, direction);
    }, SIGNAL_CHECK_INTERVAL_MS);
  } catch (err) {
    log(`❌ bot.on message error: ${err?.message || err}`);
  }
});

// =========================
// PDH / PDL MONITORING LOGIC
// =========================

// --- Check PDH/PDL condition ---
async function checkPdhPdl(symbol, type) {
  const klines = await fetchFuturesKlines(symbol, "1d", 2);
  if (!klines || klines.length < 2) return false;

  const prevHigh = klines[0].high;
  const prevLow = klines[0].low;

  const markPriceK = await fetchFuturesKlines(symbol, "1m", 1);
  if (!markPriceK || !markPriceK.length) return false;
  const currentPrice = markPriceK[0].close;

  const ema = await ema3_15m(symbol);
  if (!ema) return false;

  if (type === "PDH") {
    // Counter-trend SELL: price <= prevHigh AND below EMA3
    return currentPrice <= prevHigh && currentPrice < ema;
  } else if (type === "PDL") {
    // Counter-trend BUY: price >= prevLow AND above EMA3
    return currentPrice >= prevLow && currentPrice > ema;
  }
  return false;
}

// --- Check PDH/PDL Retest Bounce ---
async function checkPdhPdlRetest(symbol, type) {
  const klines = await fetchFuturesKlines(symbol, "1d", 2);
  if (!klines || klines.length < 2) return false;

  const prevHigh = klines[0].high;
  const prevLow = klines[0].low;

  const markPriceK = await fetchFuturesKlines(symbol, "1m", 1);
  if (!markPriceK || !markPriceK.length) return false;
  const currentPrice = markPriceK[0].close;

  const ema = await ema3_15m(symbol);
  if (!ema) return false;

  const zone = RETEST_ZONE_PCT / 100; // e.g., 0.2%
  if (type === "PDH") {
    return (
      pdhPdlState[symbol]?.brokePDH &&
      currentPrice >= prevHigh * (1 - zone) &&
      currentPrice <= prevHigh &&
      currentPrice > ema
    );
  } else if (type === "PDL") {
    return (
      pdhPdlState[symbol]?.brokePDL &&
      currentPrice <= prevLow * (1 + zone) &&
      currentPrice >= prevLow &&
      currentPrice < ema
    );
  }
  return false;
}

// --- Monitor PDH/PDL ---
async function monitorPdhPdl() {
  for (const symbol of Object.keys(pdhPdlMonitors)) {
    const monitor = pdhPdlMonitors[symbol];
    if (!monitor.active || monitor.triggered) continue; // skip if already triggered

    const conditionMet = await checkPdhPdl(symbol, monitor.type);
    if (!conditionMet) continue;

    const direction = monitor.type === "PDH" ? "SELL" : "BUY";
    await sendMessage(`📢 PDH/PDL Counter-Trend Triggered for *${symbol}* — Executing ${direction} trade!`);

    await executeMarketOrderForAllUsers(symbol, direction);

    monitor.triggered = true; // mark as executed
  }
}
setInterval(monitorPdhPdl, MONITOR_INTERVAL_MS);

// =========================
// TELEGRAM HANDLER - PART 2
// =========================

bot.on("message", async (msg) => {
  try {
    if (!msg.text) return;
    const chatId = msg.chat.id;
    const text = msg.text.trim();
    if (!text.startsWith("/monitor")) return;

    const parts = text.split(" ");
    if (parts.length !== 3) {
      return bot.sendMessage(chatId, "❌ Usage:\n/monitor SYMBOL PDH\n/monitor SYMBOL PDL", { parse_mode: "Markdown" });
    }

    const symbol = parts[1].toUpperCase();
    const type = parts[2].toUpperCase();
    if (type !== "PDH" && type !== "PDL") {
      return bot.sendMessage(chatId, "❌ Type must be PDH or PDL", { parse_mode: "Markdown" });
    }

    pdhPdlMonitors[symbol] = { type, active: true };
    pdhPdlState[symbol] = { brokePDH: false, brokePDL: false }; // initialize retest tracking
    await sendMessage(`📡 Monitoring *${symbol}* for *${type}* condition with EMA3 (15m) and retest bounce logic.`);
  } catch (err) {
    log(`❌ bot.on /monitor error: ${err?.message || err}`);
  }
});

// --- Optional manual stop ---
bot.onText(/\/stopmonitor (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const symbol = match[1].toUpperCase();
  if (pdhPdlMonitors[symbol]) {
    delete pdhPdlMonitors[symbol];
    delete pdhPdlState[symbol];
    await sendMessage(`🛑 Stopped monitoring *${symbol}* for PDH/PDL conditions.`);
  } else {
    await sendMessage(`ℹ️ No active monitor found for *${symbol}*.`);
  }
});

// =========================
// BOT COMMANDS SUMMARY
// =========================
//
// /monitor SYMBOL PDH       → start monitoring a symbol for PDH Counter-Trend & Retest Bounce
// /monitor SYMBOL PDL       → start monitoring a symbol for PDL Counter-Trend & Retest Bounce
// /stopmonitor SYMBOL       → stop monitoring a symbol for PDH/PDL
// /closeall SYMBOL          → admin closes all positions for that symbol
// /closeall ALL             → admin closes all positions for all symbols
// CID Signals automatically parsed from Telegram messages containing “CONFIRMED CHANGE IN DIRECTION”
