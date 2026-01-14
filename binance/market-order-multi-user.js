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

// --- Logging ---
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// --- Load users ---
function loadUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) return [];
    const raw = fs.readFileSync(USERS_FILE, "utf8").trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
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
  const users = loadUsers();
  userClients = {};
  for (const u of users) {
    try {
      const client = new Binance();
      client.options({ APIKEY: u.apiKey, APISECRET: u.apiSecret, useServerTime: true, recvWindow: 60000 });
      userClients[u.id] = client;
    } catch (err) {
      log(`❌ Binance client creation failed for ${u.id}: ${err?.message || err}`);
    }
  }
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

// --- EMA 3 close for reclaim ---
async function ema3_15m(symbol) {
  const candles = await fetchFuturesKlines(symbol, "15m", 50);
  if (!candles || candles.length < 3) return null;
  const closes = candles.map((c) => c.close);
  let ema = closes.slice(0, 3).reduce((a, b) => a + b, 0) / 3;
  const k = 2 / (3 + 1);
  for (let i = 3; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

// --- Volume Imbalance Check (aggression) ---
async function checkVolumeImbalance(symbol) {
  try {
    const tradesRes = await fetch(`https://fapi.binance.com/fapi/v1/trades?symbol=${symbol}&limit=50`);
    if (!tradesRes.ok) return false;
    const trades = await tradesRes.json();

    let buyVolume = 0;
    let sellVolume = 0;
    for (const t of trades) {
      if (t.isBuyerMaker) sellVolume += parseFloat(t.qty);
      else buyVolume += parseFloat(t.qty);
    }

    const totalVolume = buyVolume + sellVolume;
    if (totalVolume === 0) return false;

    const buyAggression = buyVolume / totalVolume;
    const sellAggression = sellVolume / totalVolume;

    // Pass if either buy or sell aggression is >= 60%
    return buyAggression >= 0.6 || sellAggression >= 0.6;
  } catch (err) {
    log(`❌ checkVolumeImbalance error for ${symbol}: ${err?.message || err}`);
    return false;
  }
}

// --- Execute Market Order for All Users (Robust + Debug) ---
async function executeMarketOrderForAllUsers(symbol, direction) {
  try {
    // Create Binance clients
    createBinanceClients();

    const users = Object.keys(userClients);
    if (!users.length) {
      await sendMessage(`⚠️ No active users found for ${symbol}`);
      log("No Binance clients available.");
      return;
    }

    log(`Executing ${direction} orders for ${symbol} for users: ${users.join(", ")}`);

    for (const userId of users) {
      const client = userClients[userId];
      if (!client) {
        log(`❌ No client found for user ${userId}`);
        continue;
      }

      try {
        // Set leverage
        await client.futuresLeverage(symbol, LEVERAGE);

        // Get USDT balance
        const balances = await client.futuresBalance();
        const usdtBalObj = balances.find((b) => b.asset === "USDT");
        const usdtBal = usdtBalObj ? parseFloat(usdtBalObj.balance) : 0;
        if (usdtBal <= 0) {
          log(`⚠️ User ${userId} has 0 USDT balance, skipping.`);
          continue;
        }

        // Get current mark price
        const mark = await client.futuresMarkPrice(symbol);
        const markPrice = mark.markPrice ? parseFloat(mark.markPrice) : parseFloat(mark[0]?.markPrice || 0);
        if (!markPrice) {
          log(`⚠️ Could not fetch mark price for ${symbol}, skipping user ${userId}`);
          continue;
        }

        // Calculate trade quantity
        const tradeValue = usdtBal * TRADE_PERCENT;
        const rawQty = (tradeValue * LEVERAGE) / markPrice;
        const qty = Math.max(parseFloat(rawQty.toFixed(6)), 0.001);

        // Determine side
        const side = direction.toUpperCase() === "BULLISH" ? "BUY" : "SELL";

        log(`User ${userId} | Side: ${side} | Qty: ${qty} | MarkPrice: ${markPrice}`);

        // Place market order
        try {
          if (side === "BUY") {
            await client.futuresMarketBuy(symbol, qty);
          } else {
            await client.futuresMarketSell(symbol, qty);
          }
          await sendMessage(`✅ *${side} EXECUTED* on *${symbol}* for User ${userId} (qty ${qty})`);

          // Track active position
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
        } catch (orderErr) {
          log(`❌ Order failed for User ${userId} on ${symbol}: ${orderErr?.message || orderErr}`);
          await sendMessage(`❌ Order failed for User ${userId} on *${symbol}*: ${orderErr?.message || orderErr}`);
        }
      } catch (userErr) {
        log(`❌ Error preparing trade for User ${userId} on ${symbol}: ${userErr?.message || userErr}`);
      }
    }
  } catch (err) {
    log(`❌ executeMarketOrderForAllUsers outer error: ${err?.message || err}`);
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

// --- /closeall command ---
bot.on("message", async (msg) => {
  if (!msg.text) return;
  if (String(msg.from.id) !== String(ADMIN_ID)) return;

  const chatId = msg.chat.id;
  const text = msg.text.trim().toLowerCase();

  if (text.startsWith("/closeall")) {
    const parts = text.split(" ");
    const symArg = parts[1]?.toUpperCase() || null;
    if (!symArg)
      return bot.sendMessage(chatId, "❌ Usage:\n/closeall BTCUSDT\n/closeall ALL", { parse_mode: "Markdown" });

    bot.sendMessage(chatId, `📢 *Manual Close-All Triggered:* ${symArg}`, { parse_mode: "Markdown" });

    for (const sym of Object.keys(activePositions)) {
      for (const userId of Object.keys(activePositions[sym])) {
        if (symArg !== "ALL" && symArg !== sym) continue;
        const pos = activePositions[sym][userId];
        const client = userClients[userId];
        if (!client) continue;
        const closeSide = pos.side === "BUY" ? "SELL" : "BUY";
        try {
          if (closeSide === "BUY") await client.futuresMarketBuy(sym, pos.qty);
          else await client.futuresMarketSell(sym, pos.qty);
          delete activePositions[sym][userId];
          await sendMessage(`🔴 *MANUAL CLOSE:* User ${userId}\nSymbol: ${sym}\nQty: ${pos.qty}\nAction: ${closeSide}`);
        } catch (err) {
          await sendMessage(`❌ Failed to close User ${userId} on ${sym}: ${err?.message || err}`);
        }
      }
    }
    return bot.sendMessage(chatId, "✅ Manual Close-All Completed.", { parse_mode: "Markdown" });
  }
});

// --- CID signal parser ---
bot.on("message", async (msg) => {
  if (!msg.text) return;
  const text = msg.text.trim();
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
    )} minutes\nChecking Volume Imbalance...`
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
    if (!volOk) await sendMessage(`⏳ Volume Imbalance not passed for *${symbol}*`);

    if (volOk) {
      clearInterval(timer);
      delete pendingSignals[symbol];
      await sendMessage(`✅ Volume Imbalance Passed for *${symbol}* — Executing Market Orders...`);
      await executeMarketOrderForAllUsers(symbol, direction);
    }
  }, SIGNAL_CHECK_INTERVAL_MS);
});
// =====================================================
// PART 2: PDH / PDL MONITORING & TELEGRAM HANDLERS
// Liquidity Sweep + EMA Reclaim + Aggression (buy/sell imbalance)
// =====================================================

// --- Aggression check based on buy/sell orders ---
async function aggressionCheck(symbol) {
  try {
    const tradesRes = await fetch(`https://fapi.binance.com/fapi/v1/trades?symbol=${symbol}&limit=50`);
    if (!tradesRes.ok) return false;
    const trades = await tradesRes.json();

    let buyVolume = 0;
    let sellVolume = 0;

    for (const t of trades) {
      // 'isBuyerMaker' === true → maker is buyer, so aggressive sell
      if (t.isBuyerMaker) sellVolume += parseFloat(t.qty);
      else buyVolume += parseFloat(t.qty);
    }

    const totalVolume = buyVolume + sellVolume;
    if (totalVolume === 0) return false;

    const buyAggression = buyVolume / totalVolume;
    const sellAggression = sellVolume / totalVolume;

    // Trigger if either side is dominant (>60%)
    return buyAggression >= 0.6 || sellAggression >= 0.6;
  } catch (err) {
    log(`❌ aggressionCheck error for ${symbol}: ${err?.message || err}`);
    return false;
  }
}

// --- EMA reclaim 15m check ---
async function ema3_15m(symbol) {
  const klines = await fetchFuturesKlines(symbol, "15m", 3);
  if (!klines || klines.length < 3) return null;
  const sumClose = klines.reduce((acc, k) => acc + k.close, 0);
  return sumClose / 3;
}

// --- Liquidity Sweep + EMA Reclaim + Aggression ---
async function liquidityEmaAggressionCheck(symbol, direction) {
  const sweep = await liquiditySweepCheck(symbol, direction);
  if (!sweep) return false;

  const ema = await ema3_15m(symbol);
  if (!ema) return false;

  const aggression = await aggressionCheck(symbol);
  if (!aggression) return false;

  return true;
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

  const zone = RETEST_ZONE_PCT; // use global 0.2% by default
  if (type === "PDH") return currentPrice <= prevHigh && currentPrice >= prevHigh * (1 - zone);
  else if (type === "PDL") return currentPrice >= prevLow && currentPrice <= prevLow * (1 + zone);
  return false;
}

// --- Monitor PDH/PDL ---
async function monitorPdhPdl() {
  for (const symbol of Object.keys(pdhPdlMonitors)) {
    const monitor = pdhPdlMonitors[symbol];
    if (!monitor.active || monitor.triggered) continue;

    const direction = monitor.type === "PDH" ? "SELL" : "BUY";

    const valid = await liquidityEmaAggressionCheck(symbol, direction);
    if (!valid) {
      log(`⏳ Liquidity/EMA/Aggression not met for ${symbol} (${direction})`);
      continue;
    }

    const conditionMet = await checkPdhPdl(symbol, monitor.type);
    if (!conditionMet) continue;

    // Execute trade
    await sendMessage(`📢 PDH/PDL Counter-Trend Triggered for *${symbol}* — Executing ${direction} trade!`);
    await executeMarketOrderForAllUsers(symbol, direction);

    monitor.triggered = true;

    // Schedule 30-min updates while price remains near PDH/PDL
    const updateInterval = setInterval(async () => {
      const stillNear = await checkPdhPdl(symbol, monitor.type);
      if (!stillNear) {
        clearInterval(updateInterval);
        return;
      }

      // Calculate total volume and trade amount over last 30 mins
      const klines1m = await fetchFuturesKlines(symbol, "1m", 30);
      if (!klines1m) return;
      const totalVolume = klines1m.reduce((sum, k) => sum + k.volume, 0);
      const markPrice = klines1m[klines1m.length - 1].close;
      const tradeAmount = totalVolume * markPrice;

      await sendMessage(
        `ℹ️ Update: *${symbol}* near ${monitor.type}\nVolume(last 30m): ${totalVolume.toFixed(
          2
        )}\nTrade Amount: $${tradeAmount.toFixed(2)}`
      );
    }, 30 * 60 * 1000);
  }
}
setInterval(monitorPdhPdl, MONITOR_INTERVAL_MS);

// =========================
// TELEGRAM HANDLER - /monitor & /stopmonitor
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
    pdhPdlState[symbol] = { brokePDH: false, brokePDL: false };
    await sendMessage(
      `📡 Monitoring *${symbol}* for *${type}* condition with Liquidity Sweep + EMA reclaim + Aggression`
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
