// =====================================================
// FULL AUTO MULTI-USER MARKET ORDER BOT - BINANCE FUTURES (USDT-PERP)
// STC STRATEGY: 1H STC = direction, 5M STC = entry (confirmed flip on close)
// TP/SL/TRAILING STOP INTACT
// Volume imbalance report only per trade
// MAX TRADES = 7 per user
// 2 HRS cooldown per symbol
// =====================================================

const config = require("../config");
const Binance = require("node-binance-api");
const TelegramBot = require("node-telegram-bot-api");
const { ADX } = require("technicalindicators");
const fs = require("fs");
const fetch = require("node-fetch");
globalThis.fetch = fetch;

// --- TELEGRAM DETAILS ---
const TELEGRAM_BOT_TOKEN = "8712861439:AAH7xOydNxOi05zBA3DvEWzxoLVL3cMhu6U";
const GROUP_CHAT_ID = "-1003419090746";
const ADMIN_ID = "1718404728";
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// --- USERS FILE ---
const USERS_FILE = "./users.json";

// --- Settings ---
const TRADE_PERCENT = 0.1;
const LEVERAGE = 20;
const RUNNER_ACTIVATION_PCT = 2;
const SL_PCT = 1.5;
const TRAILING_STOP_PCT = 5;
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
let runnerActivationNotified = {}; // { symbol: true }
let userClients = {};
let BOT_PAUSED = false;
let symbolCooldowns = {}; // { symbol: timestamp }
let tradeHistory = []; // Successful trades placed by the bot

function getTradeHistoryDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Lagos",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

// =====================================================
// PRICE ACTIVATION GATE
// =====================================================
// A coin can be locked until it reaches an admin-defined
// price. Once triggered, it stays unlocked for this bot
// session. This is separate from /activate and /deactivate.
// =====================================================
let priceActivationLevels = {}; // { BTCUSDT: 105000 }
let priceActivated = {};         // { BTCUSDT: true }
let priceActivationPreviousPrice = {}; // { BTCUSDT: 104900 }

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

// ======================================================
// TREND-RESET CUMULATIVE DELTA
// ChartPrime methodology
//
// Settings:
// Base EMA Length = 20
// ATR Length      = 14
// ATR Multiplier  = 1
// Delta MA        = SMA 10
//
// Used for 15M ENTRY confirmation.
// ======================================================

const TR_DELTA_EMA_LENGTH = 20;
const TR_DELTA_ATR_LENGTH = 14;
const TR_DELTA_ATR_MULTIPLIER = 1;
const TR_DELTA_MA_LENGTH = 10;

// Minimum adaptive Delta strength required for a new entry.
// 0.50 = Delta must be at least half of the recent average
// absolute bar-delta movement beyond the Delta MA.
const DELTA_STRENGTH_THRESHOLD = 0.50;
const DELTA_STRENGTH_LOOKBACK = 20;


// ------------------------------------------------------
// EMA SERIES
// ------------------------------------------------------

function calculateEMASeries(candles, period) {

  if (!candles || candles.length < period) {
    return [];
  }

  const result = [];

  let sum = 0;

  for (let i = 0; i < period; i++) {

    const close = Number(candles[i].close);

    if (!Number.isFinite(close)) {
      return [];
    }

    sum += close;
  }

  let ema = sum / period;

  for (let i = 0; i < candles.length; i++) {

    const close = Number(candles[i].close);

    if (!Number.isFinite(close)) {
      result.push(null);
      continue;
    }

    if (i < period - 1) {
      result.push(null);
      continue;
    }

    if (i === period - 1) {
      result.push(ema);
      continue;
    }

    const multiplier =
      2 / (period + 1);

    ema =
      (close - ema) * multiplier +
      ema;

    result.push(ema);
  }

  return result;
}


// ------------------------------------------------------
// WILDER ATR SERIES
// ------------------------------------------------------

function calculateATRSeries(candles, period) {

  if (!candles || candles.length <= period) {
    return [];
  }

  const result = new Array(candles.length).fill(null);

  const trueRanges = new Array(candles.length).fill(null);

  for (let i = 0; i < candles.length; i++) {

    const high = Number(candles[i].high);
    const low = Number(candles[i].low);

    if (
      !Number.isFinite(high) ||
      !Number.isFinite(low)
    ) {
      return [];
    }

    if (i === 0) {

      trueRanges[i] =
        high - low;

      continue;
    }

    const previousClose =
      Number(candles[i - 1].close);

    if (!Number.isFinite(previousClose)) {
      return [];
    }

    const range1 =
      high - low;

    const range2 =
      Math.abs(
        high - previousClose
      );

    const range3 =
      Math.abs(
        low - previousClose
      );

    trueRanges[i] =
      Math.max(
        range1,
        range2,
        range3
      );
  }


  // -----------------------------------------------
  // Initial Wilder ATR
  // Pine ta.atr() uses Wilder/RMA smoothing.
  // -----------------------------------------------

  let atr = 0;

  for (
    let i = 1;
    i <= period;
    i++
  ) {

    atr += trueRanges[i];
  }

  atr /= period;

  result[period] = atr;


  // -----------------------------------------------
  // Wilder smoothing
  // -----------------------------------------------

  for (
    let i = period + 1;
    i < candles.length;
    i++
  ) {

    atr =
      (
        atr * (period - 1) +
        trueRanges[i]
      ) / period;

    result[i] = atr;
  }

  return result;
}

// ======================================================
// CALCULATE CHARTPRIME TREND-RESET CUMULATIVE DELTA
// ======================================================
//
// Returns the latest CLOSED candle:
//
// {
//   cumDelta,
//   deltaMA,
//   trendState,
//   trendChanged,
//   bullish,
//   bearish
// }
//
// ======================================================

