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
// COIN ORDER FLOW REPORT
//
// FINAL VERSION
//
// COMPONENTS
//
// • 30M Cumulative Delta
// • 30M Order Flow State
// • 4H Trend-Reset ATR Structure
// • 4H Active Support / Resistance
// • Top 7 Order-Flow Coins
// • 0-100 Trend / Order Flow Score
//
// REPORT INTERVAL = 30 MINUTES
//
// PURPOSE:
//
// INFORMATIONAL ONLY.
//
// 30M = CURRENT ORDER FLOW
// 4H  = TREND / ATR STRUCTURE
//======================================================


//======================================================
// 4H TREND SETTINGS
//
// MATCHES YOUR CHART:
//
// Base EMA Length = 20
// ATR Length      = 14
// ATR Multiplier  = 1
// Source          = Close
//======================================================

const TREND_EMA_LENGTH = 20;

const TREND_ATR_LENGTH = 14;

const TREND_ATR_MULTIPLIER = 1;


//======================================================
// CUMULATIVE DELTA
//======================================================

function calculateCumulativeDelta(candles) {

    if (
        !candles ||
        candles.length < 2
    ) {

        return [];

    }

    let delta = 0;

    const cumulativeDelta = [];

    for (
        const candle of candles
    ) {

        const open =
            Number(candle.open);

        const close =
            Number(candle.close);

        const volume =
            Number(candle.volume);

        if (
            !Number.isFinite(open) ||
            !Number.isFinite(close) ||
            !Number.isFinite(volume)
        ) {

            continue;

        }

        if (
            close > open
        ) {

            delta += volume;

        }

        else if (
            close < open
        ) {

            delta -= volume;

        }

        cumulativeDelta.push(
            delta
        );

    }

    return cumulativeDelta;

}


//======================================================
// ANALYZE DELTA
//======================================================

function analyzeDelta(cumulativeDelta) {

    if (
        !cumulativeDelta ||
        cumulativeDelta.length < 2
    ) {

        return null;

    }

    const currentIndex =
        cumulativeDelta.length - 1;

    const previousIndex =
        currentIndex - 1;

    const currentDelta =
        Number(
            cumulativeDelta[
                currentIndex
            ]
        );

    const previousDelta =
        Number(
            cumulativeDelta[
                previousIndex
            ]
        );

    if (
        !Number.isFinite(currentDelta) ||
        !Number.isFinite(previousDelta)
    ) {

        return null;

    }

    const deltaChange =
        currentDelta -
        previousDelta;

    let trend =
        "FLAT";

    let control =
        "BALANCED";


    //==================================================
    // POSITIVE DELTA
    //==================================================

    if (
        currentDelta > 0
    ) {

        control =
            "BUYERS IN CONTROL";

        if (
            currentDelta >
            previousDelta
        ) {

            trend =
                "HIGHER POSITIVE";

        }

        else if (
            currentDelta <
            previousDelta
        ) {

            trend =
                "LOWER POSITIVE";

        }

        else {

            trend =
                "POSITIVE / FLAT";

        }

    }


    //==================================================
    // NEGATIVE DELTA
    //==================================================

    else if (
        currentDelta < 0
    ) {

        control =
            "SELLERS IN CONTROL";

        if (
            currentDelta <
            previousDelta
        ) {

            trend =
                "LOWER NEGATIVE";

        }

        else if (
            currentDelta >
            previousDelta
        ) {

            trend =
                "HIGHER NEGATIVE";

        }

        else {

            trend =
                "NEGATIVE / FLAT";

        }

    }


    //==================================================
    // ZERO
    //==================================================

    else {

        control =
            "BALANCED";

        trend =
            "AT ZERO";

    }

    return {

        currentDelta,

        previousDelta,

        deltaChange,

        trend,

        control

    };

}


//======================================================
// EMA VALUE
//
// Standard EMA calculation.
//======================================================

function calculateEMAValue(
    candles,
    period
) {

    if (
        !candles ||
        candles.length < period
    ) {

        return null;

    }

    let sum = 0;

    for (
        let i = 0;
        i < period;
        i++
    ) {

        const close =
            Number(
                candles[i].close
            );

        if (
            !Number.isFinite(close)
        ) {

            return null;

        }

        sum += close;

    }

    let ema =
        sum / period;

    const multiplier =
        2 /
        (period + 1);

    for (
        let i = period;
        i < candles.length;
        i++
    ) {

        const close =
            Number(
                candles[i].close
            );

        if (
            !Number.isFinite(close)
        ) {

            continue;

        }

        ema =
            (
                close -
                ema
            ) *
            multiplier +
            ema;

    }

    return ema;

}


