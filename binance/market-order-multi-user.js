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

// =====================================================
// COIN SCORE REPORT
// 1H 10 SMA = CLOSED CANDLE CROSSOVER CONFIRMATION
// 4H 10 SMA = LIVE PRICE FILTER
// 2H STC = CLOSED CANDLE MOMENTUM
// 2H OBV = CLOSED CANDLE VOLUME FLOW
// ATR LOCATION = DAILY HIGH/LOW CONTEXT
// VOLUME SPIKE = 1H CLOSED CANDLE VS 20-CANDLE AVERAGE
//
// REPORTING LOGIC:
// - Report starts only after a confirmed 1H 10 SMA crossover.
// - Bullish cycle = closed 1H candle crosses ABOVE 10 SMA.
// - Bearish cycle = closed 1H candle crosses BELOW 10 SMA.
// - Crossover candle must be checked for VOLUME + MOMENTUM.
// - Strong crossover candles receive the full 30-point SMA score.
// - Weak crossover candles receive NO SMA directional points.
// - Report repeats every hour while price remains on that side.
// - If a closed 1H candle crosses back through the 10 SMA,
//   the reporting cycle stops.
// - 4H candle does NOT need to close.
// =====================================================


// =====================================================
// TRACK ACTIVE 1H SMA REPORTING CYCLE
// =====================================================

let coinScoreCycle = {};

// Example:
// {
//   BTCUSDT: "BULLISH",
//   ETHUSDT: "BEARISH"
// }


// =====================================================
// SMA CALCULATION
// =====================================================

function calculateSMA(values, period = 10) {

  if (!values || values.length < period) {
    return null;
  }

  const slice = values.slice(-period);

  return (
    slice.reduce(
      (sum, value) => sum + value,
      0
    ) / period
  );
}


// =====================================================
// OBV CALCULATION
// =====================================================

function calculateOBV(candles) {

  if (!candles || candles.length < 2) {
    return null;
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

      obv += candles[i].volume;

    } else if (
      candles[i].close <
      candles[i - 1].close
    ) {

      obv -= candles[i].volume;
    }
  }

  return obv;
}


// =====================================================
// ATR LOCATION
// =====================================================

function getATRLocation(
  price,
  atr,
  dailyHigh,
  dailyLow
) {

  if (
    !price ||
    !atr ||
    !dailyHigh ||
    !dailyLow
  ) {

    return {
      location: "UNKNOWN",
      bullishPoints: 0,
      bearishPoints: 0
    };
  }

  const distanceToLow =
    price - dailyLow;

  const distanceToHigh =
    dailyHigh - price;

  const nearLow =
    distanceToLow >= 0 &&
    distanceToLow <= atr * 0.5;

  const nearHigh =
    distanceToHigh >= 0 &&
    distanceToHigh <= atr * 0.5;


  // Near daily/ATR low
  // Potential bullish reversal area

  if (nearLow) {

    return {
      location: "NEAR ATR LOW",
      bullishPoints: 10,
      bearishPoints: 0
    };
  }


  // Near daily/ATR high
  // Potential bearish reversal area

  if (nearHigh) {

    return {
      location: "NEAR ATR HIGH",
      bullishPoints: 0,
      bearishPoints: 10
    };
  }


  return {
    location: "MID-RANGE",
    bullishPoints: 0,
    bearishPoints: 0
  };
}


// =====================================================
// VOLUME SPIKE
// Used for general 1H volume scoring
// =====================================================

