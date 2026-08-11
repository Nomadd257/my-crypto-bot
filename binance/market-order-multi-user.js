// =====================================================
// FULL AUTO MULTI-USER MARKET ORDER BOT - BINANCE FUTURES (USDT-PERP)
// STC STRATEGY: 1H STC = direction, 5M STC = entry (confirmed flip on close)
// TP/SL/TRAILING STOP INTACT
// Volume imbalance report only per trade
// MAX TRADES = 7 per user
// 30-min cooldown per symbol
// =====================================================

const config = require("../config");
const Binance = require("node-binance-api");
const TelegramBot = require("node-telegram-bot-api");
const { ADX } = require("technicalindicators");
const fs = require("fs");
const fetch = require("node-fetch");
globalThis.fetch = fetch;

// --- TELEGRAM DETAILS ---
const TELEGRAM_BOT_TOKEN = "8247817335:AAEKf92ex9eiDZKoan1O8uzZ3ls5uEjJsQw";
const GROUP_CHAT_ID = "-1003419090746";
const ADMIN_ID = "7476742687";
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// --- USERS FILE ---
const USERS_FILE = "./users.json";

// --- Settings ---
const TRADE_PERCENT = 0.1;
const LEVERAGE = 20;
const TP_PCT = 2.0;
const SL_PCT = 1.5;
const TRAILING_STOP_PCT = 3;
const MONITOR_INTERVAL_MS = 5000;
const SIGNAL_CHECK_INTERVAL_MS = 60 * 1000;
const MAX_TRADES = 7; // per user
const COOLDOWN_MS = 120 * 60 * 1000; // 2 hours
const COIN_LIST = [
  "AVAXUSDT",
  "NEARUSDT",
  "LTCUSDT",
  "XRPUSDT",
  "APTUSDT",
  "BNBUSDT",
  "SOLUSDT",
  "UNIUSDT",
  "TRUMPUSDT",
  "BCHUSDT",
  "AAVEUSDT",
  "ADAUSDT",
  "TONUSDT",
  "FILUSDT",
  "LINKUSDT",
  "XLMUSDT",
  "ATOMUSDT",
  "HYPEUSDT",
  "XMRUSDT",
  "SUIUSDT",
  "DOGEUSDT",
  "DOTUSDT",
  "ZECUSDT",
  "HBARUSDT",
  "WLFIUSDT",
  "ASTERUSDT",
  "ICPUSDT",
  "ONDOUSDT",
  "WLDUSDT",
  "POLUSDT",
  "ENAUSDT",
  "ALGOUSDT",
  "MORPHOUSDT",
  "QNTUSDT",
  "RENDERUSDT",
  "ZROUSDT",
  "DASHUSDT",
  "RIVERUSDT",
  "POWERUSDT",
  "PHAUSDT",
  "PIPPINUSDT",
  "XAGUSDT",
  "SAHARAUSDT",
  "ARCUSDT",
  "FORMUSDT",
];

// --- In-memory ---
let activePositions = {}; // { symbol: { userId: position } }
let userClients = {};
let BOT_PAUSED = false;
let symbolCooldowns = {}; // { symbol: timestamp }

// --- STC cycle trackers ---
let currentCycle = {}; // { symbol: "BULL" | "BEAR" }

let MANUAL_CYCLE = null; // "BULL" | "BEAR" | null

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
    const users = [];
    if (Array.isArray(parsed)) {
      for (const u of parsed)
        if (u.active && u.apiKey && u.apiSecret)
          users.push({ id: String(u.id), apiKey: u.apiKey, apiSecret: u.apiSecret });
    } else {
      for (const [k, v] of Object.entries(parsed))
        if (v.active && v.apiKey && v.apiSecret)
          users.push({ id: String(k), apiKey: v.apiKey, apiSecret: v.apiSecret });
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
      client.options({ APIKEY: u.apiKey, APISECRET: u.apiSecret, useServerTime: true, recvWindow: 60000 });
      userClients[u.id] = client;
    } catch (err) {
      log(`❌ createBinanceClients failed for ${u.id}: ${err?.message || err}`);
    }
  }
  return Object.entries(userClients).map(([userId, client]) => ({ userId, client }));
}
createBinanceClients();
log("✅ Binance clients initialized at startup.");
setInterval(createBinanceClients, 60 * 1000);

// --- Telegram send ---
async function sendMessage(msg) {
  try {
    await bot.sendMessage(GROUP_CHAT_ID, msg, { parse_mode: "Markdown" });
  } catch {}
  try {
    await bot.sendMessage(ADMIN_ID, msg, { parse_mode: "Markdown" });
  } catch {}
}

// --- Fetch Futures Klines ---
async function fetchFuturesKlines(symbol, interval = "15m", limit = 100) {
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

// --- Proper Schaff Trend Cycle (STC) ---
function calculateSTC(closes, { cycle = 4, fast = 10, slow = 20, signal = 3 } = {}) {
  if (!closes || closes.length < slow + cycle) return null;

  // --- EMA helper ---
  function EMA(data, length) {
    const k = 2 / (length + 1);
    let ema = data[0];
    const result = [ema];
    for (let i = 1; i < data.length; i++) {
      ema = data[i] * k + ema * (1 - k);
      result.push(ema);
    }
    return result;
  }

  // --- MACD ---
  const fastEMA = EMA(closes, fast);
  const slowEMA = EMA(closes, slow);
  const macd = fastEMA.map((v, i) => v - slowEMA[i]);

  // --- MACD signal line ---
  const signalLine = EMA(macd, signal);
  const macdHist = macd.map((v, i) => v - signalLine[i]);

  // --- Stochastic over MACD histogram ---
  const stc = [];
  for (let i = 0; i < macdHist.length; i++) {
    if (i < cycle) {
      stc.push(50); // neutral at start
      continue;
    }
    const slice = macdHist.slice(i - cycle + 1, i + 1);
    const min = Math.min(...slice);
    const max = Math.max(...slice);
    const value = max === min ? 50 : ((macdHist[i] - min) / (max - min)) * 100;
    stc.push(value);
  }

  return stc[stc.length - 1]; // return latest STC value
}

// --- Average True Range (ATR) ---
const ATR_PERIOD = 14; // standard ATR period

function calculateATR(candles, period = ATR_PERIOD) {
  if (!candles || candles.length < period + 1) return null;

  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trs.push(tr);
  }

  const recentTRs = trs.slice(-period);
  const atr = recentTRs.reduce((sum, val) => sum + val, 0) / period;
  return atr;
}

// --- Floor qty ---
function floorToStep(qty, step) {
  const s = Number(step);
  if (!s || s <= 0) return qty;
  const factor = Math.round(1 / s);
  return Number((Math.floor(qty * factor) / factor).toFixed((s.toString().split(".")[1] || "").length));
}