//======================================================
// ATR VALUE
//
// Wilder-style ATR calculation.
//======================================================

function calculateATRValue(
    candles,
    period
) {

    if (
        !candles ||
        candles.length <= period
    ) {

        return null;

    }

    const trueRanges = [];

    for (
        let i = 0;
        i < candles.length;
        i++
    ) {

        const high =
            Number(
                candles[i].high
            );

        const low =
            Number(
                candles[i].low
            );

        if (
            !Number.isFinite(high) ||
            !Number.isFinite(low)
        ) {

            return null;

        }

        if (
            i === 0
        ) {

            trueRanges.push(
                high - low
            );

            continue;

        }

        const previousClose =
            Number(
                candles[
                    i - 1
                ].close
            );

        if (
            !Number.isFinite(
                previousClose
            )
        ) {

            return null;

        }

        const range1 =
            high - low;

        const range2 =
            Math.abs(
                high -
                previousClose
            );

        const range3 =
            Math.abs(
                low -
                previousClose
            );

        trueRanges.push(
            Math.max(
                range1,
                range2,
                range3
            )
        );

    }

    if (
        trueRanges.length <= period
    ) {

        return null;

    }

    let atr = 0;

    // Initial ATR

    for (
        let i = 1;
        i <= period;
        i++
    ) {

        atr +=
            trueRanges[i];

    }

    atr /=
        period;

    // Wilder smoothing

    for (
        let i = period + 1;
        i < trueRanges.length;
        i++
    ) {

        atr =
            (
                (
                    atr *
                    (period - 1)
                ) +
                trueRanges[i]
            ) /
            period;

    }

    return atr;

}


//======================================================
// 4H TREND / ATR STRUCTURE
//
// EXACT LOGIC:
//
// If a COMPLETED 4H candle closes above
// EMA20 + ATR14 × 1:
//
//     BULLISH TREND
//     LOWER BAND = SUPPORT
//
// If a COMPLETED 4H candle closes below
// EMA20 - ATR14 × 1:
//
//     BEARISH TREND
//     UPPER BAND = RESISTANCE
//
// Otherwise the previous trend state remains.
//
// IMPORTANT:
//
// This function works from historical 4H data.
// It does NOT require the bot to wait four hours
// after starting.
//======================================================

function calculate4HTrendATR(
    candles
) {

    if (
        !candles ||
        candles.length <
        TREND_EMA_LENGTH + 2
    ) {

        return null;

    }

    let trendState =
        0;

    let lastBreakType =
        "NONE";

    let lastBreakIndex =
        -1;

    let activeUpperBand =
        null;

    let activeLowerBand =
        null;


    //==================================================
    // WALK THROUGH COMPLETED 4H CANDLES
    //==================================================

    for (
        let i =
            TREND_EMA_LENGTH;
        i < candles.length;
        i++
    ) {

        const availableCandles =
            candles.slice(
                0,
                i + 1
            );

        const ema =
            calculateEMAValue(
                availableCandles,
                TREND_EMA_LENGTH
            );

        const atr =
            calculateATRValue(
                availableCandles,
                TREND_ATR_LENGTH
            );

        if (
            ema === null ||
            atr === null
        ) {

            continue;

        }

        const upperBand =
            ema +
            (
                atr *
                TREND_ATR_MULTIPLIER
            );

        const lowerBand =
            ema -
            (
                atr *
                TREND_ATR_MULTIPLIER
            );

        const close =
            Number(
                candles[i].close
            );

        if (
            !Number.isFinite(close)
        ) {

            continue;

        }

        const previousTrend =
            trendState;


        //================================================
        // UPPER BAND BREAK
        //================================================

        if (
            close >
            upperBand
        ) {

            trendState =
                1;

        }


        //================================================
        // LOWER BAND BREAK
        //================================================

        else if (
            close <
            lowerBand
        ) {

            trendState =
                -1;

        }


        //================================================
        // NEW BULLISH TREND
        //================================================

        if (
            trendState === 1 &&
            previousTrend !== 1
        ) {

            lastBreakType =
                "UPPER BAND BREAK";

            lastBreakIndex =
                i;

        }


        //================================================
        // NEW BEARISH TREND
        //================================================

        if (
            trendState === -1 &&
            previousTrend !== -1
        ) {

            lastBreakType =
                "LOWER BAND BREAK";

            lastBreakIndex =
                i;

        }

        activeUpperBand =
            upperBand;

        activeLowerBand =
            lowerBand;

    }


    //==================================================
    // NO TREND YET
    //==================================================

    if (
        trendState === 0
    ) {

        return {

            trend:
                "NEUTRAL",

            trendState:
                0,

            upperBand:
                activeUpperBand,

            lowerBand:
                activeLowerBand,

            activeLevel:
                null,

            activeType:
                "NONE",

            lastBreak:
                "NONE",

            lastBreakIndex

        };

    }


    //==================================================
    // BULLISH
    //==================================================

    if (
        trendState === 1
    ) {

        return {

            trend:
                "BULLISH TREND",

            trendState:
                1,

            upperBand:
                activeUpperBand,

            lowerBand:
                activeLowerBand,

            activeLevel:
                activeLowerBand,

            activeType:
                "SUPPORT",

            lastBreak:
                lastBreakType,

            lastBreakIndex

        };

    }


    //==================================================
    // BEARISH
    //==================================================

    return {

        trend:
            "BEARISH TREND",

        trendState:
            -1,

        upperBand:
            activeUpperBand,

        lowerBand:
            activeLowerBand,

        activeLevel:
            activeUpperBand,

        activeType:
            "RESISTANCE",

        lastBreak:
            lastBreakType,

        lastBreakIndex

    };

}