function calculateTrendResetCumulativeDelta(
  candles
) {

  if (
    !candles ||
    candles.length <
    Math.max(
      TR_DELTA_EMA_LENGTH,
      TR_DELTA_ATR_LENGTH
    ) + TR_DELTA_MA_LENGTH
  ) {

    return null;
  }


  const emaSeries =
    calculateEMASeries(
      candles,
      TR_DELTA_EMA_LENGTH
    );

  const atrSeries =
    calculateATRSeries(
      candles,
      TR_DELTA_ATR_LENGTH
    );


  if (
    !emaSeries.length ||
    !atrSeries.length
  ) {

    return null;
  }


  let trendState = 0;

  let cumDelta = 0;

  const deltaSeries = [];


  for (
    let i = 0;
    i < candles.length;
    i++
  ) {

    const close =
      Number(candles[i].close);

    const open =
      Number(candles[i].open);

    const volume =
      Number(candles[i].volume);

    if (
      !Number.isFinite(close) ||
      !Number.isFinite(open) ||
      !Number.isFinite(volume)
    ) {

      continue;
    }


    // ---------------------------------------------
    // ChartPrime barDelta
    // ---------------------------------------------

    const barDelta =
      close > open
        ? volume
        : -volume;


    let newTrendState =
      trendState;


    const ema =
      emaSeries[i];

    const atr =
      atrSeries[i];


    // ---------------------------------------------
    // ChartPrime trend calculation
    // ---------------------------------------------

    if (
      ema !== null &&
      atr !== null
    ) {

      const upperBand =
        ema +
        atr *
        TR_DELTA_ATR_MULTIPLIER;

      const lowerBand =
        ema -
        atr *
        TR_DELTA_ATR_MULTIPLIER;


      if (
        close > upperBand
      ) {

        newTrendState = 1;

      }

      else if (
        close < lowerBand
      ) {

        newTrendState = -1;

      }
    }


    const trendChanged =
      newTrendState !== trendState;


    trendState =
      newTrendState;


    // ---------------------------------------------
    // ChartPrime cumulative delta reset
    // ---------------------------------------------

    if (trendChanged) {

      cumDelta =
        barDelta;

    }

    else {

      cumDelta +=
        barDelta;

    }


    deltaSeries.push({
      index: i,
      cumDelta,
      trendState,
      trendChanged
    });
  }


  if (
    deltaSeries.length <
    TR_DELTA_MA_LENGTH
  ) {

    return null;
  }


  // -----------------------------------------------
  // SMA(10) of cumulative delta
  // Same as:
  //
  // ta.sma(cumDelta, 10)
  // -----------------------------------------------

  const recentDeltaValues =
    deltaSeries
      .slice(
        -TR_DELTA_MA_LENGTH
      )
      .map(
        item => item.cumDelta
      );


  const deltaMA =
    recentDeltaValues.reduce(
      (sum, value) =>
        sum + value,
      0
    ) /
    TR_DELTA_MA_LENGTH;

  // -----------------------------------------------------
  // Adaptive Delta strength
  // Measures how far cumulative Delta is from its MA
  // relative to the recent typical bar-delta movement.
  // This prevents weak readings that are only slightly
  // above/below the MA from qualifying as entries.
  // -----------------------------------------------------
  const strengthWindow =
    deltaSeries.slice(
      -Math.min(DELTA_STRENGTH_LOOKBACK, deltaSeries.length)
    );

  const recentBarDeltaMoves = [];

  for (let i = 1; i < strengthWindow.length; i++) {
    recentBarDeltaMoves.push(
      Math.abs(
        strengthWindow[i].cumDelta -
        strengthWindow[i - 1].cumDelta
      )
    );
  }

  const avgAbsBarDelta =
    recentBarDeltaMoves.length
      ? recentBarDeltaMoves.reduce(
          (sum, value) => sum + value,
          0
        ) / recentBarDeltaMoves.length
      : 0;


  const latest =
    deltaSeries[
      deltaSeries.length - 1
    ];


  return {

    cumDelta:
      latest.cumDelta,

    deltaMA,

    trendState:
      latest.trendState,

    trendChanged:
      latest.trendChanged,

    deltaDistance:
      latest.cumDelta - deltaMA,

    deltaStrength:
      avgAbsBarDelta > 0
        ? (latest.cumDelta - deltaMA) / avgAbsBarDelta
        : 0,

    avgAbsBarDelta,

    bullish:
      latest.cumDelta > 0 &&
      latest.cumDelta > deltaMA &&
      (avgAbsBarDelta > 0
        ? (latest.cumDelta - deltaMA) / avgAbsBarDelta
        : 0) >= DELTA_STRENGTH_THRESHOLD,

    bearish:
      latest.cumDelta < 0 &&
      latest.cumDelta < deltaMA &&
      (avgAbsBarDelta > 0
        ? (latest.cumDelta - deltaMA) / avgAbsBarDelta
        : 0) <= -DELTA_STRENGTH_THRESHOLD
  };
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
          runnerActive: false,
        };
        // Start cooldown for this symbol
        symbolCooldowns[symbol] = Date.now();

        // Record every successful order so /tradehistory can show
        // all trades placed during the current day.
        tradeHistory.push({
          date: getTradeHistoryDate(),
          symbol,
          direction,
          entryPrice: markPrice,
          qty,
          userId,
          timestamp: Date.now()
        });

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
        const p = Array.isArray(positions)
          ? positions.find((x) => x.symbol === symbol)
          : null;
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

        // Profit/Loss calculation
        const move =
          pos.side === "BUY"
            ? ((mark - pos.entryPrice) / pos.entryPrice) * 100
            : ((pos.entryPrice - mark) / pos.entryPrice) * 100;

        // =====================================================
        // RUNNER ACTIVATION
        // Runner activates once the position reaches +2%.
        // Only one activation message is sent per symbol.
        // =====================================================
        if (move >= RUNNER_ACTIVATION_PCT && !pos.runnerActive) {
          pos.runnerActive = true;

          if (!runnerActivationNotified[symbol]) {
            runnerActivationNotified[symbol] = true;

            await sendMessage(
              `🏃 RUNNER ACTIVATED: *${symbol}* ${pos.side}\n\n` +
              `💰 Profit: +${move.toFixed(2)}%\n` +
              `🎯 Activation: +${RUNNER_ACTIVATION_PCT.toFixed(2)}%\n\n` +
              `📊 Runner Mode: ACTIVE\n` +
              `🔎 Exit Signal: 15M Delta vs Delta MA\n\n` +
              `👥 All users' ${symbol} positions are now in runner mode.`
            );
          }
        }

        // =====================================================
        // TRAILING STOP
        // Active only before runner mode.
        // Once runner mode activates, Delta controls the runner exit.
        // =====================================================
        if (!pos.runnerActive && pos.side === "BUY") {
          pos.highest = Math.max(pos.highest, mark);
          const trail = pos.highest * (1 - TRAILING_STOP_PCT / 100);

          if (!pos.trailingStop || trail > pos.trailingStop) {
            pos.trailingStop = trail;
          }

          if (mark <= pos.trailingStop) {
            await client.futuresMarketSell(symbol, Math.abs(amt));
            delete activePositions[symbol][userId];

            await sendMessage(
              `🔒 Trailing Stop Hit: *${symbol}* (User ${userId})`
            );

            continue;
          }
        } else if (!pos.runnerActive && pos.side === "SELL") {
          pos.lowest = Math.min(pos.lowest, mark);
          const trail = pos.lowest * (1 + TRAILING_STOP_PCT / 100);

          if (!pos.trailingStop || trail < pos.trailingStop) {
            pos.trailingStop = trail;
          }

          if (mark >= pos.trailingStop) {
            await client.futuresMarketBuy(symbol, Math.abs(amt));
            delete activePositions[symbol][userId];

            await sendMessage(
              `🔒 Trailing Stop Hit: *${symbol}* (User ${userId})`
            );

            continue;
          }
        }

        // =====================================================
        // RUNNER EXIT USING 15M TREND-RESET CUMULATIVE DELTA
        //
        // LONG:
        // Positive Delta > Delta MA = HOLD
        // Positive Delta < Delta MA = EXIT
        //
        // SHORT:
        // Negative Delta < Delta MA = HOLD
        // Negative Delta > Delta MA = EXIT
        // =====================================================
        if (pos.runnerActive) {
          try {
            const candles15 = await client.futuresCandles({
              symbol,
              interval: "15m",
              limit: 150,
            });

            // Use closed 15M candles only.
            const closedCandles15 = candles15.slice(0, -1);

            const trDelta15 =
              calculateTrendResetCumulativeDelta(closedCandles15);

            if (
              pos.side === "BUY" &&
              trDelta15.cumDelta > 0 &&
              trDelta15.cumDelta < trDelta15.deltaMA
            ) {
              await client.futuresMarketSell(symbol, Math.abs(amt));
              delete activePositions[symbol][userId];

              await sendMessage(
                `🏃 RUNNER EXIT: *${symbol}* LONG\n` +
                `Profit: ${move.toFixed(2)}%\n` +
                `Delta weakened below Delta MA.`
              );

              continue;
            }

            if (
              pos.side === "SELL" &&
              trDelta15.cumDelta < 0 &&
              trDelta15.cumDelta > trDelta15.deltaMA
            ) {
              await client.futuresMarketBuy(symbol, Math.abs(amt));
              delete activePositions[symbol][userId];

              await sendMessage(
                `🏃 RUNNER EXIT: *${symbol}* SHORT\n` +
                `Profit: ${move.toFixed(2)}%\n` +
                `Delta weakened above Delta MA.`
              );

              continue;
            }
          } catch (deltaErr) {
            log(
              `⚠️ Runner delta check error ${userId} ${symbol}: ${
                deltaErr?.message || deltaErr
              }`
            );
          }
        }

        // =====================================================
        // STOP LOSS REMAINS ACTIVE
        // =====================================================
        if (move <= -SL_PCT) {
          if (pos.side === "BUY") {
            await client.futuresMarketSell(symbol, Math.abs(amt));
          } else {
            await client.futuresMarketBuy(symbol, Math.abs(amt));
          }

          delete activePositions[symbol][userId];

          await sendMessage(
            `🔻 STOP LOSS: *${symbol}* User ${userId}`
          );

          continue;
        }
      } catch (err) {
        log(
          `❌ monitorPositions error ${userId} ${symbol}: ${
            err?.message || err
          }`
        );
      }
    }

    // Reset notification state when there are no positions left
    // for this symbol, allowing a future trade to activate a new runner.
    if (
      !activePositions[symbol] ||
      Object.keys(activePositions[symbol]).length === 0
    ) {
      delete runnerActivationNotified[symbol];
      delete activePositions[symbol];
    }
  }
}
setInterval(monitorPositions, MONITOR_INTERVAL_MS);