// --- Execute market orders for all users ---
async function executeMarketOrderForAllUsers(symbol, direction) {
  const clients = Object.entries(userClients).map(([userId, client]) => ({ userId, client }));
  if (!clients.length) {
    await sendMessage(`⚠️ No active users.`);
    return;
  }

  await sendMessage(`⚡ Executing *${direction}* on *${symbol}* for all users...`);

  for (const { userId, client } of clients) {
    try {
      // Check user MAX_TRADES
      const userOpenTrades = Object.values(activePositions).reduce((sum, sym) => sum + (sym[userId] ? 1 : 0), 0);
      if (userOpenTrades >= MAX_TRADES) {
        log(`User ${userId} has max open trades.`);
        continue;
      }

      await client.futuresLeverage(symbol, LEVERAGE).catch(() => {});
      const balances = await client.futuresBalance();
      const usdtBal = balances.find((b) => b.asset === "USDT");
      const bal = usdtBal ? parseFloat(usdtBal.balance) : 0;
      if (!bal || bal <= 0) {
        await sendMessage(`⚠️ User ${userId} has *NO USDT*. Trade skipped.`);
        continue;
      }

      let markPrice = 0;
      try {
        const mp = await client.futuresMarkPrice(symbol);
        markPrice = mp.markPrice ? parseFloat(mp.markPrice) : parseFloat(mp[0]?.markPrice || 0);
      } catch {}
      if (!markPrice || markPrice <= 0) {
        const k = await fetchFuturesKlines(symbol, "1m", 1);
        markPrice = k && k.length ? k[0].close : 0;
      }
      if (!markPrice || markPrice <= 0) {
        log(`⚠️ markPrice invalid for ${symbol}, skipping user ${userId}`);
        continue;
      }

      const tradeValue = bal * TRADE_PERCENT;
      const rawQty = (tradeValue * LEVERAGE) / markPrice;

      let lotStep = 0.001;
      try {
        const info = await client.futuresExchangeInfo();
        const s = info.symbols.find((s) => s.symbol === symbol);
        if (s) lotStep = parseFloat(s.filters.find((f) => f.filterType === "LOT_SIZE")?.stepSize || lotStep);
      } catch {}

      const qty = floorToStep(rawQty, lotStep);
      if (!qty || qty <= 0) continue;

      try {
        if (direction === "BUY") await client.futuresMarketBuy(symbol, qty);
        else await client.futuresMarketSell(symbol, qty);

        if (!activePositions[symbol]) activePositions[symbol] = {};
        activePositions[symbol][userId] = {
          side: direction,
          entryPrice: markPrice,
          qty,
          openedAt: Date.now(),
          trailingStop: null,
          highest: markPrice,
          lowest: markPrice,
        };
        // Start cooldown for this symbol
        symbolCooldowns[symbol] = Date.now();
        await sendMessage(`✅ *${direction} EXECUTED* on *${symbol}* for User ${userId} (qty ${qty})`);
      } catch (err) {
        log(`❌ Order failed for ${userId} on ${symbol}: ${err?.message || err}`);
      }
    } catch (err) {
      log(`❌ executeMarketOrder error for ${userId} ${symbol}: ${err?.message || err}`);
    }
  }
}

// --- Monitor positions (TP/SL/Trailing Stop) ---
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
        const amt = p ? parseFloat(p.positionAmt || 0) : 0;
        if (!p || amt === 0) {
          delete activePositions[symbol][userId];
          continue;
        }

        let mark = 0;
        try {
          const mp = await client.futuresMarkPrice(symbol);
          mark = mp?.markPrice ? parseFloat(mp.markPrice) : 0;
        } catch {}
        if (!mark || mark <= 0) continue;

        // Trailing Stop
        if (pos.side === "BUY") {
          pos.highest = Math.max(pos.highest, mark);
          const trail = pos.highest * (1 - TRAILING_STOP_PCT / 100);
          if (!pos.trailingStop || trail > pos.trailingStop) pos.trailingStop = trail;
          if (mark <= pos.trailingStop) {
            await client.futuresMarketSell(symbol, Math.abs(amt));
            delete activePositions[symbol][userId];
            await sendMessage(`🔒 Trailing Stop Hit: *${symbol}* (User ${userId})`);
            continue;
          }
        } else {
          pos.lowest = Math.min(pos.lowest, mark);
          const trail = pos.lowest * (1 + TRAILING_STOP_PCT / 100);
          if (!pos.trailingStop || trail < pos.trailingStop) pos.trailingStop = trail;
          if (mark >= pos.trailingStop) {
            await client.futuresMarketBuy(symbol, Math.abs(amt));
            delete activePositions[symbol][userId];
            await sendMessage(`🔒 Trailing Stop Hit: *${symbol}* (User ${userId})`);
            continue;
          }
        }

        // TP / SL
        const move =
          pos.side === "BUY"
            ? ((mark - pos.entryPrice) / pos.entryPrice) * 100
            : ((pos.entryPrice - mark) / pos.entryPrice) * 100;
        if (move >= TP_PCT) {
          if (pos.side === "BUY") await client.futuresMarketSell(symbol, Math.abs(amt));
          else await client.futuresMarketBuy(symbol, Math.abs(amt));
          delete activePositions[symbol][userId];
          await sendMessage(`🎯 TAKE PROFIT: *${symbol}* User ${userId}`);
          continue;
        }
        if (move <= -SL_PCT) {
          if (pos.side === "BUY") await client.futuresMarketSell(symbol, Math.abs(amt));
          else await client.futuresMarketBuy(symbol, Math.abs(amt));
          delete activePositions[symbol][userId];
          await sendMessage(`🔻 STOP LOSS: *${symbol}* User ${userId}`);
          continue;
        }
      } catch (err) {
        log(`❌ monitorPositions error ${userId} ${symbol}: ${err?.message || err}`);
      }
    }
  }
}
setInterval(monitorPositions, MONITOR_INTERVAL_MS);

// --- Manual cycle per symbol ---
let MANUAL_CYCLE_BY_SYMBOL = {}; // e.g., { BTCUSDT: "BULL", ETHUSDT: "BEAR" }

let symbolActive = {};
COIN_LIST.forEach((s) => (symbolActive[s] = true)); // By default, all symbols active

// --- Full-auto STC + ATR combined scanning loop ---

let prevBullishFlip = [];
let prevBearishFlip = [];
let prevBullishContinuation = [];
let prevBearishContinuation = [];

let symbolCooldownsATR = {}; // per-symbol cooldown for ATR messages (1h)