//======================================================
// CALCULATE COIN SCORE
//
// SCORING:
//
// BULLISH 4H = 50 POINTS
//
// BULLISH 4H + HIGHER POSITIVE = 100
// BULLISH 4H + LOWER POSITIVE  = 75
// BULLISH 4H + CONFLICTING/NEUTRAL = 50
//
// BEARISH 4H = 50 POINTS
//
// BEARISH 4H + LOWER NEGATIVE = 100
// BEARISH 4H + HIGHER NEGATIVE = 75
// BEARISH 4H + CONFLICTING/NEUTRAL = 50
//
// CONFLICTING 30M CONDITIONS RECEIVE 0 POINTS.
//======================================================

function calculateAlignmentScore(
    trend4H,
    delta30M
) {

    let score =
        0;

    let trendPoints =
        0;

    let orderFlowPoints =
        0;


    //==================================================
    // BULLISH 4H
    //==================================================

    if (
        trend4H &&
        trend4H.trendState === 1
    ) {

        trendPoints =
            50;


        if (
            delta30M &&
            delta30M.trend ===
            "HIGHER POSITIVE"
        ) {

            orderFlowPoints =
                50;

        }

        else if (
            delta30M &&
            delta30M.trend ===
            "LOWER POSITIVE"
        ) {

            orderFlowPoints =
                25;

        }

    }


    //==================================================
    // BEARISH 4H
    //==================================================

    else if (
        trend4H &&
        trend4H.trendState === -1
    ) {

        trendPoints =
            50;


        if (
            delta30M &&
            delta30M.trend ===
            "LOWER NEGATIVE"
        ) {

            orderFlowPoints =
                50;

        }

        else if (
            delta30M &&
            delta30M.trend ===
            "HIGHER NEGATIVE"
        ) {

            orderFlowPoints =
                25;

        }

    }


    score =
        trendPoints +
        orderFlowPoints;


    return {

        score,

        trendPoints,

        orderFlowPoints

    };

}


//======================================================
// CALCULATE COIN ORDER FLOW
//======================================================

