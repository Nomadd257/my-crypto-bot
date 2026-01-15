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
const MONITOR_INTERVAL_MS = 5000;
const SIGNAL_CHECK_INTERVAL_MS = 60000;
const SIGNAL_EXPIRY_MS = 3600000; // 1 hour
const RETEST_ZONE_PCT = 0.2; // 0.2% retest zone

// --- In-memory ---
let activePositions = {};
let pendingSignals = {};
let userClients = {};
let pdhPdlMonitors = {};
let pdhPdlState = {};

// --- Logging ---
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// --- Load users from JSON ---
function loadUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) return [];
    const raw = fs.readFileSync(USERS_FILE, "utf8").trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const users = [];
    if (typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [key, val] of Object.entries(parsed)) {
        if (val && val.active && val.apiKey && val.apiSecret) {
          users.push({ id: key, apiKey: val.apiKey, apiSecret: val.apiSecret });
        }
      }
    } else if (Array.isArray(parsed)) {
      parsed.forEach((u) => {
        if (u && u.active && u.apiKey && u.apiSecret && u.id) {
          users.push({ id: String(u.id), apiKey: u.apiKey, apiSecret: u.apiSecret });
        }
      });
    }
    return users;
  } catch (err) {
    log(`❌ loadUsers error: ${err?.message || err}`);
    return [];
  }
}

// --- Create Binance clients ---
function createBinanceClients() {
  const users = loadUsers();
  userClients = {};
  for (const u of users) {
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
      log(`❌ Binance client creation failed for ${u.id}: ${err?.message || err}`);
    }
  }
  log(`✅ Binance clients created for users: ${Object.keys(userClients).join(", ")}`);
}

// --- Telegram send helper ---
async function sendMessage(msg) {
  try {
    await bot.sendMessage(GROUP_CHAT_ID, msg, { parse_mode: "Markdown" });
  } catch (e) {
    log(`tg group error: ${e?.message || e}`);
  }
  try {
    await bot.sendMessage(ADMIN_ID, msg, { parse_mode: "Markdown" });
  } catch (e) {
    log(`tg admin error: ${e?.message || e}`);
  }
}

