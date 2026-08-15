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
// • 3H Cumulative Delta
// • 30M Cumulative Delta
// • 3H / 30M Delta Alignment
// • 2H STC
// • 2H OBV
// • ATR Location
//
// EMA CROSSOVER REMOVED
// 15M DELTA REMOVED
//
// REPORT INTERVAL = 30 MINUTES
//
// Maximum Score = 100
//======================================================


//======================================================
// SESSION SETTINGS
//======================================================

// 0 = 00:00 UTC
const SESSION_START_HOUR = 0;


//======================================================
// GET CURRENT SESSION CANDLES
//======================================================

function getSessionCandles(candles) {

    if (
        !candles ||
        !candles.length
    ) {

        return [];

    }

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
// Green candle = positive volume
// Red candle   = negative volume
//
// Delta resets at session start.
//======================================================

function calculateCumulativeDelta(
    candles
) {

    const sessionCandles =
        getSessionCandles(
            candles
        );


    if (
        sessionCandles.length < 3
    ) {

        return [];

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

            delta +=
                candle.volume;

        }

        else if (
            candle.close <
            candle.open
        ) {

            delta -=
                candle.volume;

        }


        cumulativeDelta.push(
            delta
        );

    }


    return cumulativeDelta;

}


//======================================================
// ANALYZE DELTA
//
// This does NOT use EMA.
//
// It determines:
//
// 1. Current delta
// 2. Previous delta
// 3. Whether delta is becoming
//    more positive
// 4. Whether delta is becoming
//    less positive
// 5. Whether delta is becoming
//    more negative
// 6. Whether delta is becoming
//    less negative
//
//======================================================

function analyzeDelta(
    cumulativeDelta
) {

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
        cumulativeDelta[
            currentIndex
        ];


    const previousDelta =
        cumulativeDelta[
            previousIndex
        ];


    const deltaChange =
        currentDelta -
        previousDelta;


    let trend =
        "FLAT";


    let pressure =
        "BALANCED";


    let bullishPoints = 0;

    let bearishPoints = 0;


    //==================================================
    // POSITIVE DELTA
    //==================================================

    if (
        currentDelta > 0
    ) {

        if (
            currentDelta >
            previousDelta
        ) {

            trend =
                "HIGHER POSITIVE";

            pressure =
                "BUYING STRENGTHENING";

            bullishPoints = 20;

        }

        else if (
            currentDelta <
            previousDelta
        ) {

            trend =
                "LOWER POSITIVE";

            pressure =
                "BUYING WEAKENING";

            bullishPoints = 10;

        }

        else {

            trend =
                "POSITIVE / FLAT";

            pressure =
                "BUYING STABLE";

            bullishPoints = 10;

        }

    }


    //==================================================
    // NEGATIVE DELTA
    //==================================================

    else if (
        currentDelta < 0
    ) {

        if (
            currentDelta <
            previousDelta
        ) {

            trend =
                "LOWER NEGATIVE";

            pressure =
                "SELLING STRENGTHENING";

            bearishPoints = 20;

        }

        else if (
            currentDelta >
            previousDelta
        ) {

            trend =
                "HIGHER NEGATIVE";

            pressure =
                "SELLING WEAKENING";

            bearishPoints = 10;

        }

        else {

            trend =
                "NEGATIVE / FLAT";

            pressure =
                "SELLING STABLE";

            bearishPoints = 10;

        }

    }


    //==================================================
    // ZERO / BALANCED
    //==================================================

    else {

        trend =
            "AT ZERO";

        pressure =
            "BALANCED";

    }


    return {

        currentDelta,

        previousDelta,

        deltaChange,

        trend,

        pressure,

        bullishPoints,

        bearishPoints

    };

}


//======================================================
// DELTA ALIGNMENT
//
// 3H = BROADER CONTEXT
// 30M = SHORTER-TERM PRESSURE
//
// IMPORTANT:
// Raw delta values are NOT compared directly.
//
// We compare the direction of Delta movement.
//======================================================