async function calculateCoinScore(
    symbol
) {

    try {

        let delta30M =
            null;

        let trend4H =
            null;


        //================================================
        // 30M DATA
        //================================================

        const candles30M =
            await fetchFuturesKlines(
                symbol,
                "30m",
                120
            );

        if (
            !candles30M ||
            candles30M.length < 3
        ) {

            log(
                `30M data unavailable for ${symbol}`
            );

            return null;

        }


        // Remove currently forming 30M candle.

        const closed30M =
            candles30M.slice(
                0,
                -1
            );

        if (
            closed30M.length < 2
        ) {

            return null;

        }

        const delta30MSeries =
            calculateCumulativeDelta(
                closed30M
            );

        delta30M =
            analyzeDelta(
                delta30MSeries
            );

        if (!delta30M) {

            log(
                `30M Delta unavailable for ${symbol}`
            );

            return null;

        }


        //================================================
        // 4H DATA
        //================================================

        const candles4H =
            await fetchFuturesKlines(
                symbol,
                "4h",
                120
            );

        if (
            candles4H &&
            candles4H.length >=
            TREND_EMA_LENGTH + 2
        ) {

            const closed4H =
                candles4H.slice(
                    0,
                    -1
                );

            trend4H =
                calculate4HTrendATR(
                    closed4H
                );

            if (!trend4H) {

                log(
                    `4H Trend/ATR calculation unavailable for ${symbol}. Candles: ${closed4H.length}`
                );

            }

        }

        else {

            log(
                `4H data unavailable for ${symbol}. Candles received: ${
                    candles4H
                        ? candles4H.length
                        : 0
                }`
            );

        }


        //================================================
        // ALIGNMENT SCORE
        //================================================

        const alignmentScore =
            calculateAlignmentScore(
                trend4H,
                delta30M
            );


        //================================================
        // TOP 7 TIE-BREAKER
        //
        // Existing 30M Delta movement remains available
        // for ranking coins with identical scores.
        //================================================

        const orderFlowStrength =
            Math.abs(
                delta30M.deltaChange
            );


        //================================================
        // RETURN
        //================================================

        return {

            symbol,

            delta30M,

            trend4H,

            alignmentScore,

            orderFlowStrength

        };

    }

    catch (err) {

        log(
            `Order Flow Error ${symbol}: ${
                err.message
            }`
        );

        return null;

    }

}

//======================================================
// GENERATE COIN ORDER FLOW REPORT
//
// INFORMATIONAL ONLY.
//
// Top 7 ranking:
//
// 1. Alignment Score
// 2. 30M Delta Movement as tie-breaker
//
// 4H Trend = 50 points
// 30M aligned pressure = 25 or 50 points
// Conflicting pressure = 0 points
//======================================================