setInterval(async () => {
  const now = Date.now();

  const bullishFlip = [];
  const bearishFlip = [];
  const bullishContinuation = [];
  const bearishContinuation = [];

  for (const symbol of COIN_LIST) {
    const isActive = symbolActive[symbol] ?? true;

    try {
      const candles1H = await fetchFuturesKlines(symbol, "1h", 100);
      if (!candles1H || candles1H.length < 30) continue;

      const closedCandles1H = candles1H.slice(0, -1);
      const closes1H = closedCandles1H.map((c) => c.close);

      // =============================
      // TRUE DAILY LEVELS
      // =============================
      const dailyCandles = await fetchFuturesKlines(symbol, "1d", 2);
      if (!dailyCandles || dailyCandles.length < 2) continue;

      const lastClosedDaily = dailyCandles[dailyCandles.length - 2];
      const dailyHigh = lastClosedDaily.high;
      const dailyLow = lastClosedDaily.low;

      const currPrice = closes1H[closes1H.length - 1];

      // =============================
      // ATR
      // =============================
      const atr = calculateATR(closedCandles1H, ATR_PERIOD);
      if (!atr) continue;

      const prevAtr = calculateATR(closedCandles1H.slice(0, -1), ATR_PERIOD) || atr;
      const atrContracting = atr < prevAtr;
      const atrExpanding = atr > prevAtr;

      const distToLow = currPrice - dailyLow;
      const distToHigh = dailyHigh - currPrice;

      const atrMsgCooldown = 60 * 60 * 1000;

      // =============================
      // 1H STC SLOPE
      // =============================
      const stcSeries1H = [];
      for (let i = 0; i < closes1H.length; i++) {
        const slice = closes1H.slice(0, i + 1);
        const val = calculateSTC(slice, { cycle: 4, fast: 10, slow: 20 });
        if (val !== null) stcSeries1H.push(val);
      }
      if (stcSeries1H.length < 2) continue;

      const prev1H = stcSeries1H[stcSeries1H.length - 2];
      const curr1H = stcSeries1H[stcSeries1H.length - 1];
      const stcRising = curr1H > prev1H;
      const stcFalling = curr1H < prev1H;

      // =====================================================
      // COMBINED ATR + STC SIGNALS
      // =====================================================
      if (!symbolCooldownsATR[symbol] || now - symbolCooldownsATR[symbol] > atrMsgCooldown) {
        // --- NEAR DAILY LOW ---
        if (distToLow / atr <= 0.2) {
          if (atrContracting && stcRising) {
            bullishFlip.push(symbol);
            await sendMessage(
              `🟢 *Bullish Flip*\n${symbol} near ATR LOW (${currPrice.toFixed(4)}) — ATR contracting + STC rising.`,
            );
          }
          if (atrExpanding && stcFalling) {
            bearishContinuation.push(symbol);
            await sendMessage(
              `🔴 *Bearish Continuation*\n${symbol} near ATR LOW (${currPrice.toFixed(4)}) — ATR expanding + STC falling.`,
            );
          }
        }

        // --- NEAR DAILY HIGH ---
        if (distToHigh / atr <= 0.2) {
          if (atrContracting && stcFalling) {
            bearishFlip.push(symbol);
            await sendMessage(
              `🔴 *Bearish Flip*\n${symbol} near ATR HIGH (${currPrice.toFixed(4)}) — ATR contracting + STC falling.`,
            );
          }
          if (atrExpanding && stcRising) {
            bullishContinuation.push(symbol);
            await sendMessage(
              `🟢 *Bullish Continuation*\n${symbol} near ATR HIGH (${currPrice.toFixed(4)}) — ATR expanding + STC rising.`,
            );
          }
        }

        symbolCooldownsATR[symbol] = now;
      }

      // =====================================================
      // Skip trading if paused/inactive
      // =====================================================
      if (!isActive || BOT_PAUSED) continue;
      if (symbolCooldowns[symbol] && now - symbolCooldowns[symbol] < COOLDOWN_MS) continue;

      // =====================================================
      // 1H STC CYCLE LOCK (if not manual)
      // =====================================================
      if (!currentCycle[symbol]) {
        if (MANUAL_CYCLE_BY_SYMBOL[symbol]) currentCycle[symbol] = MANUAL_CYCLE_BY_SYMBOL[symbol];
        else if (MANUAL_CYCLE) currentCycle[symbol] = MANUAL_CYCLE;
        else currentCycle[symbol] = stcRising ? "BULL" : stcFalling ? "BEAR" : null;

        if (currentCycle[symbol]) {
          await sendMessage(`🔁 1H STC Cycle Locked for *${symbol}*: *${currentCycle[symbol]}*`);
        }
      }

      const trendCycle = currentCycle[symbol];
      if (!trendCycle) continue;

      // =====================================================
      // 5M STC ENTRY
      // =====================================================
      const candles5 = await fetchFuturesKlines(symbol, "5m", 100);
      if (!candles5 || candles5.length < 30) continue;

      const closedCandles5 = candles5.slice(0, -1);
      const closes5 = closedCandles5.map((c) => c.close);

      const stcSeries5 = [];
      for (let i = 0; i < closes5.length; i++) {
        const slice = closes5.slice(0, i + 1);
        const val = calculateSTC(slice, { cycle: 4, fast: 10, slow: 20 });
        if (val !== null) stcSeries5.push(val);
      }
      if (stcSeries5.length < 2) continue;

      const prev5 = stcSeries5[stcSeries5.length - 2];
      const curr5 = stcSeries5[stcSeries5.length - 1];

      let direction = null;
      if (trendCycle === "BULL" && prev5 < 25 && curr5 >= 25) direction = "BUY";
      if (trendCycle === "BEAR" && prev5 > 75 && curr5 <= 75) direction = "SELL";

      // =====================================================
      // EXECUTION
      // =====================================================
      if (direction) {
        await executeMarketOrderForAllUsers(symbol, direction);

        const buyVol = closedCandles5.reduce((sum, c) => sum + (c.close > c.open ? c.volume : 0), 0);
        const sellVol = closedCandles5.reduce((sum, c) => sum + (c.close < c.open ? c.volume : 0), 0);
        const totalVol = buyVol + sellVol;
        const buyPct = totalVol ? ((buyVol / totalVol) * 100).toFixed(1) : 0;
        const sellPct = totalVol ? ((sellVol / totalVol) * 100).toFixed(1) : 0;

        await sendMessage(
          `📊 Volume Imbalance Report: *${symbol}*\nBuy: ${buyVol.toFixed(2)} (${buyPct}%)\nSell: ${sellVol.toFixed(2)} (${sellPct}%)`,
        );

        symbolCooldowns[symbol] = now;
      }
    } catch (err) {
      log(`❌ STC + ATR scan error ${symbol}: ${err?.message || err}`);
    }
  }

  // =====================================================
  // 4-STATE SUMMARY (without price)
  // =====================================================
  const newBullishFlip = bullishFlip.filter((s) => !prevBullishFlip.includes(s));
  const newBearishFlip = bearishFlip.filter((s) => !prevBearishFlip.includes(s));
  const newBullishCont = bullishContinuation.filter((s) => !prevBullishContinuation.includes(s));
  const newBearishCont = bearishContinuation.filter((s) => !prevBearishContinuation.includes(s));

  if (newBullishFlip.length || newBearishFlip.length || newBullishCont.length || newBearishCont.length) {
    let summaryMsg = `⚡ *Ready to deploy bot*\n\n`;

    if (newBullishFlip.length)
      summaryMsg += `🟢 Bullish Flip (ATR Low + STC Rising):\n${newBullishFlip.join(", ")}\n\n`;
    if (newBearishFlip.length)
      summaryMsg += `🔴 Bearish Flip (ATR High + STC Falling):\n${newBearishFlip.join(", ")}\n\n`;
    if (newBullishCont.length)
      summaryMsg += `🟢 Bullish Continuation (ATR High + STC Rising):\n${newBullishCont.join(", ")}\n\n`;
    if (newBearishCont.length)
      summaryMsg += `🔴 Bearish Continuation (ATR Low + STC Falling):\n${newBearishCont.join(", ")}`;

    await sendMessage(summaryMsg);

    prevBullishFlip = bullishFlip;
    prevBearishFlip = bearishFlip;
    prevBullishContinuation = bullishContinuation;
    prevBearishContinuation = bearishContinuation;
  }
}, SIGNAL_CHECK_INTERVAL_MS);