// --- Manual cycle per symbol ---
let MANUAL_CYCLE_BY_SYMBOL = {}; // e.g., { BTCUSDT: "BULL", ETHUSDT: "BEAR" }

let symbolActive = {};
COIN_LIST.forEach((s) => (symbolActive[s] = true)); // By default, all symbols active

// =====================================================
// PRICE ACTIVATION MONITOR
// =====================================================
// Uses Binance's public Futures mark-price endpoint.
// No user account/order is required to monitor activation.
// =====================================================
async function monitorPriceActivations() {
  const symbols = Object.keys(priceActivationLevels);
  if (!symbols.length) return;

  for (const symbol of symbols) {
    if (priceActivated[symbol] === true) continue;

    try {
      const res = await fetch(
        `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`
      );

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      const currentPrice = parseFloat(data?.markPrice || 0);
      const activationPrice = priceActivationLevels[symbol];

      if (!Number.isFinite(currentPrice) || currentPrice <= 0) continue;
      if (!Number.isFinite(activationPrice) || activationPrice <= 0) continue;

      // The price must CROSS the activation level while the gate is active.
      // Either direction is valid: below -> above OR above -> below.
      // If the coin is already on one side when /price is set, it stays locked
      // until price actually crosses the activation level.
      const previousPrice = priceActivationPreviousPrice[symbol];

      if (previousPrice === undefined) {
        priceActivationPreviousPrice[symbol] = currentPrice;
        continue;
      }

      const crossedUp =
        previousPrice < activationPrice && currentPrice >= activationPrice;
      const crossedDown =
        previousPrice > activationPrice && currentPrice <= activationPrice;

      if (crossedUp || crossedDown) {
        priceActivated[symbol] = true;

        const crossDirection = crossedUp ? "UPWARD ⬆️" : "DOWNWARD ⬇️";

        await sendMessage(
          `🔓 *PRICE ACTIVATION TRIGGERED*\n\n` +
          `🪙 Coin: *${symbol}*\n` +
          `🎯 Activation Price: *${activationPrice}*\n` +
          `💰 Current Price: *${currentPrice}*\n` +
          `↕️ Cross: *${crossDirection}*\n\n` +
          `✅ *${symbol}* is now unlocked for trading.\n` +
          `The normal 1H STC + 15M Trend-Reset Cumulative Delta strategy will decide BUY or SELL.`
        );

        log(
          `🔓 PRICE ACTIVATED ${symbol} at ${currentPrice}. ` +
          `Trigger: ${activationPrice}. Cross: ${crossDirection}`
        );
      }

      // Always keep the latest observed price so the next check can detect a crossing.
      priceActivationPreviousPrice[symbol] = currentPrice;
    } catch (err) {
      log(`❌ Price activation monitor error ${symbol}: ${err?.message || err}`);
    }
  }
}