async function generateCoinScoreReport() {

    try {

        const results = [];


        //================================================
        // SCAN ALL COINS
        //================================================

        for (
            const symbol of COIN_LIST
        ) {

            try {

                const result =
                    await calculateCoinScore(
                        symbol
                    );

                if (result) {

                    results.push(
                        result
                    );

                }

            }

            catch (err) {

                log(
                    `Scanner Error ${symbol}: ${
                        err.message
                    }`
                );

            }

        }


        //================================================
        // TOP 7
        //
        // Highest score first.
        // 30M delta movement breaks ties.
        //================================================

        const top7 =
            results
                .sort(
                    (a, b) => {

                        if (
                            b.alignmentScore.score !==
                            a.alignmentScore.score
                        ) {

                            return (
                                b.alignmentScore.score -
                                a.alignmentScore.score
                            );

                        }

                        return (
                            b.orderFlowStrength -
                            a.orderFlowStrength
                        );

                    }
                )
                .slice(
                    0,
                    7
                );


        //================================================
        // MESSAGE HEADER
        //================================================

        let msg =
`⚡ *COIN ORDER FLOW REPORT*
🕐 30-MINUTE UPDATE

⚡ 30M = CURRENT ORDER FLOW
📊 4H = TREND / ATR STRUCTURE
🎯 SCORE = 4H TREND + ALIGNED 30M PRESSURE

`;


        //================================================
        // NO DATA
        //================================================

        if (
            top7.length === 0
        ) {

            msg +=
`⚪ *NO DATA AVAILABLE*

The scanner is still monitoring all coins.

`;

        }


        //================================================
        // TOP 7 COINS
        //================================================

        else {

            msg +=
`🏆 *TOP 7 ORDER-FLOW COINS*

`;

            top7.forEach(
                (
                    coin,
                    index
                ) => {

                    const d30 =
                        coin.delta30M;

                    const t4 =
                        coin.trend4H;

                    const score =
                        coin.alignmentScore;


                    //================================================
                    // 30M CONTROL
                    //================================================

                    let flowIcon =
                        "⚪";

                    let flowControl =
                        "BALANCED";

                    if (
                        d30.currentDelta > 0
                    ) {

                        flowIcon =
                            "🟢";

                        flowControl =
                            "BUYERS IN CONTROL";

                    }

                    else if (
                        d30.currentDelta < 0
                    ) {

                        flowIcon =
                            "🔴";

                        flowControl =
                            "SELLERS IN CONTROL";

                    }


                    //================================================
                    // SCORE DISPLAY
                    //================================================

                    let scoreIcon =
                        "⚪";

                    if (
                        score.score === 100
                    ) {

                        scoreIcon =
                            "🟢";

                    }

                    else if (
                        score.score === 75
                    ) {

                        scoreIcon =
                            "🟡";

                    }

                    else if (
                        score.score === 50
                    ) {

                        scoreIcon =
                            "🟠";

                    }


                    //================================================
                    // COIN
                    //================================================

                    msg +=

`${index + 1}. *${coin.symbol}*

🎯 *SCORE: ${score.score}/100*
${scoreIcon} 4H Trend: +${score.trendPoints}
⚡ 30M Aligned Pressure: +${score.orderFlowPoints}

`;


                    //================================================
                    // 30M ORDER FLOW
                    //================================================

                    msg +=

`⚡ *30M ORDER FLOW*
${flowIcon} ${flowControl}
Delta: ${d30.currentDelta.toFixed(0)}
${d30.trend}

`;


                    //================================================
                    // 4H TREND / ATR
                    //================================================

                    msg +=
`📊 *4H TREND / ATR*
`;

                    if (
                        !t4
                    ) {

                        msg +=
`⚪ DATA UNAVAILABLE

`;

                    }

                    else if (
                        t4.trendState === 1
                    ) {

                        msg +=

`🟢 *BULLISH TREND*
Price closed ABOVE the upper ATR band.

📍 *ACTIVE SUPPORT*
Lower ATR Band: ${
    t4.lowerBand !== null
        ? t4.lowerBand.toFixed(6)
        : "N/A"
}

`;

                    }

                    else if (
                        t4.trendState === -1
                    ) {

                        msg +=

`🔴 *BEARISH TREND*
Price closed BELOW the lower ATR band.

📍 *ACTIVE RESISTANCE*
Upper ATR Band: ${
    t4.upperBand !== null
        ? t4.upperBand.toFixed(6)
        : "N/A"
}

`;

                    }

                    else {

                        msg +=

`⚪ *NEUTRAL*
No confirmed ATR-band breakout.

`;

                    }


                    //================================================
                    // SEPARATOR
                    //================================================

                    if (
                        index <
                        top7.length - 1
                    ) {

                        msg +=
`━━━━━━━━━━━━━━━━━━━━

`;

                    }

                }
            );

        }


        //================================================
        // GUIDE
        //================================================

        msg +=

`
━━━━━━━━━━━━━━━━━━━━

📌 *ORDER FLOW SCORE GUIDE*

🎯 *100/100*
Strong 4H trend +
strong aligned 30M pressure.

🎯 *75/100*
4H trend +
weaker aligned 30M pressure.

🎯 *50/100*
4H trend exists +
30M pressure is conflicting or neutral.

⚠️ Conflicting 30M pressure receives
0 additional points.


⚡ *30M ORDER FLOW*

🟢 Positive Delta
BUYERS IN CONTROL

🔴 Negative Delta
SELLERS IN CONTROL

📈 Higher Positive
Buying pressure strengthening

📉 Lower Positive
Buying pressure weakening

📈 Higher Negative
Selling pressure weakening

📉 Lower Negative
Selling pressure strengthening


📊 *4H TREND / ATR*

🟢 *BULLISH TREND*
Price closed above the upper ATR band.

📍 Lower ATR Band
ACTIVE SUPPORT.


🔴 *BEARISH TREND*
Price closed below the lower ATR band.

📍 Upper ATR Band
ACTIVE RESISTANCE.


⚪ *NEUTRAL*
No confirmed ATR-band breakout.


⚠️ *INFORMATIONAL ONLY*
This report is not an automatic trading signal.
`;


        //================================================
        // SEND TELEGRAM
        //================================================

        await sendMessage(
            msg
        );

    }

    catch (err) {

        log(
            `Order Flow Report Error: ${
                err.message
            }`
        );

    }

}


//======================================================
// INITIAL REPORT
//======================================================

generateCoinScoreReport();


//======================================================
// RUN EVERY 30 MINUTES
//======================================================

setInterval(

    generateCoinScoreReport,

    30 * 60 * 1000

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