//======================================================
// COIN DEPLOYMENT REPORT
//
// VERSION 5
//
// COMPONENTS
//
// • Session Cumulative Delta
// • EMA(10) of Session Cumulative Delta
// • 15M Delta/EMA(10) Early Warning
// • 1H Delta/EMA(10) Confirmation
// • 2H STC
// • 2H OBV
// • ATR Location
//
// 15M = Early signal
// 1H  = Confirmation
//
// Maximum Score = 100
//======================================================


//======================================================
// SESSION SETTINGS
//======================================================

// 0 = 00:00 UTC
const SESSION_START_HOUR = 0;


//======================================================
// 15M CROSSOVER STATE
//
//  1 = Delta above EMA
// -1 = Delta below EMA
//  0 = unknown
//
// Prevents repeated alerts for the same crossover.
//======================================================

let delta15MState = {};


//======================================================
// EMA
//======================================================

function calculateEMA(values, period = 5) {

    if (
        !values ||
        values.length < period
    ) {
        return [];
    }

    const ema = [];

    const multiplier =
        2 / (period + 1);

    // First EMA value
    let previous =
        values
            .slice(0, period)
            .reduce(
                (sum, value) =>
                    sum + value,
                0
            ) / period;

    // Keep array aligned with values
    for (let i = 0; i < period - 1; i++) {
        ema.push(null);
    }

    ema.push(previous);

    // Calculate remaining EMA values
    for (
        let i = period;
        i < values.length;
        i++
    ) {

        previous =
            previous +
            (
                (values[i] - previous)
                * multiplier
            );

        ema.push(previous);
    }

    return ema;
}


//======================================================
// GET CURRENT SESSION CANDLES
//======================================================

function getSessionCandles(candles) {

    if (
        !candles ||
        !candles.length
    )
        return [];

    const latest =
        new Date(
            candles[
                candles.length - 1
            ].openTime
        );

    const sessionStart =
        new Date(latest);

    sessionStart.setUTCHours(
        SESSION_START_HOUR,
        0,
        0,
        0
    );

    if (
        latest <
        sessionStart
    ) {

        sessionStart.setUTCDate(
            sessionStart.getUTCDate() - 1
        );
    }

    return candles.filter(
        candle =>
            candle.openTime >=
            sessionStart.getTime()
    );
}


//======================================================
// SESSION CUMULATIVE DELTA
//
// Green candle = buying volume
// Red candle   = selling volume
//
// Delta resets at session start.
//======================================================

function calculateCumulativeDelta(candles) {

    const sessionCandles =
        getSessionCandles(candles);

    if (
        sessionCandles.length < 10
    )
        return [];

    let delta = 0;

    const cumulative = [];

    for (
        const candle of sessionCandles
    ) {

        if (
            candle.close >
            candle.open
        ) {

            delta += candle.volume;

        }

        else if (
            candle.close <
            candle.open
        ) {

            delta -= candle.volume;
        }

        cumulative.push(delta);
    }

    return cumulative;
}


//======================================================
// OBV
//======================================================

function calculateOBV(candles) {

    if (
        !candles ||
        candles.length < 2
    )
        return 0;

    let obv = 0;

    for (
        let i = 1;
        i < candles.length;
        i++
    ) {

        if (
            candles[i].close >
            candles[i - 1].close
        ) {

            obv +=
                candles[i].volume;
        }

        else if (
            candles[i].close <
            candles[i - 1].close
        ) {

            obv -=
                candles[i].volume;
        }
    }

    return obv;
}


//======================================================
// ATR LOCATION
//======================================================

function getATRLocation(
    price,
    atr,
    dailyHigh,
    dailyLow
) {

    const distLow =
        price - dailyLow;

    const distHigh =
        dailyHigh - price;


    if (
        distLow >= 0 &&
        distLow <= atr * 0.5
    ) {

        return {

            location:
                "NEAR ATR LOW",

            bullishPoints:
                20,

            bearishPoints:
                0
        };
    }


    if (
        distHigh >= 0 &&
        distHigh <= atr * 0.5
    ) {

        return {

            location:
                "NEAR ATR HIGH",

            bullishPoints:
                0,

            bearishPoints:
                20
        };
    }


    return {

        location:
            "MID RANGE",

        bullishPoints:
            0,

        bearishPoints:
            0
    };
}


//======================================================
// DELTA ANALYSIS
//
// Used for the CLOSED 1H candle.
//
// Above EMA = buyers
// Below EMA = sellers
//
// The distance from EMA does NOT matter.
//======================================================

function analyzeDelta(cumulativeDelta) {

    if (
        !cumulativeDelta ||
        cumulativeDelta.length < 6
    ) {
        return null;
    }

    const deltaEMA =
        calculateEMA(
            cumulativeDelta,
            5
        );

    const currentIndex =
        cumulativeDelta.length - 1;

    const previousIndex =
        currentIndex - 1;

    const currentDelta =
        cumulativeDelta[currentIndex];

    const previousDelta =
        cumulativeDelta[previousIndex];

    const currentEMA =
        deltaEMA[currentIndex];

    const previousEMA =
        deltaEMA[previousIndex];

    if (
        currentEMA === null ||
        previousEMA === null
    ) {
        return null;
    }

    const bullishCrossover =
        previousDelta <= previousEMA &&
        currentDelta > currentEMA;

    const bearishCrossover =
        previousDelta >= previousEMA &&
        currentDelta < currentEMA;

    let signal =
        "BALANCED ORDER FLOW";

    let crossover =
        "NO NEW 1H CROSSOVER";

    let bullishPoints = 0;
    let bearishPoints = 0;

    if (
        currentDelta >
        currentEMA
    ) {

        bullishPoints = 40;

        signal =
            "BUYERS IN CONTROL";

    } else if (
        currentDelta <
        currentEMA
    ) {

        bearishPoints = 40;

        signal =
            "SELLERS IN CONTROL";
    }

    if (
        bullishCrossover
    ) {

        crossover =
            "BULLISH CROSSOVER";

    } else if (
        bearishCrossover
    ) {

        crossover =
            "BEARISH CROSSOVER";
    }

    return {

        signal,
        crossover,

        currentDelta,
        previousDelta,

        currentEMA,
        previousEMA,

        bullishPoints,
        bearishPoints
    };
}