function getDeltaAlignment(
    delta3H,
    delta30M
) {

    if (
        !delta3H ||
        !delta30M
    ) {

        return {

            alignment:
                "INSUFFICIENT DATA",

            bullishPoints: 0,

            bearishPoints: 0

        };

    }


    const bullish3H =
        delta3H.deltaChange > 0;


    const bearish3H =
        delta3H.deltaChange < 0;


    const bullish30M =
        delta30M.deltaChange > 0;


    const bearish30M =
        delta30M.deltaChange < 0;


    //==================================================
    // STRONG BULLISH ALIGNMENT
    //==================================================

    if (
        bullish3H &&
        bullish30M
    ) {

        return {

            alignment:
                "STRONG BULLISH ALIGNMENT",

            bullishPoints: 20,

            bearishPoints: 0

        };

    }


    //==================================================
    // STRONG BEARISH ALIGNMENT
    //==================================================

    if (
        bearish3H &&
        bearish30M
    ) {

        return {

            alignment:
                "STRONG BEARISH ALIGNMENT",

            bullishPoints: 0,

            bearishPoints: 20

        };

    }


    //==================================================
    // 3H BULLISH / 30M BEARISH
    //==================================================

    if (
        bullish3H &&
        bearish30M
    ) {

        return {

            alignment:
                "30M BEARISH / 3H BULLISH",

            bullishPoints: 10,

            bearishPoints: 10

        };

    }


    //==================================================
    // 3H BEARISH / 30M BULLISH
    //==================================================

    if (
        bearish3H &&
        bullish30M
    ) {

        return {

            alignment:
                "30M BULLISH / 3H BEARISH",

            bullishPoints: 10,

            bearishPoints: 10

        };

    }


    return {

        alignment:
            "MIXED / FLAT",

        bullishPoints: 0,

        bearishPoints: 0

    };

}


//======================================================
// OBV
//======================================================

function calculateOBV(
    candles
) {

    if (
        !candles ||
        candles.length < 2
    ) {

        return 0;

    }


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
        price -
        dailyLow;


    const distHigh =
        dailyHigh -
        price;


    //==================================================
    // NEAR ATR LOW
    //==================================================

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


    //==================================================
    // NEAR ATR HIGH
    //==================================================

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
// CALCULATE COIN SCORE
//
// INFORMATIONAL ORDER-FLOW MODEL
//
// 3H Delta  = broader order-flow context
// 30M Delta = short-term order-flow pressure
//
// IMPORTANT:
//
// • 3H/30M alignment is NOT required
// • Delta crossover is NOT required
// • A coin is NOT rejected because 3H/30M disagree
// • STC/OBV/ATR are supporting information
// • Score is used only for ranking
//======================================================

async function calculateCoinScore(
    symbol
) {

    try {

        //================================================
        // INITIAL VALUES
        //================================================

        let bullishScore = 0;

        let bearishScore = 0;


        let delta30M = null;

        let delta3H = null;

        let deltaAlignment = {

            alignment:
                "INSUFFICIENT DATA",

            bullishPoints: 0,

            bearishPoints: 0

        };


        let stcSignal =
            "DATA UNAVAILABLE";


        let obvSignal =
            "DATA UNAVAILABLE";


        let atrLocation = {

            location:
                "DATA UNAVAILABLE",

            bullishPoints: 0,

            bearishPoints: 0

        };


        let currentPrice =
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
            candles30M &&
            candles30M.length >= 20
        ) {

            const closed30M =
                candles30M.slice(
                    0,
                    -1
                );


            currentPrice =
                closed30M[
                    closed30M.length - 1
                ].close;


            const delta30MSeries =
                calculateCumulativeDelta(
                    closed30M
                );


            delta30M =
                analyzeDelta(
                    delta30MSeries
                );


            if (delta30M) {

                bullishScore +=
                    delta30M.bullishPoints;

                bearishScore +=
                    delta30M.bearishPoints;

            }

        }


        //================================================
        // 3H DATA
        //================================================

        const candles3H =
            await fetchFuturesKlines(
                symbol,
                "3h",
                120
            );


        if (
            candles3H &&
            candles3H.length >= 20
        ) {

            const closed3H =
                candles3H.slice(
                    0,
                    -1
                );


            const delta3HSeries =
                calculateCumulativeDelta(
                    closed3H
                );


            delta3H =
                analyzeDelta(
                    delta3HSeries
                );


            if (delta3H) {

                //========================================
                // 3H IS BROADER CONTEXT
                //
                // Give it less weight than 30M.
                //========================================

                bullishScore +=
                    Math.floor(
                        delta3H.bullishPoints / 2
                    );

                bearishScore +=
                    Math.floor(
                        delta3H.bearishPoints / 2
                    );

            }

        }


        //================================================
        // DELTA RELATIONSHIP
        //
        // INFORMATIONAL ONLY.
        //
        // Alignment is NEVER used as a filter.
        //================================================

        if (
            delta3H &&
            delta30M
        ) {

            deltaAlignment =
                getDeltaAlignment(
                    delta3H,
                    delta30M
                );


            bullishScore +=
                deltaAlignment.bullishPoints;

            bearishScore +=
                deltaAlignment.bearishPoints;

        }


        //================================================
        // 2H STC
        //
        // SUPPORTING MOMENTUM INFORMATION
        //================================================

        const candles2H =
            await fetchFuturesKlines(
                symbol,
                "2h",
                120
            );


        if (
            candles2H &&
            candles2H.length >= 50
        ) {

            const closed2H =
                candles2H.slice(
                    0,
                    -1
                );


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

                else {

                    stcSignal =
                        `FLAT (${current.toFixed(1)})`;

                }

            }

        }


        //================================================
        // 2H OBV
        //================================================

        if (
            candles2H &&
            candles2H.length >= 50
        ) {

            const closed2H =
                candles2H.slice(
                    0,
                    -1
                );


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

            else {

                obvSignal =
                    "BALANCED";

            }

        }


        //================================================
        // ATR LOCATION
        //================================================

        if (
            candles30M &&
            candles30M.length >= 20 &&
            currentPrice !== null
        ) {

            const closed30M =
                candles30M.slice(
                    0,
                    -1
                );


            const atr =
                calculateATR(
                    closed30M,
                    ATR_PERIOD
                );


            if (atr) {

                const daily =
                    await fetchFuturesKlines(
                        symbol,
                        "1d",
                        3
                    );


                if (
                    daily &&
                    daily.length >= 2
                ) {

                    const previousDay =
                        daily[
                            daily.length - 2
                        ];


                    atrLocation =
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

                }

            }

        }


        //================================================
        // FINAL DIRECTION
        //
        // ONLY FOR REPORT ORGANIZATION.
        //
        // It is NOT a trading signal.
        //================================================

        let direction =
            "BALANCED";


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


        //================================================
        // RETURN
        //================================================

        return {

            symbol,

            direction,

            bullishScore,

            bearishScore,

            currentPrice,

            delta3H,

            delta30M,

            deltaAlignment,

            stcSignal,

            obvSignal,

            atrLocation:
                atrLocation.location

        };

    }

    catch (err) {

        log(
            `Coin Score Error ${symbol}: ${
                err.message
            }`
        );


        // IMPORTANT:
        // One coin failing must NOT stop
        // the entire scanner.

        return null;

    }

}