function calculateVolumeSpike(
  closedCandles,
  lookback = 20
) {

  if (
    !closedCandles ||
    closedCandles.length <
    lookback + 1
  ) {

    return {
      ratio: 0,
      strength: "INSUFFICIENT DATA",
      bullishPoints: 0,
      bearishPoints: 0
    };
  }


  const currentCandle =
    closedCandles[
      closedCandles.length - 1
    ];


  const previousCandles =
    closedCandles.slice(
      -(lookback + 1),
      -1
    );


  const averageVolume =
    previousCandles.reduce(
      (sum, candle) =>
        sum + candle.volume,
      0
    ) / previousCandles.length;


  if (!averageVolume) {

    return {
      ratio: 0,
      strength: "NO DATA",
      bullishPoints: 0,
      bearishPoints: 0
    };
  }


  const ratio =
    currentCandle.volume /
    averageVolume;


  let strength = "NORMAL";


  if (ratio >= 2) {

    strength =
      "VERY STRONG";

  } else if (ratio >= 1.5) {

    strength =
      "STRONG";

  } else if (ratio >= 1.2) {

    strength =
      "MODERATE";
  }


  let bullishPoints = 0;
  let bearishPoints = 0;


  // Only reward significant volume

  if (ratio >= 1.5) {

    if (
      currentCandle.close >
      currentCandle.open
    ) {

      bullishPoints = 10;

    } else if (
      currentCandle.close <
      currentCandle.open
    ) {

      bearishPoints = 10;
    }
  }


  return {
    ratio,
    strength,
    bullishPoints,
    bearishPoints
  };
}


// =====================================================
// 1H CROSSOVER CANDLE VOLUME + MOMENTUM
//
// PURPOSE:
// Prevent weak crossovers like ATOMUSDT from receiving
// the same score as strong crossovers like UNIUSDT.
//
// VOLUME:
// Crossover candle volume compared against previous
// 20 CLOSED 1H candles.
//
// MOMENTUM:
// Candle body size compared against 1H ATR.
//
// Strong crossover:
// - Volume >= 1.5x average
// - Candle body >= 0.5 ATR
//
// Very strong crossover:
// - Volume >= 2.0x average
// - Candle body >= 0.75 ATR
// =====================================================