//======================================================
// 15M DELTA CROSSOVER
//
// ONLY CLOSED 15M CANDLES ARE USED.
//
// Bullish:
//
// Previous Delta <= Previous EMA
// Current Delta  > Current EMA
//
// Bearish:
//
// Previous Delta >= Previous EMA
// Current Delta  < Current EMA
//
// Distance from EMA does NOT matter.
//======================================================

function analyze15MDelta(
    candles15M
) {

    if (
        !candles15M ||
        candles15M.length < 20
    ) {

        return null;
    }


    // Remove current forming candle

    const closed15M =
        candles15M.slice(0, -1);


    const sessionCandles =
        getSessionCandles(
            closed15M
        );


    // EMA(5) needs at least 5 candles

    if (
        sessionCandles.length < 6
    ) {

        return null;
    }


    let delta = 0;

    const cumulativeDelta = [];


    for (
        const candle of sessionCandles
    ) {

        if (
            candle.close >
            candle.open
        ) {

            delta += candle.volume;

        }

        else if (
            candle.close <
            candle.open
        ) {

            delta -= candle.volume;
        }

        cumulativeDelta.push(delta);
    }


    //==================================================
    // EMA(5)
    //==================================================

    const deltaEMA =
        calculateEMA(
            cumulativeDelta,
            5
        );


    if (
        deltaEMA.length !==
        cumulativeDelta.length
    ) {

        return null;
    }


    //==================================================
    // CURRENT CLOSED 15M CANDLE
    //==================================================

    const currentIndex =
        cumulativeDelta.length - 1;

    const previousIndex =
        currentIndex - 1;


    const currentDelta =
        cumulativeDelta[
            currentIndex
        ];

    const previousDelta =
        cumulativeDelta[
            previousIndex
        ];


    const currentEMA =
        deltaEMA[
            currentIndex
        ];

    const previousEMA =
        deltaEMA[
            previousIndex
        ];


    if (
        currentEMA === null ||
        previousEMA === null
    ) {

        return null;
    }


    //==================================================
    // BULLISH CROSSOVER
    //
    // Previous closed candle:
    // Delta BELOW or AT EMA(5)
    //
    // Current closed candle:
    // Delta ABOVE EMA(5)
    //==================================================

    const bullishCrossover =
        previousDelta <=
            previousEMA &&
        currentDelta >
            currentEMA;


    //==================================================
    // BEARISH CROSSOVER
    //
    // Previous closed candle:
    // Delta ABOVE or AT EMA(5)
    //
    // Current closed candle:
    // Delta BELOW EMA(5)
    //==================================================

    const bearishCrossover =
        previousDelta >=
            previousEMA &&
        currentDelta <
            currentEMA;


    //==================================================
    // CURRENT STATE
    //==================================================

    const state =
        currentDelta >
            currentEMA
            ? 1
            : currentDelta <
              currentEMA
                ? -1
                : 0;


    let crossover =
        "NO NEW 15M CROSSOVER";


    if (
        bullishCrossover
    ) {

        crossover =
            "BULLISH EARLY WARNING";

    }

    else if (
        bearishCrossover
    ) {

        crossover =
            "BEARISH EARLY WARNING";
    }


    return {

        crossover,

        state,

        currentDelta,

        currentEMA,

        previousDelta,

        previousEMA,

        bullishCrossover,

        bearishCrossover
    };
}


//======================================================
// CALCULATE COIN SCORE
//======================================================

async function calculateCoinScore(
    symbol
) {

    try {

        //--------------------------------------------------
        // 1H DATA
        //--------------------------------------------------

        const candles1H =
            await fetchFuturesKlines(
                symbol,
                "1h",
                120
            );


        if (
            !candles1H ||
            candles1H.length < 50
        ) {

            return null;
        }


        // Remove current forming candle

        const closed1H =
            candles1H.slice(0, -1);


        const currentPrice =
            closed1H[
                closed1H.length - 1
            ].close;


        //--------------------------------------------------
        // INITIAL SCORE
        //--------------------------------------------------

        let bullishScore = 0;

        let bearishScore = 0;


        //--------------------------------------------------
        // 1H CUMULATIVE DELTA
        //--------------------------------------------------

        const cumulativeDelta =
            calculateCumulativeDelta(
                closed1H
            );


        const deltaAnalysis =
            analyzeDelta(
                cumulativeDelta
            );


        if (!deltaAnalysis)
            return null;


        bullishScore +=
            deltaAnalysis.bullishPoints;

        bearishScore +=
            deltaAnalysis.bearishPoints;


        //--------------------------------------------------
        // 15M EARLY SIGNAL
        //--------------------------------------------------

        const candles15M =
            await fetchFuturesKlines(
                symbol,
                "15m",
                120
            );


        const earlyDelta =
            analyze15MDelta(
                candles15M
            );


        if (!earlyDelta)
            return null;


        let new15MCrossover =
            false;


        if (
            earlyDelta.crossover ===
            "BULLISH EARLY WARNING"
        ) {

            if (
                delta15MState[symbol] !== 1
            ) {

                new15MCrossover = true;

                delta15MState[symbol] = 1;
            }

        }

        else if (
            earlyDelta.crossover ===
            "BEARISH EARLY WARNING"
        ) {

            if (
                delta15MState[symbol] !== -1
            ) {

                new15MCrossover = true;

                delta15MState[symbol] = -1;
            }

        }

        else {

            // Initialize state without
            // generating an alert.

            if (
                !delta15MState[symbol]
            ) {

                delta15MState[symbol] =
                    earlyDelta.state;
            }
        }


        //--------------------------------------------------
        // 2H STC
        //--------------------------------------------------

        const candles2H =
            await fetchFuturesKlines(
                symbol,
                "2h",
                120
            );


        if (
            !candles2H ||
            candles2H.length < 50
        ) {

            return null;
        }


        const closed2H =
            candles2H.slice(0, -1);


        const closes2H =
            closed2H.map(
                c => c.close
            );


        const stcSeries = [];


        for (
            let i = 0;
            i < closes2H.length;
            i++
        ) {

            const value =
                calculateSTC(

                    closes2H.slice(
                        0,
                        i + 1
                    ),

                    {
                        cycle: 4,
                        fast: 10,
                        slow: 20
                    }
                );


            if (
                value !== null
            ) {

                stcSeries.push(
                    value
                );
            }
        }


        let stcSignal =
            "NEUTRAL";


        if (
            stcSeries.length >= 2
        ) {

            const previous =
                stcSeries[
                    stcSeries.length - 2
                ];

            const current =
                stcSeries[
                    stcSeries.length - 1
                ];


            if (
                current >
                previous
            ) {

                bullishScore += 20;

                stcSignal =
                    `BULLISH (${current.toFixed(1)})`;

            }

            else if (
                current <
                previous
            ) {

                bearishScore += 20;

                stcSignal =
                    `BEARISH (${current.toFixed(1)})`;
            }
        }


        //--------------------------------------------------
        // 2H OBV
        //--------------------------------------------------

        let obvSignal =
            "NEUTRAL";


        const previousOBV =
            calculateOBV(
                closed2H.slice(
                    0,
                    -1
                )
            );


        const currentOBV =
            calculateOBV(
                closed2H
            );


        if (
            currentOBV >
            previousOBV
        ) {

            bullishScore += 20;

            obvSignal =
                "BUYING PRESSURE";

        }

        else if (
            currentOBV <
            previousOBV
        ) {

            bearishScore += 20;

            obvSignal =
                "SELLING PRESSURE";
        }


        //--------------------------------------------------
        // ATR LOCATION
        //--------------------------------------------------

        const atr =
            calculateATR(
                closed1H,
                ATR_PERIOD
            );


        if (!atr)
            return null;


        const daily =
            await fetchFuturesKlines(
                symbol,
                "1d",
                3
            );


        if (
            !daily ||
            daily.length < 2
        ) {

            return null;
        }


        const previousDay =
            daily[
                daily.length - 2
            ];


        const atrLocation =
            getATRLocation(

                currentPrice,

                atr,

                previousDay.high,

                previousDay.low
            );


        bullishScore +=
            atrLocation.bullishPoints;

        bearishScore +=
            atrLocation.bearishPoints;


        //--------------------------------------------------
        // FINAL DIRECTION
        //--------------------------------------------------

        let direction =
            "NEUTRAL";


        if (
            bullishScore >
            bearishScore
        ) {

            direction =
                "BULLISH";

        }

        else if (
            bearishScore >
            bullishScore
        ) {

            direction =
                "BEARISH";
        }


        //--------------------------------------------------
        // RETURN
        //--------------------------------------------------

        return {

            symbol,

            direction,

            bullishScore,

            bearishScore,


            // 1H Delta

            deltaSignal:
                deltaAnalysis.signal,

            deltaCrossover:
                deltaAnalysis.crossover,

            deltaValue:
                deltaAnalysis.currentDelta,

            deltaEMA:
                deltaAnalysis.currentEMA,

            deltaPosition:

                deltaAnalysis.currentDelta >
                deltaAnalysis.currentEMA

                    ? "DELTA ABOVE EMA(10)"

                    : deltaAnalysis.currentDelta <
                      deltaAnalysis.currentEMA

                        ? "DELTA BELOW EMA(10)"

                        : "DELTA AT EMA(10)",


            // 15M Delta

            earlyDeltaCrossover:
                earlyDelta.crossover,

            new15MCrossover,

            earlyDeltaPosition:

                earlyDelta.currentDelta >
                earlyDelta.currentEMA

                    ? "15M DELTA ABOVE EMA(10)"

                    : earlyDelta.currentDelta <
                      earlyDelta.currentEMA

                        ? "15M DELTA BELOW EMA(10)"

                        : "15M DELTA AT EMA(10)",


            // Other indicators

            stcSignal,

            obvSignal,

            atrLocation:
                atrLocation.location
        };

    }

    catch (err) {

        log(
            `Coin Score Error ${symbol}: ${err.message}`
        );

        return null;
    }
}

