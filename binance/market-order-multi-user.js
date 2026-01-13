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

// --- Volume Check 15m for CID signals ---
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
}

// =========================
// ADMIN /closeall COMMAND
// =========================
bot.on("message", async (msg) => {
  try {
    if (!msg.text) return;

    const text = msg.text.trim();
    const chatId = msg.chat.id;

    if (String(msg.from.id) !== String(ADMIN_ID)) return;
    if (!text.toLowerCase().startsWith("/closeall")) return;

    const parts = text.split(" ");
    const target = parts[1] ? parts[1].toUpperCase() : null;

    if (!target) {
      return bot.sendMessage(chatId, "❌ Usage:\n/closeall BTCUSDT\n/closeall ALL");
    }

    await sendMessage(`📢 *ADMIN CLOSE-ALL STARTED*\nTarget: *${target}*`);

    const clients = createBinanceClients();

    for (const { userId, client } of clients) {
      try {
        const positions = await client.futuresPositionRisk();

        for (const p of positions) {
          const amt = parseFloat(p.positionAmt);
          if (amt === 0) continue;
          if (target !== "ALL" && p.symbol !== target) continue;

          const qty = Math.abs(amt);
          if (amt > 0) await client.futuresMarketSell(p.symbol, qty);
          else await client.futuresMarketBuy(p.symbol, qty);

          if (activePositions[p.symbol]) {
            delete activePositions[p.symbol][userId];
          }

          await sendMessage(`🔴 *FORCED CLOSE*\nUser: ${userId}\nSymbol: ${p.symbol}\nQty: ${qty}`);
        }
      } catch (err) {
        log(`❌ closeall error for ${userId}: ${err.message}`);
      }
    }

    await bot.sendMessage(chatId, "✅ *Close-all completed*");
  } catch (err) {
    log(`❌ /closeall handler error: ${err.message}`);
  }
});

// =========================
// PART 2: PDH / PDL MONITORING & TELEGRAM HANDLERS
// =========================

// --- Liquidity Sweep + EMA Reclaim Check ---
async function liquiditySweepCheck(symbol, direction) {
  const klines = await fetchFuturesKlines(symbol, "15m", 11);
  if (!klines || klines.length < 11) return false;

  const last = klines[klines.length - 1];
  const prevVolumes = klines.slice(0, -1).map((k) => k.volume);
  const avgVolume = prevVolumes.reduce((a, b) => a + b, 0) / prevVolumes.length;

  const ema = await ema3_15m(symbol);
  if (!ema) return false;

  const candleBody = Math.abs(last.close - last.open);
  const lowerWick = last.open > last.close ? last.low - last.close : last.low - last.open;
  const upperWick = last.close > last.open ? last.high - last.close : last.high - last.open;

  if (direction === "BUY") {
    // Liquidity sweep down + reclaim above EMA
    const sweepDown = lowerWick > candleBody && last.close > ema;
    const volumeOk = last.volume >= 1.2 * avgVolume;
    return sweepDown && volumeOk;
  } else if (direction === "SELL") {
    // Liquidity sweep up + reclaim below EMA
    const sweepUp = upperWick > candleBody && last.close < ema;
    const volumeOk = last.volume >= 1.2 * avgVolume;
    return sweepUp && volumeOk;
  }

  return false;
}

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
    const zone = 0.002; // 0.2%
    return currentPrice <= prevHigh && currentPrice >= prevHigh * (1 - zone) && currentPrice < ema;
  } else if (type === "PDL") {
    const zone = 0.002; // 0.2%
    return currentPrice >= prevLow && currentPrice <= prevLow * (1 + zone) && currentPrice > ema;
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

    const direction = monitor.type === "PDH" ? "SELL" : "BUY";
    const sweepOk = await liquiditySweepCheck(symbol, direction);
    if (!sweepOk) {
      log(`⏳ Liquidity sweep + EMA reclaim not met for ${symbol} (${direction})`);
      continue;
    }

    const conditionMet = await checkPdhPdl(symbol, monitor.type);
    if (!conditionMet) continue;

    await sendMessage(`📢 PDH/PDL Counter-Trend Triggered for *${symbol}* — Executing ${direction} trade!`);
    await executeMarketOrderForAllUsers(symbol, direction);

    monitor.triggered = true; // mark as executed
  }
}
setInterval(monitorPdhPdl, MONITOR_INTERVAL_MS);

// =========================
// TELEGRAM HANDLER - MONITOR COMMAND
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

    pdhPdlMonitors[symbol] = { type, active: true, triggered: false };
    pdhPdlState[symbol] = { brokePDH: false, brokePDL: false }; // initialize retest tracking
    await sendMessage(
      `📡 Monitoring *${symbol}* for *${type}* condition with EMA3 (15m), liquidity sweep + EMA reclaim, and retest bounce logic.`
    );
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
// /monitor SYMBOL PDH       → start monitoring a symbol for PDH Counter-Trend & Retest Bounce with liquidity sweep + EMA reclaim
// /monitor SYMBOL PDL       → start monitoring a symbol for PDL Counter-Trend & Retest Bounce with liquidity sweep + EMA reclaim
// /stopmonitor SYMBOL       → stop monitoring a symbol for PDH/PDL
// /closeall SYMBOL          → admin closes all positions for that symbol
// /closeall ALL             → admin closes all positions for all symbols
// CID Signals automatically parsed from Telegram messages containing “CONFIRMED CHANGE IN DIRECTION”
// CID trades still use normal 15m volume check (not directional)