function analyzeCrossoverCandle(
  closedCandles,
  crossoverCandle,
  direction,
  atrPeriod = 14,
  volumeLookback = 20
) {

  if (
    !closedCandles ||
    !crossoverCandle ||
    closedCandles.length <
    volumeLookback + 1
  ) {

    return {
      valid: false,
      volumeRatio: 0,
      volumeStrength: "INSUFFICIENT DATA",
      momentumRatio: 0,
      momentumStrength: "INSUFFICIENT DATA",
      signal: "INSUFFICIENT DATA",
      bullishPoints: 0,
      bearishPoints: 0
    };
  }


  // =================================================
  // VOLUME ANALYSIS
  // =================================================

  // Exclude crossover candle itself.
  // Compare it against the PREVIOUS 20 closed candles.

  const crossoverIndex =
    closedCandles.length - 1;

  const previousCandles =
    closedCandles.slice(
      Math.max(
        0,
        crossoverIndex - volumeLookback
      ),
      crossoverIndex
    );


  if (
    previousCandles.length <
    volumeLookback
  ) {

    return {
      valid: false,
      volumeRatio: 0,
      volumeStrength: "INSUFFICIENT DATA",
      momentumRatio: 0,
      momentumStrength: "INSUFFICIENT DATA",
      signal: "INSUFFICIENT DATA",
      bullishPoints: 0,
      bearishPoints: 0
    };
  }


  const averageVolume =
    previousCandles.reduce(
      (sum, candle) =>
        sum + candle.volume,
      0
    ) /
    previousCandles.length;


  const volumeRatio =
    averageVolume > 0
      ? crossoverCandle.volume /
        averageVolume
      : 0;


  let volumeStrength =
    "WEAK";


  if (
    volumeRatio >= 2
  ) {

    volumeStrength =
      "VERY STRONG";

  } else if (
    volumeRatio >= 1.5
  ) {

    volumeStrength =
      "STRONG";

  } else if (
    volumeRatio >= 1.2
  ) {

    volumeStrength =
      "MODERATE";
  }


  // =================================================
  // MOMENTUM ANALYSIS
  // =================================================

  const atr =
    calculateATR(
      closedCandles,
      atrPeriod
    );


  if (!atr || atr <= 0) {

    return {
      valid: false,
      volumeRatio,
      volumeStrength,
      momentumRatio: 0,
      momentumStrength: "NO ATR DATA",
      signal: "NO ATR DATA",
      bullishPoints: 0,
      bearishPoints: 0
    };
  }


  // Candle body size

  const bodySize =
    Math.abs(
      crossoverCandle.close -
      crossoverCandle.open
    );


  // Body relative to ATR

  const momentumRatio =
    bodySize / atr;


  let momentumStrength =
    "WEAK";


  if (
    momentumRatio >= 0.75
  ) {

    momentumStrength =
      "VERY STRONG";

  } else if (
    momentumRatio >= 0.5
  ) {

    momentumStrength =
      "STRONG";

  } else if (
    momentumRatio >= 0.3
  ) {

    momentumStrength =
      "MODERATE";
  }


  // =================================================
  // CANDLE DIRECTION
  // =================================================

  const bullishCandle =
    crossoverCandle.close >
    crossoverCandle.open;

  const bearishCandle =
    crossoverCandle.close <
    crossoverCandle.open;


  // =================================================
  // FINAL CROSSOVER QUALITY
  //
  // Strong crossover requires:
  //
  // 1. Correct candle direction
  // 2. Volume >= 1.5x average
  // 3. Momentum >= 0.5 ATR
  // =================================================

  const strongVolume =
    volumeRatio >= 1.5;

  const strongMomentum =
    momentumRatio >= 0.5;


  let valid =
    false;

  let signal =
    "WEAK CROSSOVER";


  // =================================================
  // BULLISH CROSSOVER
  // =================================================

  if (
    direction === "BULLISH"
  ) {

    if (
      bullishCandle &&
      strongVolume &&
      strongMomentum
    ) {

      valid = true;

      signal =
        "STRONG BULLISH CROSSOVER";

    } else {

      signal =
        "WEAK BULLISH CROSSOVER";
    }
  }


  // =================================================
  // BEARISH CROSSOVER
  // =================================================

  else if (
    direction === "BEARISH"
  ) {

    if (
      bearishCandle &&
      strongVolume &&
      strongMomentum
    ) {

      valid = true;

      signal =
        "STRONG BEARISH CROSSOVER";

    } else {

      signal =
        "WEAK BEARISH CROSSOVER";
    }
  }


  // =================================================
  // SCORE
  //
  // Strong crossover:
  // Full 30 points
  //
  // Weak crossover:
  // 0 points
  // =================================================

  let bullishPoints = 0;
  let bearishPoints = 0;


  if (
    valid &&
    direction === "BULLISH"
  ) {

    bullishPoints = 30;

  } else if (
    valid &&
    direction === "BEARISH"
  ) {

    bearishPoints = 30;
  }


  return {

    valid,

    volumeRatio,

    volumeStrength,

    momentumRatio,

    momentumStrength,

    signal,

    bullishPoints,

    bearishPoints
  };
}


// =====================================================
// GENERATE COIN SCORE
// =====================================================