//======================================================
// GENERATE COIN DEPLOYMENT REPORT
//======================================================

async function generateCoinScoreReport() {

    const results = [];


    //--------------------------------------------------
    // SCAN EVERY SYMBOL
    //--------------------------------------------------

    for (
        const symbol of COIN_LIST
    ) {

        const score =
            await calculateCoinScore(
                symbol
            );

        if (score)
            results.push(score);
    }


    //--------------------------------------------------
    // NEW 1H CONFIRMED CROSSOVERS
    //--------------------------------------------------

    const confirmedBullish =
        results
            .filter(
                coin =>
                    coin.deltaCrossover ===
                    "BULLISH CROSSOVER"
            )
            .sort(
                (a, b) =>
                    b.bullishScore -
                    a.bullishScore
            )
            .slice(0, 7);


    const confirmedBearish =
        results
            .filter(
                coin =>
                    coin.deltaCrossover ===
                    "BEARISH CROSSOVER"
            )
            .sort(
                (a, b) =>
                    b.bearishScore -
                    a.bearishScore
            )
            .slice(0, 7);


    //--------------------------------------------------
    // NEW 15M EARLY WARNINGS
    //--------------------------------------------------

    const earlyBullish =
        results
            .filter(
                coin =>
                    coin.new15MCrossover === true &&
                    coin.earlyDeltaCrossover ===
                    "BULLISH EARLY WARNING"
            )
            .sort(
                (a, b) =>
                    b.bullishScore -
                    a.bullishScore
            )
            .slice(0, 7);


    const earlyBearish =
        results
            .filter(
                coin =>
                    coin.new15MCrossover === true &&
                    coin.earlyDeltaCrossover ===
                    "BEARISH EARLY WARNING"
            )
            .sort(
                (a, b) =>
                    b.bearishScore -
                    a.bearishScore
            )
            .slice(0, 7);


    //--------------------------------------------------
    // BUILD TELEGRAM MESSAGE
    //--------------------------------------------------

    let msg =
`⚡ *COIN DEPLOYMENT REPORT*

`;


    //--------------------------------------------------
    // 15M BULLISH EARLY WARNINGS
    //--------------------------------------------------

    if (
        earlyBullish.length
    ) {

        msg +=
`⚠️ *15M BULLISH EARLY WARNINGS*

`;

        earlyBullish.forEach(
            (coin, index) => {

                msg +=

`${index + 1}. *${coin.symbol}*
⚠️ Early Signal
🟢 Score: ${coin.bullishScore}/100

📊 *Cumulative Delta*
⚠️ 15M BULLISH CROSSOVER
${coin.earlyDeltaPosition}

⏳ *1H Confirmation*
WAITING FOR 1H BULLISH CROSSOVER

⚡ *2H STC*
${coin.stcSignal}

📈 *2H OBV*
${coin.obvSignal}

📍 *ATR Location*
${coin.atrLocation}

`;
            }
        );
    }


    //--------------------------------------------------
    // 15M BEARISH EARLY WARNINGS
    //--------------------------------------------------

    if (
        earlyBearish.length
    ) {

        msg +=
`⚠️ *15M BEARISH EARLY WARNINGS*

`;

        earlyBearish.forEach(
            (coin, index) => {

                msg +=

`${index + 1}. *${coin.symbol}*
⚠️ Early Signal
🔴 Score: ${coin.bearishScore}/100

📊 *Cumulative Delta*
⚠️ 15M BEARISH CROSSOVER
${coin.earlyDeltaPosition}

⏳ *1H Confirmation*
WAITING FOR 1H BEARISH CROSSOVER

⚡ *2H STC*
${coin.stcSignal}

📈 *2H OBV*
${coin.obvSignal}

📍 *ATR Location*
${coin.atrLocation}

`;
            }
        );
    }


    //--------------------------------------------------
    // 1H CONFIRMED BULLISH
    //--------------------------------------------------

    if (
        confirmedBullish.length
    ) {

        msg +=
`🟢 *1H CONFIRMED BULLISH CROSSOVERS*

`;

        confirmedBullish.forEach(
            (coin, index) => {

                msg +=

`${index + 1}. *${coin.symbol}*
🟢 CONFIRMED DEPLOYMENT
🟢 Score: ${coin.bullishScore}/100

📊 *Cumulative Delta*
🟢 1H BULLISH CROSSOVER
${coin.deltaPosition}

⚡ *2H STC*
${coin.stcSignal}

📈 *2H OBV*
${coin.obvSignal}

📍 *ATR Location*
${coin.atrLocation}

`;
            }
        );
    }


    //--------------------------------------------------
    // 1H CONFIRMED BEARISH
    //--------------------------------------------------

    if (
        confirmedBearish.length
    ) {

        msg +=
`🔴 *1H CONFIRMED BEARISH CROSSOVERS*

`;

        confirmedBearish.forEach(
            (coin, index) => {

                msg +=

`${index + 1}. *${coin.symbol}*
🔴 CONFIRMED DEPLOYMENT
🔴 Score: ${coin.bearishScore}/100

📊 *Cumulative Delta*
🔴 1H BEARISH CROSSOVER
${coin.deltaPosition}

⚡ *2H STC*
${coin.stcSignal}

📈 *2H OBV*
${coin.obvSignal}

📍 *ATR Location*
${coin.atrLocation}

`;
            }
        );
    }


    //--------------------------------------------------
    // NO NEW SIGNALS
    //--------------------------------------------------

    if (
        earlyBullish.length === 0 &&
        earlyBearish.length === 0 &&
        confirmedBullish.length === 0 &&
        confirmedBearish.length === 0
    ) {

        msg +=
`⚪ No new Delta crossover signals.`;
    }


    //--------------------------------------------------
    // TELEGRAM
    //--------------------------------------------------

    await sendMessage(msg);
}