// --- Fetch Futures klines ---
async function fetchFuturesKlines(symbol, interval = "15m", limit = 50) {
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

// --- EMA 3 close (simple) ---
async function ema3_15m(symbol) {
  const candles = await fetchFuturesKlines(symbol, "15m", 3);
  if (!candles || candles.length < 3) return null;
  return candles.reduce((s, c) => s + c.close, 0) / 3;
}

// --- CID Volume Imbalance ---
async function checkVolumeImbalance(symbol) {
  const candles = await fetchFuturesKlines(symbol, "15m", 4);
  if (!candles || candles.length < 4) return { passed: false, buyAggression: 0, sellAggression: 0 };
  let buy = 0,
    sell = 0;

  for (const c of candles.slice(0, 3)) {
    const res = await fetch(`https://fapi.binance.com/fapi/v1/trades?symbol=${symbol}&limit=50`);
    if (!res.ok) continue;
    const trades = await res.json();
    for (const t of trades) t.isBuyerMaker ? (sell += parseFloat(t.qty)) : (buy += parseFloat(t.qty));
  }

  const resCurrent = await fetch(`https://fapi.binance.com/fapi/v1/trades?symbol=${symbol}&limit=50`);
  if (resCurrent.ok) {
    const trades = await resCurrent.json();
    for (const t of trades) t.isBuyerMaker ? (sell += parseFloat(t.qty)) : (buy += parseFloat(t.qty));
  }

  const total = buy + sell;
  if (!total) return { passed: false, buyAggression: 0, sellAggression: 0 };
  const buyAgg = buy / total;
  const sellAgg = sell / total;

  return { passed: buyAgg >= 0.6 || sellAgg >= 0.6, buyAggression: buyAgg, sellAggression: sellAgg };
}

// --- Execute Market Orders ---
async function executeMarketOrderForAllUsers(symbol, direction) {
  createBinanceClients();
  if (!Object.keys(userClients).length) {
    await sendMessage(`⚠️ No active users for ${symbol}`);
    return;
  }

  for (const userId in userClients) {
    const client = userClients[userId];
    try {
      await client.futuresLeverage(symbol, LEVERAGE);
      const balances = await client.futuresBalance();
      const usdtBal = balances.find((b) => b.asset === "USDT");
      const balAmount = usdtBal ? parseFloat(usdtBal.balance) : 0;
      if (!balAmount) continue;

      const mark = await client.futuresMarkPrice(symbol);
      const markPrice = mark.markPrice ? parseFloat(mark.markPrice) : parseFloat(mark[0]?.markPrice || 0);
      if (!markPrice) continue;

      const tradeValue = balAmount * TRADE_PERCENT;
      const rawQty = (tradeValue * LEVERAGE) / markPrice;

      const info = await client.futuresExchangeInfo();
      const s = info.symbols.find((x) => x.symbol === symbol);
      if (!s) continue;
      const step = parseFloat(s.filters.find((f) => f.filterType === "LOT_SIZE").stepSize);
      let precision = 0,
        tmp = step;
      while (tmp < 1) {
        tmp *= 10;
        precision++;
      }
      const qty = Math.max(parseFloat(rawQty.toFixed(precision)), step);

      let side;
      if (["BUY", "BULLISH"].includes(direction.toUpperCase())) side = "BUY";
      else side = "SELL";

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
      log(`❌ Order failed for User ${userId} on ${symbol}: ${err?.message || err}`);
    }
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

// --- /closeall command (ALL or single symbol) ---
bot.on("message", async (msg) => {
  if (!msg.text) return;
  if (String(msg.from.id) !== String(ADMIN_ID)) return;

  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (!text.toLowerCase().startsWith("/closeall")) return;

  const parts = text.split(" ");
  const symArg = parts[1]?.toUpperCase();

  if (!symArg) {
    return bot.sendMessage(chatId, "❌ Usage:\n/closeall BTCUSDT\n/closeall ALL", { parse_mode: "Markdown" });
  }

  await sendMessage(`📢 *Manual Close Triggered:* ${symArg}`);

  for (const userId of Object.keys(userClients)) {
    const client = userClients[userId];
    if (!client) continue;

    try {
      const positions = await client.futuresPositionRisk();
      if (!Array.isArray(positions)) continue;

      for (const p of positions) {
        const symbol = p.symbol;
        const positionAmt = parseFloat(p.positionAmt);

        if (positionAmt === 0) continue;
        if (symArg !== "ALL" && symArg !== symbol) continue;

        const qty = Math.abs(positionAmt);
        const closeSide = positionAmt > 0 ? "SELL" : "BUY";

        if (closeSide === "SELL") {
          await client.futuresMarketSell(symbol, qty);
        } else {
          await client.futuresMarketBuy(symbol, qty);
        }

        // Cleanup local tracking
        if (activePositions[symbol]?.[userId]) {
          delete activePositions[symbol][userId];
          if (!Object.keys(activePositions[symbol]).length) {
            delete activePositions[symbol];
          }
        }

        await sendMessage(`🔴 *MANUAL CLOSE*\nUser: ${userId}\nSymbol: ${symbol}\nQty: ${qty}\nAction: ${closeSide}`);
      }
    } catch (err) {
      await sendMessage(`❌ Failed to close positions for User ${userId}: ${err?.message || err}`);
    }
  }

  await bot.sendMessage(chatId, "✅ Manual Close Completed.", {
    parse_mode: "Markdown",
  });
});

// --- Placeholder for liquiditySweepCheck ---
async function liquiditySweepCheck(symbol, direction) {
  // TODO: Implement real logic
  return true;
}

// --- Aggression Check ---
async function aggressionCheck(symbol) {
  try {
    const tradesRes = await fetch(`https://fapi.binance.com/fapi/v1/trades?symbol=${symbol}&limit=50`);
    if (!tradesRes.ok) return false;
    const trades = await tradesRes.json();
    let buy = 0,
      sell = 0;
    for (const t of trades) t.isBuyerMaker ? (sell += parseFloat(t.qty)) : (buy += parseFloat(t.qty));
    const total = buy + sell;
    if (!total) return false;
    return buy / total >= 0.6 || sell / total >= 0.6;
  } catch (err) {
    log(`❌ aggressionCheck error for ${symbol}: ${err?.message || err}`);
    return false;
  }
}

// --- EMA + Liquidity + Aggression ---
async function liquidityEmaAggressionCheck(symbol, direction) {
  const sweep = await liquiditySweepCheck(symbol, direction);
  if (!sweep) return false;
  const ema = await ema3_15m(symbol);
  if (!ema) return false;
  const aggression = await aggressionCheck(symbol);
  if (!aggression) return false;
  return true;
}

// --- PDH / PDL Check ---
async function checkPdhPdl(symbol, type) {
  const d = await fetchFuturesKlines(symbol, "1d", 2);
  if (!d || d.length < 2) return false;
  const prevHigh = d[0].high,
    prevLow = d[0].low;
  const m = await fetchFuturesKlines(symbol, "1m", 1);
  if (!m || !m.length) return false;
  const price = m[0].close;
  const zone = RETEST_ZONE_PCT;
  if (type === "PDH") return price <= prevHigh && price >= prevHigh * (1 - zone);
  if (type === "PDL") return price >= prevLow && price <= prevLow * (1 + zone);
  return false;
}

// --- Monitor PDH/PDL ---
async function monitorPdhPdl() {
  for (const symbol of Object.keys(pdhPdlMonitors)) {
    const monitor = pdhPdlMonitors[symbol];
    if (!monitor.active || monitor.triggered) continue;
    const direction = monitor.type === "PDH" ? "SELL" : "BUY";
    const valid = await liquidityEmaAggressionCheck(symbol, direction);
    if (!valid) continue;
    const zoneOk = await checkPdhPdl(symbol, monitor.type);
    if (!zoneOk) continue;

    await sendMessage(
      `📡 Monitoring *${symbol}* for *${monitor.type}* condition with Liquidity Sweep + EMA reclaim + Aggression`
    );
    await executeMarketOrderForAllUsers(symbol, direction);
    monitor.triggered = true;

    const interval = setInterval(async () => {
      const stillNear = await checkPdhPdl(symbol, monitor.type);
      if (!stillNear) return clearInterval(interval);
      const k = await fetchFuturesKlines(symbol, "1m", 30);
      if (!k) return;
      const vol = k.reduce((s, c) => s + c.volume, 0);
      const price = k[k.length - 1].close;
      await sendMessage(
        `ℹ️ *${symbol}* near ${monitor.type}\nVolume (30m): ${vol.toFixed(2)}\nTrade Amount: $${(vol * price).toFixed(
          2
        )}`
      );
    }, 30 * 60 * 1000);
  }
}
setInterval(monitorPdhPdl, MONITOR_INTERVAL_MS);

// --- TELEGRAM COMMANDS: /monitor & /stopmonitor ---
bot.onText(/\/monitor(?:@\w+)?\s+([A-Z]+USDT)\s+(PDH|PDL)/i, async (msg, match) => {
  const chatId = msg.chat.id;
  if (String(msg.from.id) !== String(ADMIN_ID)) return;
  const symbol = match[1].toUpperCase();
  const type = match[2].toUpperCase();
  pdhPdlMonitors[symbol] = { type, active: true, triggered: false };
  pdhPdlState[symbol] = { brokePDH: false, brokePDL: false };
  await sendMessage(
    `📡 Monitoring *${symbol}* for *${type}* condition with Liquidity Sweep + EMA reclaim + Aggression`
  );
});

bot.onText(/\/stopmonitor(?:@\w+)?\s+([A-Z]+USDT)/i, async (msg, match) => {
  const chatId = msg.chat.id;
  if (String(msg.from.id) !== String(ADMIN_ID)) return;
  const symbol = match[1].toUpperCase();
  if (pdhPdlMonitors[symbol]) {
    delete pdhPdlMonitors[symbol];
    delete pdhPdlState[symbol];
    await sendMessage(`🛑 Stopped monitoring *${symbol}* for PDH/PDL conditions.`);
  } else await sendMessage(`ℹ️ No active monitor found for *${symbol}*.`);
});