async function calculateCoinScore(
  symbol
) {

  try {

    // =================================================
    // 1H DATA
    // CLOSED CANDLE REQUIRED
    // =================================================

    const candles1H =
      await fetchFuturesKlines(
        symbol,
        "1h",
        100
      );


    if (
      !candles1H ||
      candles1H.length < 30
    ) {

      return null;
    }


    // Remove current forming 1H candle

    const closed1H =
      candles1H.slice(0, -1);


    if (closed1H.length < 21) {

      return null;
    }


    const closes1H =
      closed1H.map(
        c => c.close
      );


    // Latest CLOSED 1H candle

    const currentClosed1H =
      closed1H[
        closed1H.length - 1
      ];


    // Previous CLOSED 1H candle

    const previousClosed1H =
      closed1H[
        closed1H.length - 2
      ];


    // 10 SMA on latest CLOSED candle

    const sma10Current1H =
      calculateSMA(
        closes1H,
        10
      );


    // 10 SMA on previous CLOSED candle

    const sma10Previous1H =
      calculateSMA(
        closes1H.slice(0, -1),
        10
      );


    // =================================================
    // INITIAL SCORE
    // =================================================

    let bullishScore = 0;
    let bearishScore = 0;


    let sma1HSignal =
      "NO NEW CONFIRMED CROSSOVER";


    // =================================================
    // CHECK FOR NEW BULLISH CROSSOVER
    // =================================================

    const bullishCrossover =
      previousClosed1H.close <=
        sma10Previous1H &&
      currentClosed1H.close >
        sma10Current1H;


    // =================================================
    // CHECK FOR NEW BEARISH CROSSOVER
    // =================================================

    const bearishCrossover =
      previousClosed1H.close >=
        sma10Previous1H &&
      currentClosed1H.close <
        sma10Current1H;


    // =================================================
    // CROSSOVER MOMENTUM + VOLUME ANALYSIS
    // =================================================

    let crossoverAnalysis = {

      valid: false,

      volumeRatio: 0,

      volumeStrength:
        "NOT A NEW CROSSOVER",

      momentumRatio: 0,

      momentumStrength:
        "NOT A NEW CROSSOVER",

      signal:
        "NO NEW CROSSOVER",

      bullishPoints: 0,

      bearishPoints: 0
    };


    // =================================================
    // NEW BULLISH CROSSOVER
    // =================================================

    if (
      bullishCrossover
    ) {

      // Start bullish cycle

      coinScoreCycle[symbol] =
        "BULLISH";


      // Analyze the actual crossover candle

      crossoverAnalysis =
        analyzeCrossoverCandle(
          closed1H,
          currentClosed1H,
          "BULLISH",
          ATR_PERIOD,
          20
        );


      if (
        crossoverAnalysis.valid
      ) {

        sma1HSignal =
          "STRONG BULLISH CROSSOVER — VOLUME + MOMENTUM CONFIRMED";

      } else {

        sma1HSignal =
          "WEAK BULLISH CROSSOVER — LOW VOLUME OR MOMENTUM";
      }


    }


    // =================================================
    // NEW BEARISH CROSSOVER
    // =================================================

    else if (
      bearishCrossover
    ) {

      // Start bearish cycle

      coinScoreCycle[symbol] =
        "BEARISH";


      // Analyze the actual crossover candle

      crossoverAnalysis =
        analyzeCrossoverCandle(
          closed1H,
          currentClosed1H,
          "BEARISH",
          ATR_PERIOD,
          20
        );


      if (
        crossoverAnalysis.valid
      ) {

        sma1HSignal =
          "STRONG BEARISH CROSSOVER — VOLUME + MOMENTUM CONFIRMED";

      } else {

        sma1HSignal =
          "WEAK BEARISH CROSSOVER — LOW VOLUME OR MOMENTUM";
      }


    }


    // =================================================
    // ACTIVE BULLISH CYCLE
    // =================================================

    else if (
      coinScoreCycle[symbol] ===
      "BULLISH"
    ) {

      // If latest CLOSED candle remains above SMA,
      // keep bullish cycle active.

      if (
        currentClosed1H.close >
        sma10Current1H
      ) {

        sma1HSignal =
          "BULLISH CYCLE ACTIVE";

      } else {

        // Candle returned to/below SMA.
        // End reporting cycle.

        delete coinScoreCycle[
          symbol
        ];

        sma1HSignal =
          "BULLISH CYCLE ENDED";
      }

    }


    // =================================================
    // ACTIVE BEARISH CYCLE
    // =================================================

    else if (
      coinScoreCycle[symbol] ===
      "BEARISH"
    ) {

      // If latest CLOSED candle remains below SMA,
      // keep bearish cycle active.

      if (
        currentClosed1H.close <
        sma10Current1H
      ) {

        sma1HSignal =
          "BEARISH CYCLE ACTIVE";

      } else {

        // Candle returned to/above SMA.
        // End reporting cycle.

        delete coinScoreCycle[
          symbol
        ];

        sma1HSignal =
          "BEARISH CYCLE ENDED";
      }
    }


    // =================================================
    // NO ACTIVE 1H CYCLE
    // DO NOT SCORE OR REPORT THIS COIN
    // =================================================

    if (
      !coinScoreCycle[symbol]
    ) {

      return null;
    }


    // =================================================
    // SCORE 1H CROSSOVER
    //
    // IMPORTANT:
    //
    // NEW CROSSOVER:
    // Only strong volume + momentum gets 30 points.
    //
    // ACTIVE CYCLE:
    // The original 30-point directional bias remains
    // active after the initial crossover.
    // =================================================

    if (
      bullishCrossover
    ) {

      bullishScore +=
        crossoverAnalysis.bullishPoints;

    } else if (
      bearishCrossover
    ) {

      bearishScore +=
        crossoverAnalysis.bearishPoints;

    } else if (
      coinScoreCycle[symbol] ===
      "BULLISH"
    ) {

      // Existing active bullish cycle

      bullishScore += 30;

    } else if (
      coinScoreCycle[symbol] ===
      "BEARISH"
    ) {

      // Existing active bearish cycle

      bearishScore += 30;
    }


    // =================================================
    // 4H 10 SMA
    // LIVE PRICE
    // 20 POINTS
    //
    // 4H CANDLE DOES NOT NEED TO CLOSE
    // =================================================

    const candles4H =
      await fetchFuturesKlines(
        symbol,
        "4h",
        100
      );


    if (
      !candles4H ||
      candles4H.length < 20
    ) {

      return null;
    }


    const closes4H =
      candles4H.map(
        c => c.close
      );


    const sma10_4H =
      calculateSMA(
        closes4H,
        10
      );


    // =================================================
    // CURRENT LIVE PRICE
    // =================================================

    let currentPrice =
      currentClosed1H.close;


    try {

      const mp =
        await fetch(
          `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`
        );


      if (mp.ok) {

        const priceData =
          await mp.json();


        if (
          priceData.price
        ) {

          currentPrice =
            parseFloat(
              priceData.price
            );
        }
      }

    } catch {}


    let sma4HSignal =
      "NEUTRAL";


    // =================================================
    // LIVE PRICE ABOVE 4H SMA
    // =================================================

    if (
      currentPrice >
      sma10_4H
    ) {

      bullishScore += 20;

      sma4HSignal =
        "BULLISH — PRICE ABOVE 4H 10 SMA";

    }


    // =================================================
    // LIVE PRICE BELOW 4H SMA
    // =================================================

    else if (
      currentPrice <
      sma10_4H
    ) {

      bearishScore += 20;

      sma4HSignal =
        "BEARISH — PRICE BELOW 4H 10 SMA";
    }


  // =================================================
    // 2H STC
    // CLOSED CANDLE
    // 20 POINTS
    // =================================================

    const candles2H =
      await fetchFuturesKlines(
        symbol,
        "2h",
        100
      );


    if (
      !candles2H ||
      candles2H.length < 30
    ) {

      return null;
    }


    const closed2H =
      candles2H.slice(0, -1);


    const closes2H =
      closed2H.map(
        c => c.close
      );


    const stcSeries2H = [];


    for (
      let i = 0;
      i < closes2H.length;
      i++
    ) {

      const slice =
        closes2H.slice(
          0,
          i + 1
        );


      const value =
        calculateSTC(
          slice,
          {
            cycle: 4,
            fast: 10,
            slow: 20
          }
        );


      if (
        value !== null
      ) {

        stcSeries2H.push(
          value
        );
      }
    }


    let stc2HSignal =
      "NEUTRAL";


    if (
      stcSeries2H.length >= 2
    ) {

      const previousSTC =
        stcSeries2H[
          stcSeries2H.length - 2
        ];


      const currentSTC =
        stcSeries2H[
          stcSeries2H.length - 1
        ];


      if (
        currentSTC >
        previousSTC
      ) {

        bullishScore += 20;

        stc2HSignal =
          `BULLISH — RISING (${currentSTC.toFixed(1)})`;

      } else if (
        currentSTC <
        previousSTC
      ) {

        bearishScore += 20;

        stc2HSignal =
          `BEARISH — FALLING (${currentSTC.toFixed(1)})`;
      }
    }


    // =================================================
    // 2H OBV
    // CLOSED CANDLE
    // 20 POINTS
    // =================================================

    let obv2HSignal =
      "NEUTRAL";


    if (
      closed2H.length >= 4
    ) {

      const previousOBV =
        calculateOBV(
          closed2H.slice(0, -1)
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

        obv2HSignal =
          "BULLISH — RISING";

      } else if (
        currentOBV <
        previousOBV
      ) {

        bearishScore += 20;

        obv2HSignal =
          "BEARISH — FALLING";
      }
    }


    // =================================================
    // ATR LOCATION
    // 10 POINTS
    // =================================================

    const atr =
      calculateATR(
        closed1H,
        ATR_PERIOD
      );


    const dailyCandles =
      await fetchFuturesKlines(
        symbol,
        "1d",
        3
      );


    let atrLocation = {

      location:
        "UNKNOWN",

      bullishPoints:
        0,

      bearishPoints:
        0
    };


    if (
      atr &&
      dailyCandles &&
      dailyCandles.length >= 2
    ) {

      const lastClosedDaily =
        dailyCandles[
          dailyCandles.length - 2
        ];


      atrLocation =
        getATRLocation(
          currentPrice,
          atr,
          lastClosedDaily.high,
          lastClosedDaily.low
        );


      bullishScore +=
        atrLocation.bullishPoints;


      bearishScore +=
        atrLocation.bearishPoints;
    }


    // =================================================
    // GENERAL VOLUME SPIKE
    // 10 POINTS
    // =================================================

    const volumeSpike =
      calculateVolumeSpike(
        closed1H,
        20
      );


    bullishScore +=
      volumeSpike.bullishPoints;


    bearishScore +=
      volumeSpike.bearishPoints;


    // =================================================
    // FINAL DIRECTION
    // =================================================

    let direction =
      "NEUTRAL";


    if (
      bullishScore >
      bearishScore
    ) {

      direction =
        "BULLISH";

    } else if (
      bearishScore >
      bullishScore
    ) {

      direction =
        "BEARISH";
    }


    // =================================================
    // RETURN RESULT
    // =================================================

    return {

      symbol,

      price:
        currentPrice,

      bullishScore,

      bearishScore,

      direction,

      sma1HSignal,

      sma4HSignal,

      stc2HSignal,

      obv2HSignal,

      atrLocation:
        atrLocation.location,

      volumeRatio:
        volumeSpike.ratio,

      volumeStrength:
        volumeSpike.strength,

      // =================================================
      // NEW CROSSOVER METRICS
      // =================================================

      crossoverSignal:
        crossoverAnalysis.signal,

      crossoverVolumeRatio:
        crossoverAnalysis.volumeRatio,

      crossoverVolumeStrength:
        crossoverAnalysis.volumeStrength,

      crossoverMomentumRatio:
        crossoverAnalysis.momentumRatio,

      crossoverMomentumStrength:
        crossoverAnalysis.momentumStrength
    };


  } catch (err) {

    log(
      `❌ Coin score error ${symbol}: ${
        err?.message || err
      }`
    );

    return null;
  }
}