setInterval(monitorPriceActivations, 5000);

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

      // Price activation gate. This does not change /activate or /deactivate.
      if (
        priceActivationLevels[symbol] !== undefined &&
        priceActivated[symbol] !== true
      ) continue;

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
// 15M TREND-RESET CUMULATIVE DELTA ENTRY
// ChartPrime methodology
// =====================================================
//
// 1H STC = TREND
//
// 15M Delta:
//
// BUY:
//   Delta > 0
//   AND Delta > SMA(10)
//
// SELL:
//   Delta < 0
//   AND Delta < SMA(10)
//
// Only CLOSED 15M candles are used.
// =====================================================

const candles15 =
  await fetchFuturesKlines(
    symbol,
    "15m",
    150
  );

if (
  !candles15 ||
  candles15.length < 40
) continue;


// Remove currently forming 15M candle.

const closedCandles15 =
  candles15.slice(0, -1);


// Calculate ChartPrime-style
// Trend-Reset Cumulative Delta.

const trDelta15 =
  calculateTrendResetCumulativeDelta(
    closedCandles15
  );


if (!trDelta15) continue;


// =====================================================
// ENTRY DIRECTION
// =====================================================

let direction = null;


// -----------------------------------------------------
// BULLISH 1H + BULLISH 15M DELTA
// -----------------------------------------------------

if (
  trendCycle === "BULL" &&
  trDelta15.cumDelta > 0 &&
  trDelta15.cumDelta > trDelta15.deltaMA &&
  trDelta15.deltaStrength >= DELTA_STRENGTH_THRESHOLD
) {

  direction = "BUY";

}


// -----------------------------------------------------
// BEARISH 1H + BEARISH 15M DELTA
// -----------------------------------------------------