//======================================================
// INITIAL REPORT
//======================================================

generateCoinScoreReport();


//======================================================
// RUN EVERY 15 MINUTES
//
// The bot checks every 15 minutes,
// but crossover-state tracking prevents
// duplicate messages.
//======================================================

setInterval(

    generateCoinScoreReport,

    15 * 60 * 1000

);

const ADMIN_CHAT_ID = 7476742687; // <-- Replace with your Telegram chat ID

// Helper function to check admin
function isAdmin(msg) {
  return msg?.chat?.id === ADMIN_CHAT_ID;
}

// --- Telegram commands ---

// Pause bot completely
bot.onText(/\/pause/, async (msg) => {
  if (!isAdmin(msg)) return;
  BOT_PAUSED = true;
  currentCycle = {};
  MANUAL_CYCLE = null;
  await sendMessage("⏸️ Bot paused. Cycles cleared.");
});

// Resume bot after pause
bot.onText(/\/resume/, async (msg) => {
  if (!isAdmin(msg)) return;
  BOT_PAUSED = false;
  await sendMessage("▶️ Bot resumed.");
});

// Close all positions for all users
bot.onText(/\/closeall/, async (msg) => {
  if (!isAdmin(msg)) return;
  for (const [symbol, users] of Object.entries(activePositions)) {
    for (const [userId, pos] of Object.entries(users)) {
      const client = userClients[userId];
      if (!client) continue;
      try {
        if (pos.side === "BUY") await client.futuresMarketSell(symbol, pos.qty);
        else await client.futuresMarketBuy(symbol, pos.qty);
      } catch {}
    }
  }
  activePositions = {};
  await sendMessage("🛑 All positions closed.");
});

// Close a specific symbol for all users
bot.onText(/\/close (.+)/, async (msg, match) => {
  if (!isAdmin(msg)) return;
  const symbol = match[1].toUpperCase().trim();
  if (!activePositions[symbol]) {
    await sendMessage(`⚠️ No active position for *${symbol}*`);
    return;
  }
  for (const [userId, pos] of Object.entries(activePositions[symbol])) {
    const client = userClients[userId];
    if (!client) continue;
    try {
      if (pos.side === "BUY") await client.futuresMarketSell(symbol, pos.qty);
      else await client.futuresMarketBuy(symbol, pos.qty);
      await sendMessage(`🛑 Closed *${symbol}* for User ${userId}`);
    } catch (err) {
      log(`❌ Failed to close ${symbol} for ${userId}: ${err?.message || err}`);
    }
  }
  delete activePositions[symbol];
  await sendMessage(`✅ *${symbol}* fully closed for all users`);
});

// --- Global BULL/BEAR commands ---
bot.onText(/\/setbull$/, async (msg) => {
  if (!isAdmin(msg)) return;
  MANUAL_CYCLE = "BULL";
  currentCycle = {};
  await sendMessage("🟢 MANUAL MODE: All symbols set to *BULLISH* cycle");
});

bot.onText(/\/setbear$/, async (msg) => {
  if (!isAdmin(msg)) return;
  MANUAL_CYCLE = "BEAR";
  currentCycle = {};
  await sendMessage("🔴 MANUAL MODE: All symbols set to *BEARISH* cycle");
});

bot.onText(/\/setauto$/, async (msg) => {
  if (!isAdmin(msg)) return;
  MANUAL_CYCLE = null;
  currentCycle = {};
  await sendMessage("🤖 AUTO MODE: 1H STC detection re-enabled");
});

// --- Per-symbol BULL/BEAR commands ---
bot.onText(/\/setbull (\w+)/, async (msg, match) => {
  if (!isAdmin(msg)) return;
  const symbol = match[1].toUpperCase();
  currentCycle[symbol] = "BULL";
  await sendMessage(`🟢 MANUAL MODE: *${symbol}* set to *BULLISH* cycle`);
});

bot.onText(/\/setbear (\w+)/, async (msg, match) => {
  if (!isAdmin(msg)) return;
  const symbol = match[1].toUpperCase();
  currentCycle[symbol] = "BEAR";
  await sendMessage(`🔴 MANUAL MODE: *${symbol}* set to *BEARISH* cycle`);
});

// --- Per-symbol ACTIVATE/DEACTIVATE commands ---
bot.onText(/\/deactivate (\w+)/, async (msg, match) => {
  if (!isAdmin(msg)) return;
  const symbol = match[1].toUpperCase();
  if (!(symbol in symbolActive)) {
    await sendMessage(`⚠️ Symbol *${symbol}* not recognized.`);
    return;
  }
  symbolActive[symbol] = false;
  await sendMessage(`🚫 *${symbol}* deactivated. No trades will be placed for this symbol.`);
});

bot.onText(/\/activate (\w+)/, async (msg, match) => {
  if (!isAdmin(msg)) return;
  const symbol = match[1].toUpperCase();
  if (!(symbol in symbolActive)) {
    await sendMessage(`⚠️ Symbol *${symbol}* not recognized.`);
    return;
  }
  symbolActive[symbol] = true;
  await sendMessage(`✅ *${symbol}* activated. Trading resumed for this symbol.`);
});

bot.onText(/\/deactivateall/, async (msg) => {
  if (!isAdmin(msg)) return;
  COIN_LIST.forEach((symbol) => {
    symbolActive[symbol] = false;
  });
  await sendMessage("🚫 All symbols deactivated. No trades will be placed for any symbol.");
});