// =====================================================
// COIN SCORE REPORT
// RUNS EVERY HOUR
//
// IMPORTANT:
// Only coins with an ACTIVE confirmed 1H SMA cycle
// are included.
//
// TOP 7 BULLISH
// TOP 7 BEARISH
// =====================================================

async function generateCoinScoreReport() {

  const results = [];


  for (
    const symbol of COIN_LIST
  ) {

    const result =
      await calculateCoinScore(
        symbol
      );


    if (result) {

      results.push(result);
    }
  }


  // =================================================
  // TOP BULLISH CANDIDATES
  // =================================================

  const bullish =
    results
      .filter(
        r =>
          r.direction ===
          "BULLISH"
      )
      .sort(
        (a, b) =>
          b.bullishScore -
          a.bullishScore
      )
      .slice(0, 7);


  // =================================================
  // TOP BEARISH CANDIDATES
  // =================================================

  const bearish =
    results
      .filter(
        r =>
          r.direction ===
          "BEARISH"
      )
      .sort(
        (a, b) =>
          b.bearishScore -
          a.bearishScore
      )
      .slice(0, 7);


  // =================================================
  // BUILD REPORT
  // =================================================

  let msg =
    `⚡ *COIN DEPLOYMENT SCORE REPORT*\n\n`;


  // =================================================
  // BULLISH
  // =================================================

  if (
    bullish.length
  ) {

    msg +=
      `🟢 *TOP BULLISH CANDIDATES*\n\n`;


    bullish.forEach(
      (r, i) => {

        msg +=
          `${i + 1}. *${r.symbol}* — ` +
          `🟢 ${r.bullishScore}/100\n`;


        msg +=
          `10 SMA 1H: ${r.sma1HSignal}\n`;


        msg +=
          `Crossover Volume: ` +
          `${r.crossoverVolumeStrength} ` +
          `(${r.crossoverVolumeRatio.toFixed(2)}x)\n`;


        msg +=
          `Crossover Momentum: ` +
          `${r.crossoverMomentumStrength} ` +
          `(${r.crossoverMomentumRatio.toFixed(2)} ATR)\n`;


        msg +=
          `10 SMA 4H: ${r.sma4HSignal}\n`;


        msg +=
          `2H STC: ${r.stc2HSignal}\n`;


        msg +=
          `2H OBV: ${r.obv2HSignal}\n`;


        msg +=
          `ATR Location: ${r.atrLocation}\n`;


        msg +=
          `Volume: ${r.volumeStrength} ` +
          `(${r.volumeRatio.toFixed(2)}x)\n\n`;
      }
    );
  }


  // =================================================
  // BEARISH
  // =================================================

  if (
    bearish.length
  ) {

    msg +=
      `🔴 *TOP BEARISH CANDIDATES*\n\n`;


    bearish.forEach(
      (r, i) => {

        msg +=
          `${i + 1}. *${r.symbol}* — ` +
          `🔴 ${r.bearishScore}/100\n`;


        msg +=
          `10 SMA 1H: ${r.sma1HSignal}\n`;


        msg +=
          `Crossover Volume: ` +
          `${r.crossoverVolumeStrength} ` +
          `(${r.crossoverVolumeRatio.toFixed(2)}x)\n`;


        msg +=
          `Crossover Momentum: ` +
          `${r.crossoverMomentumStrength} ` +
          `(${r.crossoverMomentumRatio.toFixed(2)} ATR)\n`;


        msg +=
          `10 SMA 4H: ${r.sma4HSignal}\n`;


        msg +=
          `2H STC: ${r.stc2HSignal}\n`;


        msg +=
          `2H OBV: ${r.obv2HSignal}\n`;


        msg +=
          `ATR Location: ${r.atrLocation}\n`;


        msg +=
          `Volume: ${r.volumeStrength} ` +
          `(${r.volumeRatio.toFixed(2)}x)\n\n`;
      }
    );
  }


  // =================================================
  // NO ACTIVE CANDIDATES
  // =================================================

  if (
    !bullish.length &&
    !bearish.length
  ) {

    msg +=
      `⚪ No active 1H SMA ` +
      `crossover candidates at this time.`;
  }


  await sendMessage(
    msg
  );
}


// =====================================================
// RUN EVERY HOUR
// =====================================================

setInterval(
  generateCoinScoreReport,
  60 * 60 * 1000
);


// =====================================================
// RUN ONCE WHEN BOT STARTS
// =====================================================

generateCoinScoreReport();

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