//======================================================
// GENERATE COIN DEPLOYMENT REPORT
//
// IMPORTANT:
//
// This report is INFORMATIONAL.
//
// It does NOT require:
// • 3H and 30M Delta alignment
// • A Delta crossover
// • A specific Delta direction
//
// The purpose is to show the current order flow
// across the scanned coins so the trader can make
// an informed decision.
//
// 3H Delta  = broader order-flow context
// 30M Delta = shorter-term order-flow pressure
//======================================================

async function generateCoinScoreReport() {

    const results = [];


    //==================================================
    // SCAN ALL COINS
    //==================================================

    for (
        const symbol of COIN_LIST
    ) {

        const score =
            await calculateCoinScore(
                symbol
            );


        if (score) {

            results.push(
                score
            );

        }

    }


    //==================================================
    // SORT BULLISH
    //
    // This is ONLY for presentation.
    //
    // It does NOT mean the coin must have
    // aligned Delta.
    //==================================================

    const bullish =

        results

            .filter(
                coin =>
                    coin.bullishScore >
                    coin.bearishScore
            )

            .sort(
                (a, b) =>
                    b.bullishScore -
                    a.bullishScore
            )

            .slice(
                0,
                7
            );


    //==================================================
    // SORT BEARISH
    //==================================================

    const bearish =

        results

            .filter(
                coin =>
                    coin.bearishScore >
                    coin.bullishScore
            )

            .sort(
                (a, b) =>
                    b.bearishScore -
                    a.bearishScore
            )

            .slice(
                0,
                7
            );


    //==================================================
    // MESSAGE HEADER
    //==================================================

    let msg =
`⚡ *COIN ORDER FLOW REPORT*
🕐 30-MINUTE UPDATE

📊 3H = BROADER ORDER FLOW
⚡ 30M = SHORT-TERM ORDER FLOW

`;


    //==================================================
    // BULLISH ORDER FLOW
    //==================================================

    if (
        bullish.length
    ) {

        msg +=
`🟢 *BULLISH ORDER FLOW*

`;


        bullish.forEach(
            (coin, index) => {

                const d3 =
                    coin.delta3H;

                const d30 =
                    coin.delta30M;


                msg +=

`${index + 1}. *${coin.symbol}*
🟢 Score: ${coin.bullishScore}/100

📊 *3H CUMULATIVE DELTA*
${d3.currentDelta >= 0 ? "🟢" : "🔴"} ${d3.currentDelta.toFixed(0)}
${d3.trend}
${d3.pressure}

⚡ *30M CUMULATIVE DELTA*
${d30.currentDelta >= 0 ? "🟢" : "🔴"} ${d30.currentDelta.toFixed(0)}
${d30.trend}
${d30.pressure}

🔗 *DELTA RELATIONSHIP*
${coin.deltaAlignment.alignment}

⚡ *2H STC*
${coin.stcSignal}

📈 *2H OBV*
${coin.obvSignal}

📍 *ATR LOCATION*
${coin.atrLocation}

`;

            }
        );

    }


    //==================================================
    // BEARISH ORDER FLOW
    //==================================================

    if (
        bearish.length
    ) {

        msg +=
`🔴 *BEARISH ORDER FLOW*

`;


        bearish.forEach(
            (coin, index) => {

                const d3 =
                    coin.delta3H;

                const d30 =
                    coin.delta30M;


                msg +=

`${index + 1}. *${coin.symbol}*
🔴 Score: ${coin.bearishScore}/100

📊 *3H CUMULATIVE DELTA*
${d3.currentDelta >= 0 ? "🟢" : "🔴"} ${d3.currentDelta.toFixed(0)}
${d3.trend}
${d3.pressure}

⚡ *30M CUMULATIVE DELTA*
${d30.currentDelta >= 0 ? "🟢" : "🔴"} ${d30.currentDelta.toFixed(0)}
${d30.trend}
${d30.pressure}

🔗 *DELTA RELATIONSHIP*
${coin.deltaAlignment.alignment}

⚡ *2H STC*
${coin.stcSignal}

📈 *2H OBV*
${coin.obvSignal}

📍 *ATR LOCATION*
${coin.atrLocation}

`;

            }
        );

    }


    //==================================================
    // BALANCED / MIXED ORDER FLOW
    //
    // These coins are important because they may
    // show a transition between bullish and bearish
    // conditions.
    //==================================================

    const balanced =

        results

            .filter(
                coin =>
                    coin.bullishScore ===
                    coin.bearishScore
            )

            .slice(
                0,
                5
            );


    if (
        balanced.length
    ) {

        msg +=
`⚪ *BALANCED / MIXED ORDER FLOW*

`;

        balanced.forEach(
            (coin, index) => {

                const d3 =
                    coin.delta3H;

                const d30 =
                    coin.delta30M;


                msg +=

`${index + 1}. *${coin.symbol}*

📊 3H Delta
${d3.currentDelta >= 0 ? "🟢" : "🔴"} ${d3.currentDelta.toFixed(0)}
${d3.trend}
${d3.pressure}

⚡ 30M Delta
${d30.currentDelta >= 0 ? "🟢" : "🔴"} ${d30.currentDelta.toFixed(0)}
${d30.trend}
${d30.pressure}

🔗 ${coin.deltaAlignment.alignment}

⚡ STC: ${coin.stcSignal}
📈 OBV: ${coin.obvSignal}
📍 ATR: ${coin.atrLocation}

`;

            }
        );

    }


    //==================================================
    // NO DATA
    //==================================================

    if (
        results.length === 0
    ) {

        msg +=
`⚪ *NO DATA AVAILABLE*

The scanner is still monitoring all coins.`;

    }


    //==================================================
    // REPORT FOOTER
    //==================================================

    if (
        results.length
    ) {

        msg +=
`━━━━━━━━━━━━━━━━━━━━

📌 *ORDER FLOW SUMMARY*

3H Delta = broader pressure
30M Delta = immediate pressure

🟢 Higher Positive = buying strengthening
🟢 Higher Negative = selling weakening
🔴 Lower Negative = selling strengthening
🔴 Lower Positive = buying weakening

🔗 Delta alignment is informational only.
It is NOT required for a coin to appear in this report.

`;

    }


    //==================================================
    // SEND TELEGRAM
    //==================================================

    await sendMessage(
        msg
    );

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