// --- Show all users Futures USDT balances ---
bot.onText(/\/balances$/, async (msg) => {
  if (!isAdmin(msg)) return;

  const clients = Object.entries(userClients).map(([userId, client]) => ({ userId, client }));

  if (!clients.length) {
    await sendMessage("⚠️ No active users.");
    return;
  }

  await sendMessage("📊 Fetching Futures balances...");

  try {
    const results = await Promise.all(
      clients.map(async ({ userId, client }) => {
        try {
          const balances = await client.futuresBalance();
          const usdt = balances.find((b) => b.asset === "USDT");

          const wallet = usdt ? parseFloat(usdt.balance) : 0;
          const available = usdt ? parseFloat(usdt.availableBalance) : 0;
          const unrealized = usdt ? parseFloat(usdt.unrealizedProfit) : 0;

          return { userId, wallet, available, unrealized };
        } catch (err) {
          return { userId, error: true };
        }
      }),
    );

    let totalWallet = 0;
    let totalAvailable = 0;
    let totalUnrealized = 0;

    let report = "💰 *Futures Wallet Summary:*\n\n";

    for (const r of results) {
      if (r.error) {
        report += `User ${r.userId}: ❌ Error fetching balance\n`;
        continue;
      }

      totalWallet += r.wallet;
      totalAvailable += r.available;
      totalUnrealized += r.unrealized;

      report +=
        `User ${r.userId}:\n` +
        `   Wallet: ${r.wallet.toFixed(2)} USDT\n` +
        `   Available: ${r.available.toFixed(2)} USDT\n` +
        `   Unrealized PnL: ${r.unrealized.toFixed(2)} USDT\n\n`;
    }

    report +=
      `📦 *Total Wallet:* ${totalWallet.toFixed(2)} USDT\n` +
      `💵 *Total Available:* ${totalAvailable.toFixed(2)} USDT\n` +
      `📈 *Total Unrealized:* ${totalUnrealized.toFixed(2)} USDT`;

    await sendMessage(report);
  } catch (err) {
    await sendMessage("❌ Failed to fetch balances.");
  }
});

// --- Monthly Report Command ---
bot.onText(/\/monthlyreport/, async (msg) => {
  if (!isAdmin(msg)) return;

  const PROFIT_SHARE_PERCENT = 30; // 30% profit share
  const users = loadUsers().filter((u) => u.active);
  if (!users.length) {
    await sendMessage("⚠️ No active users found for monthly report.");
    return;
  }

  let reportMsg = `📊 *Monthly Trading Report*\n\n`;
  let totalNetProfit = 0;
  let totalProfitShare = 0;

  for (const user of users) {
    if (!monthlyReport[user.id]) monthlyReport[user.id] = {};

    const client = userClients[user.id];
    if (!client) continue;

    try {
      if (!monthlyReport[user.id].startBalance) {
        const balances = await client.futuresBalance();
        const usdtBal = balances.find((b) => b.asset === "USDT");
        monthlyReport[user.id].startBalance = usdtBal ? parseFloat(usdtBal.balance) : 0;
      }

      const balances = await client.futuresBalance();
      const usdtBal = balances.find((b) => b.asset === "USDT");
      const currentBalance = usdtBal ? parseFloat(usdtBal.balance) : 0;

      const startBalance = monthlyReport[user.id].startBalance || 0;
      const netProfit = currentBalance - startBalance;

      const tradesWon = monthlyReport[user.id].tradesWon || 0;
      const tradesLost = monthlyReport[user.id].tradesLost || 0;
      const totalTrades = tradesWon + tradesLost;
      const winRate = totalTrades ? ((tradesWon / totalTrades) * 100).toFixed(1) : "0.0";

      const profitShare = netProfit > 0 ? (netProfit * PROFIT_SHARE_PERCENT) / 100 : 0;

      totalNetProfit += netProfit;
      totalProfitShare += profitShare;

      reportMsg +=
        `👤 User: ${user.name || user.id}\n` +
        `💰 Net Profit/Loss: ${netProfit.toFixed(2)} USDT\n` +
        `🏆 Win Rate: ${winRate}%\n` +
        `📈 Profit Share (${PROFIT_SHARE_PERCENT}%): ${profitShare.toFixed(2)} USDT\n\n`;
    } catch (err) {
      log(`❌ Failed to generate monthly report for ${user.id}: ${err?.message || err}`);
      reportMsg += `👤 User: ${user.name || user.id}\n⚠️ Report unavailable\n\n`;
    }
  }

  reportMsg +=
    `💰 Total Net Profit (all users): ${totalNetProfit.toFixed(2)} USDT\n` +
    `📈 Total Profit Share Owed: ${totalProfitShare.toFixed(2)} USDT`;

  await sendMessage(reportMsg);
});

// =====================================================
// /activecoins
// Shows:
// 1. Coins currently active for trading
// 2. Coins for which the bot has executed trades
// =====================================================

bot.onText(/^\/activecoins$/, async (msg) => {

    try {

        // =================================================
        // CURRENTLY ACTIVE COINS
        // =================================================

        const activeCoins = COIN_LIST.filter(
            symbol => symbolActive[symbol] !== false
        );


        // =================================================
        // COINS WITH EXECUTED TRADES
        // =================================================

        const tradedCoins = Object.keys(
            symbolCooldowns || {}
        ).filter(symbol =>
            symbolCooldowns[symbol] &&
            COIN_LIST.includes(symbol)
        );


        // =================================================
        // COMBINE BOTH LISTS
        // Remove duplicates
        // =================================================

        const allCoins = [
            ...new Set([
                ...activeCoins,
                ...tradedCoins
            ])
        ];


        // =================================================
        // NO COINS
        // =================================================

        if (!allCoins.length) {

            await sendMessage(
                "⚪ *BOT TRADING STATUS*\n\n" +
                "No active or traded coins found."
            );

            return;
        }


        // =================================================
        // BUILD MESSAGE
        // =================================================

        let message =
`⚡ *BOT TRADING STATUS*

`;


        allCoins.forEach((symbol, index) => {

            const isActive =
                symbolActive[symbol] !== false;

            const hasTraded =
                tradedCoins.includes(symbol);


            let status;


            // Active AND has executed a trade

            if (
                isActive &&
                hasTraded
            ) {

                status =
                    "🟢 ACTIVE + TRADED";

            }


            // Active but no trade yet

            else if (
                isActive
            ) {

                status =
                    "🟢 ACTIVE — NO TRADE YET";

            }


            // Has traded but currently inactive

            else if (
                hasTraded
            ) {

                status =
                    "🔵 TRADED";

            }


            message +=
`${index + 1}. *${symbol}* — ${status}\n`;

        });


        // =================================================
        // SUMMARY
        // =================================================

        message +=
`\n📊 Total Coins: *${allCoins.length}*`;

        message +=
`\n🟢 Active: *${activeCoins.length}*`;

        message +=
`\n🔵 Traded: *${tradedCoins.length}*`;


        // =================================================
        // SEND TELEGRAM MESSAGE
        // =================================================

        await sendMessage(message);


    } catch (err) {

        log(
            `❌ /activecoins error: ${
                err?.message || err
            }`
        );

    }

});