if (
  trendCycle === "BEAR" &&
  trDelta15.cumDelta < 0 &&
  trDelta15.cumDelta < trDelta15.deltaMA &&
  trDelta15.deltaStrength <= -DELTA_STRENGTH_THRESHOLD
) {

  direction = "SELL";

}

      // =====================================================
      // EXECUTION
      // =====================================================
      if (direction) {
        await executeMarketOrderForAllUsers(symbol, direction);

        const buyVol = closedCandles15.reduce((sum, c) => sum + (c.close > c.open ? c.volume : 0), 0);
        const sellVol = closedCandles15.reduce((sum, c) => sum + (c.close < c.open ? c.volume : 0), 0);
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
// • 1H Momentum
// • Trend Health / Exhaustion
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
// 4H  = BROADER TREND / ATR STRUCTURE
// 1H  = MOMENTUM / TREND HEALTH
//======================================================


//======================================================
// 4H TREND SETTINGS
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
// COMPLETED 4H CANDLE:
//
// Close > EMA20 + ATR14 × 1
//     = BULLISH
//
// Close < EMA20 - ATR14 × 1
//     = BEARISH
//
// Otherwise previous trend remains.
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


        if (
            close >
            upperBand
        ) {

            trendState =
                1;

        }

        else if (
            close <
            lowerBand
        ) {

            trendState =
                -1;

        }


        if (
            trendState === 1 &&
            previousTrend !== 1
        ) {

            lastBreakType =
                "UPPER BAND BREAK";

            lastBreakIndex =
                i;

        }


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
// 1H MOMENTUM
//
// 10-CANDLE LOOKBACK
//
// Momentum is calculated as:
//
// (Current Price - Price 10 Hours Ago) / 10
//
// The previous 10H momentum is also calculated so we
// can determine whether momentum is accelerating or
// decelerating.
//======================================================

const MOMENTUM_LOOKBACK_1H = 10;


function calculate1HMomentum(candles) {

    if (
        !candles ||
        candles.length <
        (MOMENTUM_LOOKBACK_1H * 2) + 1
    ) {

        return null;

    }

    const end =
        candles.length - 1;


    const currentClose =
        Number(
            candles[end].close
        );


    const close10HoursAgo =
        Number(
            candles[
                end -
                MOMENTUM_LOOKBACK_1H
            ].close
        );


    const close20HoursAgo =
        Number(
            candles[
                end -
                (
                    MOMENTUM_LOOKBACK_1H * 2
                )
            ].close
        );


    if (
        !Number.isFinite(currentClose) ||
        !Number.isFinite(close10HoursAgo) ||
        !Number.isFinite(close20HoursAgo)
    ) {

        return null;

    }


    //==================================================
    // CURRENT 10H MOMENTUM
    //==================================================

    const currentMomentum =
        (
            currentClose -
            close10HoursAgo
        ) /
        MOMENTUM_LOOKBACK_1H;


    //==================================================
    // PREVIOUS 10H MOMENTUM
    //==================================================

    const previousMomentum =
        (
            close10HoursAgo -
            close20HoursAgo
        ) /
        MOMENTUM_LOOKBACK_1H;


    //==================================================
    // MOMENTUM CHANGE
    //==================================================

    const momentumChange =
        currentMomentum -
        previousMomentum;


    //==================================================
    // DIRECTION
    //==================================================

    let direction =
        "FLAT";


    if (
        currentMomentum > 0
    ) {

        direction =
            "POSITIVE";

    }

    else if (
        currentMomentum < 0
    ) {

        direction =
            "NEGATIVE";

    }


    //==================================================
    // ACCELERATION / DECELERATION
    //==================================================

    const accelerating =
        Math.abs(currentMomentum) >=
        Math.abs(previousMomentum);


    const state =
        accelerating
            ? "ACCELERATING"
            : "DECELERATING";


    return {

        current:
            currentMomentum,

        previous:
            previousMomentum,

        change:
            momentumChange,

        direction,

        state

    };

}


//======================================================
// TREND HEALTH / EXHAUSTION
//
// This does NOT predict a reversal.
//
// It measures whether the current 4H trend continues
// to receive confirmation from:
//
// • 1H Momentum
// • 30M Delta
//
// Healthy:
// Trend + momentum + order flow aligned.
//
// Weakening:
// Momentum or order flow is beginning to fade.
//
// High exhaustion:
// Momentum is no longer aligned with the broader trend.
//======================================================

function analyzeTrendHealth(
    trend4H,
    delta30M,
    momentum1H
) {

    if (
        !trend4H ||
        !delta30M ||
        !momentum1H
    ) {

        return {

            trend:
                "UNKNOWN",

            exhaustion:
                "UNKNOWN",

            action:
                "MONITOR"

        };

    }


    const bullish =
        trend4H.trendState === 1;


    const bearish =
        trend4H.trendState === -1;


    //==================================================
    // MOMENTUM ALIGNMENT
    //==================================================

    const momentumAligned =
        (
            bullish &&
            momentum1H.current > 0
        ) ||
        (
            bearish &&
            momentum1H.current < 0
        );


    //==================================================
    // DELTA ALIGNMENT
    //==================================================

    const deltaAligned =
        (
            bullish &&
            (
                delta30M.trend ===
                "HIGHER POSITIVE" ||

                delta30M.trend ===
                "LOWER POSITIVE"
            )
        ) ||

        (
            bearish &&
            (
                delta30M.trend ===
                "LOWER NEGATIVE" ||

                delta30M.trend ===
                "HIGHER NEGATIVE"
            )
        );


    //==================================================
    // MOMENTUM WEAKENING
    //==================================================

    const momentumWeakening =
        momentum1H.state ===
        "DECELERATING";


    //==================================================
    // ORDER FLOW WEAKENING
    //==================================================

    const deltaWeakening =
        (
            bullish &&
            delta30M.trend ===
            "LOWER POSITIVE"
        ) ||

        (
            bearish &&
            delta30M.trend ===
            "HIGHER NEGATIVE"
        );


    //==================================================
    // HIGH EXHAUSTION
    //
    // Momentum has moved against the broader trend.
    //==================================================

    if (
        !momentumAligned
    ) {

        return {

            trend:
                "WEAKENING",

            exhaustion:
                "HIGH",

            action:
                "MONITOR"

        };

    }


    //==================================================
    // MODERATE EXHAUSTION
    //
    // Order flow no longer confirms the broader trend.
    //==================================================

    if (
        !deltaAligned
    ) {

        return {

            trend:
                "WEAKENING",

            exhaustion:
                "MODERATE",

            action:
                "MONITOR"

        };

    }


    //==================================================
    // MOMENTUM + DELTA BOTH WEAKENING
    //==================================================

    if (
        momentumWeakening &&
        deltaWeakening
    ) {

        return {

            trend:
                "WEAKENING",

            exhaustion:
                "MODERATE",

            action:
                "MONITOR"

        };

    }


    //==================================================
    // ONE COMPONENT WEAKENING
    //==================================================

    if (
        momentumWeakening ||
        deltaWeakening
    ) {

        return {

            trend:
                "WEAKENING",

            exhaustion:
                "MODERATE",

            action:
                "MONITOR"

        };

    }


    //==================================================
    // HEALTHY TREND
    //==================================================

    return {

        trend:
            "HEALTHY",

        exhaustion:
            "LOW",

        action:
            "HOLD"

    };

}


//======================================================
// ALIGNMENT SCORE
//
// 4H BROADER TREND
//
// BULLISH  = 50 POINTS
// BEARISH  = 50 POINTS
//
// 30M:
//
// Bullish:
// HIGHER POSITIVE = +50
// LOWER POSITIVE  = +25
//
// Bearish:
// LOWER NEGATIVE  = +50
// HIGHER NEGATIVE = +25
//
// Conflicting conditions = 0
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
// CALCULATE COIN SCORE
//======================================================

async function calculateCoinScore(
    symbol
) {

    try {

        let delta30M =
            null;

        let trend4H =
            null;

        let momentum1H =
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


        // Remove currently forming candle.

        const closed30M =
            candles30M.slice(
                0,
                -1
            );


        const currentPrice =
            Number(
                closed30M[
                    closed30M.length - 1
                ].close
            );


        if (
            !Number.isFinite(
                currentPrice
            )
        ) {

            log(
                `Current price unavailable for ${symbol}`
            );

            return null;

        }


        //================================================
        // 30M CUMULATIVE DELTA
        //================================================

        const delta30MSeries =
            calculateCumulativeDelta(
                closed30M
            );


        delta30M =
            analyzeDelta(
                delta30MSeries
            );


        if (
            !delta30M
        ) {

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


            if (
                !trend4H
            ) {

                log(
                    `4H Trend/ATR calculation unavailable for ${symbol}`
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
        // 1H DATA
        //================================================

        const candles1H =
            await fetchFuturesKlines(
                symbol,
                "1h",
                60
            );


        if (
            candles1H &&
            candles1H.length >=
            (
                (MOMENTUM_LOOKBACK_1H * 2) + 2
            )
        ) {

            const closed1H =
                candles1H.slice(
                    0,
                    -1
                );


            momentum1H =
                calculate1HMomentum(
                    closed1H
                );

        }

        else {

            log(
                `1H Momentum data unavailable for ${symbol}. Candles received: ${
                    candles1H
                        ? candles1H.length
                        : 0
                }`
            );

        }


        //================================================
        // TREND HEALTH
        //================================================

        const trendHealth =
            analyzeTrendHealth(
                trend4H,
                delta30M,
                momentum1H
            );


        //================================================
        // ALIGNMENT SCORE
        //================================================

        const alignmentScore =
            calculateAlignmentScore(
                trend4H,
                delta30M
            );


        //================================================
        // DELTA STRENGTH
        //================================================

        const orderFlowStrength =
            Math.abs(
                delta30M.deltaChange
            );


        //================================================
        // RETURN RESULT
        //================================================

        return {

            symbol,

            currentPrice,

            delta30M,

            trend4H,

            momentum1H,

            trendHealth,

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
// PROCESS:
//
// 1. Scan ALL coins
//
// 2. Filter coins that pass ALL requirements:
//
//    4H TREND
//    • BULLISH or BEARISH
//
//    1H MOMENTUM
//    • Must agree with 4H trend
//
//    30M DELTA
//    • Must agree with 4H trend
//
//    TREND HEALTH
//    • Must be HEALTHY
//
//    EXHAUSTION
//    • Must be LOW
//
// 3. Rank ONLY eligible coins
//
// 4. Show TOP 7
//
// Ranking:
//
// 1. Alignment Score
// 2. 30M Delta Movement as tie-breaker
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

                if (
                    result
                ) {

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
        // FILTER ELIGIBLE TRENDING COINS
        //
        // A coin MUST pass ALL conditions:
        //
        // 1. 4H TREND = BULLISH or BEARISH
        // 2. 1H MOMENTUM agrees with 4H trend
        // 3. 30M DELTA agrees with 4H trend
        // 4. TREND = HEALTHY
        // 5. EXHAUSTION = LOW
        //
        // Only coins passing every condition can
        // enter the TOP 7.
        //================================================

        const eligibleCoins =
            results.filter(
                (
                    coin
                ) => {

                    if (
                        !coin ||
                        !coin.trend4H ||
                        !coin.momentum1H ||
                        !coin.delta30M ||
                        !coin.trendHealth
                    ) {

                        return false;

                    }


                    const trendState =
                        coin.trend4H.trendState;


                    //================================================
                    // BULLISH TREND
                    //================================================

                    if (
                        trendState === 1
                    ) {

                        // 1H momentum must be positive

                        const bullishMomentum =
                            coin.momentum1H.direction ===
                            "POSITIVE";


                        // 30M delta must be positive

                        const bullishDelta =
                            coin.delta30M.trend ===
                                "HIGHER POSITIVE" ||

                            coin.delta30M.trend ===
                                "LOWER POSITIVE";


                        // Trend must be healthy

                        const healthy =
                            coin.trendHealth.trend ===
                            "HEALTHY";


                        // Exhaustion must be low

                        const lowExhaustion =
                            coin.trendHealth.exhaustion ===
                            "LOW";


                        return (
                            bullishMomentum &&
                            bullishDelta &&
                            healthy &&
                            lowExhaustion
                        );

                    }


                    //================================================
                    // BEARISH TREND
                    //================================================

                    if (
                        trendState === -1
                    ) {

                        // 1H momentum must be negative

                        const bearishMomentum =
                            coin.momentum1H.direction ===
                            "NEGATIVE";


                        // 30M delta must be negative

                        const bearishDelta =
                            coin.delta30M.trend ===
                                "LOWER NEGATIVE" ||

                            coin.delta30M.trend ===
                                "HIGHER NEGATIVE";


                        // Trend must be healthy

                        const healthy =
                            coin.trendHealth.trend ===
                            "HEALTHY";


                        // Exhaustion must be low

                        const lowExhaustion =
                            coin.trendHealth.exhaustion ===
                            "LOW";


                        return (
                            bearishMomentum &&
                            bearishDelta &&
                            healthy &&
                            lowExhaustion
                        );

                    }


                    //================================================
                    // NEUTRAL 4H = NOT ELIGIBLE
                    //================================================

                    return false;

                }
            );


        //================================================
        // TOP 7
        //
        // Rank ONLY coins that passed ALL filters.
        //
        // 1. Highest alignment score
        // 2. Strongest 30M delta movement breaks ties
        //================================================

        const top7 =
            eligibleCoins
                .sort(
                    (
                        a,
                        b
                    ) => {

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
`⚡ *COIN TREND REPORT*
🕐 30-MINUTE UPDATE

📊 4H = BROADER TREND
📈 1H = MOMENTUM
⚡ 30M = ORDER FLOW
🎯 ATR = ACTIVE SUPPORT / RESISTANCE

🏆 *TOP 7 HEALTHY TRENDING COINS*

`;


        //================================================
        // NO ELIGIBLE COINS
        //================================================

        if (
            top7.length === 0
        ) {

            msg +=
`⚪ *NO QUALIFYING COINS*

No coin currently satisfies all of the following:

• 4H trend
• 1H momentum aligned
• 30M delta aligned
• Healthy trend
• Low exhaustion

The scanner is still monitoring all coins.

`;

        }


        //================================================
        // TOP 7 COINS
        //================================================

        else {

            top7.forEach(
                (
                    coin,
                    index
                ) => {

                    const d30 =
                        coin.delta30M;

                    const t4 =
                        coin.trend4H;

                    const momentum =
                        coin.momentum1H;

                    const health =
                        coin.trendHealth;


                    //================================================
                    // 4H TREND
                    //================================================

                    const trendLabel =
                        t4
                            ? (
                                t4.trendState === 1
                                    ? "🟢 BULLISH"
                                    : t4.trendState === -1
                                        ? "🔴 BEARISH"
                                        : "⚪ NEUTRAL"
                            )
                            : "⚪ UNKNOWN";


                    //================================================
                    // ATR ACTIVE SUPPORT / RESISTANCE
                    //================================================

                    let atrText =
                        "⚪ N/A";

                    let distanceText =
                        "N/A";


                    if (
                        t4 &&
                        t4.activeLevel !== null
                    ) {

                        const distance =
                            Math.abs(
                                coin.currentPrice -
                                Number(
                                    t4.activeLevel
                                )
                            );


                        if (
                            Number.isFinite(
                                distance
                            )
                        ) {

                            distanceText =
                                distance.toFixed(
                                    6
                                );

                        }

                    }


                    if (
                        t4
                    ) {

                        if (
                            t4.trendState === 1
                        ) {

                            atrText =
                                `🟢 SUPPORT @ ${
                                    t4.activeLevel !== null
                                        ? t4.activeLevel.toFixed(6)
                                        : "N/A"
                                }`;

                        }

                        else if (
                            t4.trendState === -1
                        ) {

                            atrText =
                                `🔴 RESISTANCE @ ${
                                    t4.activeLevel !== null
                                        ? t4.activeLevel.toFixed(6)
                                        : "N/A"
                                }`;

                        }

                    }


                    //================================================
                    // 1H MOMENTUM
                    //================================================

                    let momentumText =
                        "N/A";


                    if (
                        momentum
                    ) {

                        const momentumIcon =
                            momentum.state ===
                            "DECELERATING"
                                ? "🟡"
                                : "🟢";


                        const momentumValue =
                            momentum.current >= 0
                                ? `+${momentum.current.toFixed(3)}`
                                : momentum.current.toFixed(3);


                        momentumText =
                            `${momentumValue} ${momentumIcon}`;

                    }


                    //================================================
                    // 30M DELTA
                    //================================================

                    const flowText =
                        d30
                            ? d30.trend
                            : "N/A";


                    //================================================
                    // TREND HEALTH
                    //================================================

                    const trendIcon =
                        health.trend ===
                        "HEALTHY"
                            ? "🟢"
                            : health.trend ===
                              "WEAKENING"
                                ? "🟡"
                                : "🔴";


                    //================================================
                    // EXHAUSTION
                    //================================================

                    const exhaustionIcon =
                        health.exhaustion ===
                        "LOW"
                            ? "🟢"
                            : health.exhaustion ===
                              "MODERATE"
                                ? "🟡"
                                : "🔴";


                    //================================================
                    // REPORT ENTRY
                    //================================================

                    msg +=
`${index + 1}. *${coin.symbol}*

📊 4H: ${trendLabel}
🎯 ATR: ${atrText}
📏 Distance: ${distanceText}
📈 1H MOM: ${momentumText}
⚡ 30M DELTA: ${flowText}

💪 TREND: ${trendIcon} ${health.trend}
⚠️ EXHAUSTION: ${exhaustionIcon} ${health.exhaustion}
➡️ ${health.action}

`;


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
`━━━━━━━━━━━━━━━━━━━━

📌 *FILTER*
4H trend must be established
1H momentum must agree
30M delta must agree
Trend must be HEALTHY
Exhaustion must be LOW

📌 *GUIDE*
🟢 HEALTHY = trend intact
🟡 WEAKENING = momentum/order flow fading
🔴 HIGH EXHAUSTION = reversal risk elevated

⚠️ *INFORMATIONAL ONLY*
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

const ADMIN_CHAT_ID = 1718404728; // <-- Replace with your Telegram chat ID

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

// =====================================================
// PRICE ACTIVATION COMMANDS
// =====================================================

// Set a price gate: /price BTCUSDT 105000
bot.onText(/^\/price\s+(\w+)\s+([\d.]+)$/i, async (msg, match) => {
  if (!isAdmin(msg)) return;

  const symbol = match[1].toUpperCase();
  const activationPrice = parseFloat(match[2]);

  if (!COIN_LIST.includes(symbol)) {
    await sendMessage(`⚠️ Symbol *${symbol}* is not in COIN_LIST.`);
    return;
  }

  if (!Number.isFinite(activationPrice) || activationPrice <= 0) {
    await sendMessage(`⚠️ Invalid activation price for *${symbol}*.`);
    return;
  }

  priceActivationLevels[symbol] = activationPrice;
  priceActivated[symbol] = false;
  delete priceActivationPreviousPrice[symbol];

  await sendMessage(
    `🎯 *PRICE ACTIVATION SET*\n\n` +
    `🪙 Coin: *${symbol}*\n` +
    `💰 Activation Price: *${activationPrice}*\n\n` +
    `🔒 ${symbol} is now locked until price crosses the activation level.\n` +
    `After activation, the normal STC + Trend-Reset Delta strategy will decide the entry.`
  );
});

// Remove a price gate: /priceoff BTCUSDT
bot.onText(/^\/priceoff\s+(\w+)$/i, async (msg, match) => {
  if (!isAdmin(msg)) return;

  const symbol = match[1].toUpperCase();

  if (!COIN_LIST.includes(symbol)) {
    await sendMessage(`⚠️ Symbol *${symbol}* is not in COIN_LIST.`);
    return;
  }

  delete priceActivationLevels[symbol];
  delete priceActivated[symbol];
  delete priceActivationPreviousPrice[symbol];

  await sendMessage(
    `🔓 *PRICE ACTIVATION REMOVED*\n\n` +
    `🪙 *${symbol}* no longer has a price activation gate.\n` +
    `Its normal /activate and /deactivate status remains unchanged.`
  );
});

// Show all price gates: /pricestatus
bot.onText(/^\/pricestatus$/i, async (msg) => {
  if (!isAdmin(msg)) return;

  const symbols = Object.keys(priceActivationLevels);

  if (!symbols.length) {
    await sendMessage(
      `🎯 *PRICE ACTIVATION STATUS*\n\nNo price activation levels are configured.`
    );
    return;
  }

  let message = `🎯 *PRICE ACTIVATION STATUS*\n\n`;

  for (const symbol of symbols) {
    const activated = priceActivated[symbol] === true;
    message +=
      `${activated ? "🟢" : "🔒"} *${symbol}*\n` +
      `Activation: *${priceActivationLevels[symbol]}*\n` +
      `Status: *${activated ? "ACTIVATED" : "WAITING"}*\n\n`;
  }

  await sendMessage(message);
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
// Shows ONLY coins that are currently active for trading.
// Traded coins are intentionally excluded.
// =====================================================

bot.onText(/^\/activecoins$/, async (msg) => {
  try {
    const activeCoins = COIN_LIST.filter(
      symbol => symbolActive[symbol] !== false
    );

    if (!activeCoins.length) {
      await sendMessage(
        "⚪ *ACTIVE COINS*\n\n" +
        "No coins are currently active for trading."
      );
      return;
    }

    let message = `⚡ *ACTIVE COINS*\n\n`;

    activeCoins.forEach((symbol, index) => {
      message += `${index + 1}. 🟢 *${symbol}*\n`;
    });

    message += `\n📊 Total Active Coins: *${activeCoins.length}*`;

    await sendMessage(message);
  } catch (err) {
    log(`❌ /activecoins error: ${err?.message || err}`);
  }
});

// =====================================================
// /tradehistory
// Shows all successful trades placed during the current
// day. The history automatically starts fresh each day.
// =====================================================

bot.onText(/^\/tradehistory$/, async (msg) => {
  try {
    const today = getTradeHistoryDate();

    // Keep only today's trades. Older entries naturally fall
    // out of the displayed history when the date changes.
    tradeHistory = tradeHistory.filter(trade => trade.date === today);

    if (!tradeHistory.length) {
      await sendMessage(
        `📜 *TRADE HISTORY — ${today}*\n\n` +
        "No trades have been placed today."
      );
      return;
    }

    let message = `📜 *TRADE HISTORY — ${today}*\n\n`;

    tradeHistory.forEach((trade, index) => {
      const time = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Africa/Lagos",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
      }).format(new Date(trade.timestamp));

      message +=
        `${index + 1}. *${trade.symbol}* — ${trade.direction === "BUY" ? "🟢 LONG" : "🔴 SHORT"}\n` +
        `   💵 Entry: *${trade.entryPrice}*\n` +
        `   🕐 Time: ${time}\n` +
        `   📦 Qty: ${trade.qty}\n` +
        `   👤 User: ${trade.userId}\n\n`;
    });

    message += `📊 Total Trades Today: *${tradeHistory.length}*`;

    await sendMessage(message);
  } catch (err) {
    log(`❌ /tradehistory error: ${err?.message || err}`);
  }
});
