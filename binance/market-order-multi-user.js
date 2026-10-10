// =====================================================
// FULL AUTO MULTI-USER MARKET ORDER BOT - BINANCE FUTURES (USDT-PERP)
// STC MONITOR: 1H STC = informational trend context; 5M volume imbalance + zone logic = execution
// TP/SL/TRAILING STOP INTACT
// Volume imbalance report uses 5M closed candles
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
const TELEGRAM_BOT_TOKEN = "8822289821:AAGEdXlXQzPdq0Czh3pcNiRCYl83ZAXBBvw";
const GROUP_CHAT_ID = "-1003419090746";
const ADMIN_NOTIFICATION_IDS = [
  "1718404728", // Existing admin notification recipient
  "6907653103"  // Additional admin: receives bot information and alerts
];
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// --- USERS FILE ---
const USERS_FILE = "./users.json";
const ACTIVE_TRADES_FILE = "./active_trades.json";

// --- Settings ---
const TRADE_PERCENT = 0.1;
const LEVERAGE = 20;
const RUNNER_ACTIVATION_PCT = 2;
const RUNNER_POST_ACTIVATION_EXTRA_PCT = 1;
const RUNNER_POST_ACTIVATION_TIMEOUT_MS = 30 * 60 * 1000;
const SL_PCT = 1.8;
const TRAILING_STOP_PCT = 5;
const MONITOR_INTERVAL_MS = 5000;
const SIGNAL_CHECK_INTERVAL_MS = 60 * 1000;
const MAX_TRADES = 7; // per user
const COOLDOWN_MS = 120 * 60 * 1000; // 2 hours

// --- Liquidity filter ---
// These checks run immediately before a trade is allowed to execute.
const LIQUIDITY_MIN_24H_QUOTE_VOLUME_USDT = 5_000_000;
const LIQUIDITY_MAX_SPREAD_PCT = 0.15;
const LIQUIDITY_MIN_BOOK_DEPTH_MULTIPLE = 10;
const LIQUIDITY_MIN_BOOK_DEPTH_USDT = 25_000;

// --- Stop-loss liquidity diagnostic (informational only) ---
const SL_LIQUIDITY_LOOKBACK_CANDLES = 48;
const SL_LIQUIDITY_SWING_STRENGTH = 2;
const SL_LIQUIDITY_NEAR_PERCENT = 0.25;
const SL_LIQUIDITY_INSIDE_PERCENT = 0.10;
const SL_LIQUIDITY_EQUAL_LEVEL_PERCENT = 0.10;
const SL_LIQUIDITY_ORDER_BOOK_LEVELS = 20;
const SL_LIQUIDITY_ORDER_BOOK_NEAR_PERCENT = 0.20;
const SL_ORDER_BLOCK_LOOKBACK_CANDLES = 36;
const SL_ORDER_BLOCK_DISPLACEMENT_MULTIPLIER = 1.5;
const SL_ORDER_BLOCK_NEAR_PERCENT = 0.25;
const SL_ORDER_BLOCK_INSIDE_PERCENT = 0.10;

// --- Absorption warnings ---
// Absorption threshold for reversal setups. A reversal cannot proceed until
// the ATR-zone absorption check reaches at least this volume multiple.
const ABSORPTION_VOLUME_MULTIPLE = 2.0;
const ABSORPTION_MAX_BODY_TO_RANGE = 0.35;
const ABSORPTION_MIN_WICK_TO_RANGE = 0.45;
const ABSORPTION_ALERT_COOLDOWN_MS = 15 * 60 * 1000;
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
  "ARBUSDT",
  "AKTUSDT",
  "GRTUSDT",
  "STRKUSDT",
  "AEROUSDT",
  "BRETTUSDT",
  "JUPUSDT",
  "OPUSDT",
  "ZKUSDT",
];

// --- In-memory ---
let activePositions = {}; // { symbol: { userId: position } }
let runnerActivationNotified = {}; // { symbol: true }
let userClients = {};
let BOT_PAUSED = false;
let symbolCooldowns = {}; // { symbol: timestamp }
let tradeHistory = []; // Successful trades placed by the bot
let absorptionWarningState = {}; // { symbol: { BUY/SELL: candleKey } }
let liquidityWarningState = {}; // { symbol: lastWarningTimestamp }
let slLiquidityReportSent = {}; // { symbol: true }

// --- Persistent active-trade state ---
// For this test, the bot restores active positions from local JSON after a restart.
function saveActivePositions() {
  try {
    const tempFile = `${ACTIVE_TRADES_FILE}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(activePositions, null, 2), "utf8");
    fs.renameSync(tempFile, ACTIVE_TRADES_FILE);
  } catch (err) {
    log(`❌ saveActivePositions error: ${err?.message || err}`);
  }
}

function loadActivePositions() {
  try {
    if (!fs.existsSync(ACTIVE_TRADES_FILE)) {
      log("ℹ️ No active_trades.json found. Starting with no restored positions.");
      return;
    }

    const raw = fs.readFileSync(ACTIVE_TRADES_FILE, "utf8").trim();
    if (!raw) return;

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      log("⚠️ active_trades.json has an invalid format. Ignoring it.");
      return;
    }

    activePositions = parsed;

    let restored = 0;
    for (const users of Object.values(activePositions)) {
      if (users && typeof users === "object") restored += Object.keys(users).length;
    }

    log(`♻️ Restored ${restored} active trade record(s) from ${ACTIVE_TRADES_FILE}.`);
    if (restored > 0) {
      sendMessage(`♻️ *TRADE STATE RESTORED*\n\nRecovered *${restored}* active trade record(s) from local JSON after restart.`).catch(() => {});
    }
  } catch (err) {
    log(`❌ loadActivePositions error: ${err?.message || err}`);
  }
}

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
let script2PendingSetups = {}; // { symbol: reversal setup OR staged continuation setup }
let script2ZoneAbsorptionState = {}; // observation-only state for liquidity-zone absorption tracking
let script2CheckpointState = {}; // per-symbol Telegram checkpoint state
let script2MomentumRegimeState = {}; // per-symbol market-regime checkpoint state
let script2DeltaGateState = {}; // per-symbol 15M/5M delta alignment and confirmation state
let MANUAL_CYCLE = null; // "BULL" | "BEAR" | null

// --- Logging ---
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function awaitSendScript2Checkpoint(message) {
  return sendMessage(message).catch((err) => {
    log(`⚠️ Script 2 Telegram checkpoint failed: ${err?.message || err}`);
  });
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
// Restore JSON state only after Binance clients are ready. monitorPositions()
// will validate every restored record against Binance before managing it.
loadActivePositions();
setInterval(createBinanceClients, 60 * 1000);

// --- Telegram send ---
async function sendMessage(msg) {
  try {
    await bot.sendMessage(GROUP_CHAT_ID, msg, { parse_mode: "Markdown" });
  } catch {}

  // Deliver the same bot information to every configured admin.
  for (const adminChatId of ADMIN_NOTIFICATION_IDS) {
    try {
      await bot.sendMessage(adminChatId, msg, { parse_mode: "Markdown" });
    } catch (err) {
      log(`❌ Admin notification delivery failed for a configured recipient: ${err?.message || err}`);
    }
  }
}

// =====================================================
// MAJOR NEWS WARNING SYSTEM
// =====================================================
// Pulls today's high-impact U.S. economic releases and
// sends Telegram warnings as the release approaches.
// This is informational only and does NOT pause trading.
//
// Alert schedule for each event:
//   - Every 1 hour before the release (same event minute)
//   - 30 minutes before
//   - 15 minutes before
//   - 5 minutes before
//   - At release time
//
// Source: Xoomar Pulse economic calendar API, which publishes
// a JSON calendar sourced from official U.S. agencies.
// =====================================================
const NEWS_TIMEZONE = "Africa/Lagos";
const NEWS_CALENDAR_URL = "https://xoomar.com/api/markets/calendar";
const NEWS_CALENDAR_REFRESH_MS = 15 * 60 * 1000;
const NEWS_ALERT_CHECK_MS = 30 * 1000;
const NEWS_HOURLY_MAX_HOURS = 12;

let majorNewsEvents = [];
let newsAlertState = {}; // { eventKey: { alertKeys: {} } }
let newsCalendarDate = null;

function getLagosDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: NEWS_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const out = {};
  for (const part of parts) {
    if (part.type !== "literal") out[part.type] = part.value;
  }
  return out;
}

function getLagosDateString(date = new Date()) {
  const p = getLagosDateParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

function formatNewsTime(date) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: NEWS_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function formatNewsDate(date) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: NEWS_TIMEZONE,
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

function normalizeNewsEvent(event, index) {
  if (!event || !event.scheduledAt) return null;

  const scheduledAt = new Date(event.scheduledAt);
  if (Number.isNaN(scheduledAt.getTime())) return null;

  const currency = String(event.currency || event.currencyCode || "").toUpperCase();
  const impact = String(event.importance || event.impact || "").toLowerCase();
  const eventName = String(event.eventName || event.event || event.name || "").trim();

  if (!eventName) return null;

  // Focus on USD events because they are the primary macro driver
  // relevant to the dollar and crypto market in this warning system.
  if (currency !== "USD") return null;

  const isHighImpact = ["high", "red", "3", "very high"].includes(impact);
  if (!isHighImpact) return null;

  const lagosDate = getLagosDateString(scheduledAt);
  const today = getLagosDateString();
  if (lagosDate !== today) return null;

  const id = String(event.id || event.eventId || `${eventName}-${scheduledAt.toISOString()}-${index}`);

  return {
    id,
    eventName,
    currency,
    impact: "HIGH",
    scheduledAt,
    forecast: event.forecast ?? null,
    previous: event.previous ?? null,
    actual: event.actual ?? null,
  };
}

async function fetchMajorNewsEvents() {
  try {
    const today = getLagosDateString();
    const url = `${NEWS_CALENDAR_URL}?importance=high&from=${today}&to=${today}`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const payload = await res.json();
    const rawEvents = Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.events)
        ? payload.events
        : [];

    const normalized = rawEvents
      .map(normalizeNewsEvent)
      .filter(Boolean)
      .sort((a, b) => a.scheduledAt - b.scheduledAt);

    majorNewsEvents = normalized;
    newsCalendarDate = today;

    // Remove stale alert state for events no longer present.
    const validIds = new Set(normalized.map(event => event.id));
    for (const key of Object.keys(newsAlertState)) {
      if (!validIds.has(key)) delete newsAlertState[key];
    }

    log(`📰 Major news calendar refreshed: ${majorNewsEvents.length} high-impact USD event(s) today.`);
  } catch (err) {
    log(`❌ Major news calendar error: ${err?.message || err}`);
  }
}

function getNewsAlertKey(minutesRemaining, event) {
  // Release alert: allow a short delivery window after the scheduled time
  // so a 30-second polling cycle does not miss the notification.
  if (minutesRemaining <= 0 && minutesRemaining >= -5) return "RELEASE";

  // Short countdown alerts. Each alert owns its own threshold so a delayed
  // scheduler can still deliver the correct warning once it catches up.
  if (minutesRemaining > 0 && minutesRemaining <= 5) return "5M";
  if (minutesRemaining > 5 && minutesRemaining <= 15) return "15M";
  if (minutesRemaining > 15 && minutesRemaining <= 30) return "30M";
  if (minutesRemaining > 30 && minutesRemaining <= 60) return "60M";

  // Hourly alerts are tied to the event's exact release minute, but use a
  // 5-minute delivery window so temporary network/scheduler delays do not
  // cause the bot to miss the warning.
  const hoursRemaining = Math.round(minutesRemaining / 60);
  if (
    hoursRemaining >= 1 &&
    hoursRemaining <= NEWS_HOURLY_MAX_HOURS &&
    Math.abs(minutesRemaining - hoursRemaining * 60) <= 5
  ) {
    return `${hoursRemaining}H`;
  }

  return null;
}

async function sendNewsMessage(message) {
  // News has its own sender so Telegram delivery failures are visible in the
  // bot log instead of being silently swallowed by the general sendMessage().
  let delivered = false;

  try {
    await bot.sendMessage(GROUP_CHAT_ID, message, { parse_mode: "Markdown" });
    delivered = true;
  } catch (err) {
    log(`❌ News Telegram group delivery failed: ${err?.message || err}`);
  }

  for (const adminChatId of ADMIN_NOTIFICATION_IDS) {
    try {
      await bot.sendMessage(adminChatId, message, { parse_mode: "Markdown" });
      delivered = true;
    } catch (err) {
      log(`❌ News Telegram admin delivery failed for a configured recipient: ${err?.message || err}`);
    }
  }

  return delivered;
}

async function sendMajorNewsWarning(event, minutesRemaining, alertKey) {
  const timeText = formatNewsTime(event.scheduledAt);
  const dateText = formatNewsDate(event.scheduledAt);

  let countdownText;
  if (alertKey === "RELEASE") {
    countdownText = "🚨 *RELEASE TIME — HIGH VOLATILITY WINDOW*";
  } else if (alertKey.endsWith("H")) {
    const hours = Number(alertKey.slice(0, -1));
    countdownText = `⏳ *${hours} HOUR${hours === 1 ? "" : "S"} REMAINING*`;
  } else {
    countdownText = `⏳ *${alertKey} REMAINING*`;
  }

  let message =
    `⚠️ *MAJOR USD NEWS WARNING*\n\n` +
    `🇺🇸 *${event.eventName}*\n` +
    `🔥 Impact: *HIGH*\n` +
    `📅 ${dateText}\n` +
    `🕐 Release: *${timeText} WAT*\n\n` +
    `${countdownText}\n\n` +
    `This release can cause significant volatility in the *U.S. dollar and crypto markets*.\n` +
    `⚠️ Rapid price spikes, reversals and wider-than-normal market movement are possible.\n` +
    `📌 This is an *informational warning only*; the bot's trading logic is unchanged.`;

  // Xoomar calendar data does not reliably provide a forecast field.
  // Report only values actually supplied by the calendar.
  if (event.previous !== null || event.actual !== null) {
    message += `\n\n📊 Previous: *${event.previous ?? "N/A"}*`;
    if (event.actual !== null) {
      message += `\n📈 Actual: *${event.actual}*`;
    }
  }

  const delivered = await sendNewsMessage(message);
  return delivered;
}

async function monitorMajorNewsAlerts() {
  try {
    const now = new Date();
    const today = getLagosDateString(now);

    if (newsCalendarDate !== today) {
      await fetchMajorNewsEvents();
    }

    for (const event of majorNewsEvents) {
      const minutesRemaining = (event.scheduledAt.getTime() - now.getTime()) / 60000;

      // Ignore events more than 5 minutes after release. The 5-minute
      // grace window above is specifically for reliable release reporting.
      if (minutesRemaining < -5) continue;

      const alertKey = getNewsAlertKey(minutesRemaining, event);
      if (!alertKey) continue;

      if (!newsAlertState[event.id]) newsAlertState[event.id] = { alertKeys: {} };
      if (newsAlertState[event.id].alertKeys[alertKey]) continue;

      const delivered = await sendMajorNewsWarning(event, minutesRemaining, alertKey);

      // Only mark an alert as sent after at least one Telegram destination
      // accepted it. A failed delivery can therefore be retried next cycle.
      if (delivered) {
        newsAlertState[event.id].alertKeys[alertKey] = true;
      }
    }
  } catch (err) {
    log(`❌ Major news alert monitor error: ${err?.message || err}`);
  }
}

// Refresh the calendar regularly so newly added or revised releases
// can be picked up during the day.
fetchMajorNewsEvents();
setInterval(fetchMajorNewsEvents, NEWS_CALENDAR_REFRESH_MS);
setInterval(monitorMajorNewsAlerts, NEWS_ALERT_CHECK_MS);

// --- Fetch Futures Klines ---
async function fetchFuturesKlines(symbol, interval = "15m", limit = 100) {
  try {
    const res = await fetch(
      `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.map((c) => ({
      time: c[0],
      open: +c[1],
      high: +c[2],
      low: +c[3],
      close: +c[4],
      volume: +c[5],
      quoteVolume: +c[7],
      takerBuyVolume: +c[9],
      takerBuyQuoteVolume: +c[10]
    }));
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
// Used by the 15M/5M master unlock: alignment first, then 5M strength confirmation.
// ======================================================

const TR_DELTA_EMA_LENGTH = 20;
const TR_DELTA_ATR_LENGTH = 14;
const TR_DELTA_ATR_MULTIPLIER = 1;
const TR_DELTA_MA_LENGTH = 10;

// Minimum adaptive Delta strength required for a new entry.
// 1.5 = Delta must reach at least 150% of the recent average
// absolute bar-delta movement beyond the Delta MA.
const DELTA_STRENGTH_THRESHOLD = 1.5;
const DELTA_STRENGTH_LOOKBACK = 20;

// 5M OBV entry confirmation.
// OBV is a directional confirmation only. A fresh crossover and minimum
// separation are NOT required. The latest CLOSED 5M OBV only needs to be
// on the correct side of its 50 EMA.
const OBV_EMA_LENGTH = 50;
const OBV_CONFIRMATION_CANDLES = 1;
const ENTRY_VOLUME_IMBALANCE_MIN_PERCENT = 70;

// Script 2 continuation confirmation settings.
// A directional 1-candle imbalance creates a candidate only. Continuation
// becomes executable only after a CLOSED 5M candle breaks the relevant zone
// with high directional momentum and sufficient ATR-relative candle size.
// Continuation candidates are NOT time-expired. They remain valid while
// price stays within this distance of the anchored structure level.
const SCRIPT2_CONTINUATION_MAX_DISTANCE_PERCENT = 1.0;
// High-momentum continuation uses the breakout candle's directional momentum.
// Candle momentum = signed body / full candle range. A directional BOS at or
// above 0.50 can enter without waiting for a retest; regime classification is 0.40.
const SCRIPT2_HIGH_MOMENTUM_THRESHOLD = 0.5;
// Adequate momentum uses the original regime threshold and requires BOS + retest.
const ADEQUATE_MOMENTUM_THRESHOLD = 0.25;
const SCRIPT2_CONTINUATION_MAX_RETEST_CANDLES = 3;
// BOS candle range/ATR is intentionally not required.

// Global market-activity regime gate. Adequate and high regimes can create
// new setups; low momentum remains blocked. Direction-neutral.
const MARKET_REGIME_HIGH_MOMENTUM_THRESHOLD = 0.40;
const MARKET_REGIME_ATR_EXPANSION_MIN_RATIO = 1.00;
const MARKET_REGIME_VOLUME_EXPANSION_MIN_RATIO = 1.00;
const MARKET_REGIME_RECENT_RANGE_CANDLES = 5;
const MARKET_REGIME_BASELINE_CANDLES = 20;
const MARKET_REGIME_RECENT_VOLUME_CANDLES = 3;
const MARKET_REGIME_MIN_SCORE = 2;

// Script 2 entry-zone settings. Price must interact with a detected
// liquidity level or order block before the 1-candle imbalance is evaluated.
const SCRIPT2_ZONE_TOLERANCE_PERCENT = 0.10;
const SCRIPT2_ZONE_LOOKBACK_CANDLES = 36;

// Script 2 location filter. A liquidity/order-block zone qualifies only
// when it is located at/near an ATR high or ATR low area. The ATR location
// is measured against either the current-day or previous-day high/low.
const SCRIPT2_ATR_LOCATION_MAX_DISTANCE_ATR = 0.20;

// 5M ATR-band calculations are retained only for existing trade-progress context.
// ATR contraction/expansion is NOT an entry condition.
const ATR_BAND_EMA_LENGTH = 20;
const ATR_BAND_ATR_LENGTH = 14;
const ATR_BAND_MULTIPLIER = 1;


// ======================================================
// MARKET MOMENTUM / ACTIVITY REGIME
// ======================================================
// This is intentionally direction-neutral. It answers only:
// "Is the market active enough to justify starting a new setup?"
// It does NOT decide BUY vs SELL. Reversal direction still comes from
// absorption at the ATR high/low zone, while continuation direction still
// comes from the existing volume-imbalance + BOS logic.
//
// Score components:
// 1) Recent candle momentum activity: average ABS(body/range) over the
//    most recent closed 5M candles must reach the original adequate threshold.
// 2) ATR activity: recent average true range must be at least the baseline.
// 3) Volume activity: recent average volume must be at least the baseline.
//
// At least 2 of 3 must pass. The momentum score then separates adequate
// (0.25+) from high momentum (0.40+).
function getScript2MomentumRegime(closedCandles5) {
  if (!Array.isArray(closedCandles5) || closedCandles5.length < 35) {
    return {
      allowed: false,
      regime: "LOW_MOMENTUM",
      score: 0,
      candleMomentum: null,
      atrRatio: null,
      volumeRatio: null,
      candleMomentumPassed: false,
      atrPassed: false,
      volumePassed: false
    };
  }

  const recentCandles = closedCandles5.slice(-MARKET_REGIME_RECENT_RANGE_CANDLES);
  const baselineStart = -(MARKET_REGIME_RECENT_RANGE_CANDLES + MARKET_REGIME_BASELINE_CANDLES);
  const baselineEnd = -MARKET_REGIME_RECENT_RANGE_CANDLES;
  const baselineCandles = closedCandles5.slice(baselineStart, baselineEnd);
  const recentVolumeCandles = closedCandles5.slice(-MARKET_REGIME_RECENT_VOLUME_CANDLES);
  const volumeBaselineCandles = closedCandles5.slice(
    -(MARKET_REGIME_RECENT_VOLUME_CANDLES + MARKET_REGIME_BASELINE_CANDLES),
    -MARKET_REGIME_RECENT_VOLUME_CANDLES
  );

  const momentumValues = recentCandles
    .map((candle) => {
      const open = Number(candle.open);
      const high = Number(candle.high);
      const low = Number(candle.low);
      const close = Number(candle.close);
      const range = high - low;
      return Number.isFinite(open) && Number.isFinite(high) &&
        Number.isFinite(low) && Number.isFinite(close) && range > 0
        ? Math.abs((close - open) / range)
        : null;
    })
    .filter(Number.isFinite);

  const candleMomentum = momentumValues.length
    ? momentumValues.reduce((sum, value) => sum + value, 0) / momentumValues.length
    : null;

  const trueRange = (candle, previousClose) => {
    const high = Number(candle.high);
    const low = Number(candle.low);
    const prev = Number(previousClose);
    if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(prev)) return null;
    return Math.max(high - low, Math.abs(high - prev), Math.abs(low - prev));
  };

  const recentAtrValues = [];
  const recentStartIndex = closedCandles5.length - MARKET_REGIME_RECENT_RANGE_CANDLES;
  for (let i = recentStartIndex; i < closedCandles5.length; i++) {
    const tr = trueRange(closedCandles5[i], closedCandles5[i - 1]?.close);
    if (Number.isFinite(tr) && tr > 0) recentAtrValues.push(tr);
  }

  const baselineAtrValues = [];
  const baselineStartIndex = closedCandles5.length - MARKET_REGIME_RECENT_RANGE_CANDLES - MARKET_REGIME_BASELINE_CANDLES;
  const baselineEndIndex = closedCandles5.length - MARKET_REGIME_RECENT_RANGE_CANDLES;
  for (let i = baselineStartIndex; i < baselineEndIndex; i++) {
    const tr = trueRange(closedCandles5[i], closedCandles5[i - 1]?.close);
    if (Number.isFinite(tr) && tr > 0) baselineAtrValues.push(tr);
  }

  const recentAtr = recentAtrValues.length
    ? recentAtrValues.reduce((sum, value) => sum + value, 0) / recentAtrValues.length
    : null;
  const baselineAtr = baselineAtrValues.length
    ? baselineAtrValues.reduce((sum, value) => sum + value, 0) / baselineAtrValues.length
    : null;
  const atrRatio = Number.isFinite(recentAtr) && Number.isFinite(baselineAtr) && baselineAtr > 0
    ? recentAtr / baselineAtr
    : null;

  const recentVolumes = recentVolumeCandles
    .map((candle) => Number(candle.volume))
    .filter((value) => Number.isFinite(value) && value > 0);
  const baselineVolumes = volumeBaselineCandles
    .map((candle) => Number(candle.volume))
    .filter((value) => Number.isFinite(value) && value > 0);

  const recentVolume = recentVolumes.length
    ? recentVolumes.reduce((sum, value) => sum + value, 0) / recentVolumes.length
    : null;
  const baselineVolume = baselineVolumes.length
    ? baselineVolumes.reduce((sum, value) => sum + value, 0) / baselineVolumes.length
    : null;
  const volumeRatio = Number.isFinite(recentVolume) && Number.isFinite(baselineVolume) && baselineVolume > 0
    ? recentVolume / baselineVolume
    : null;

  const candleMomentumPassed = Number.isFinite(candleMomentum) &&
    candleMomentum >= ADEQUATE_MOMENTUM_THRESHOLD;
  const atrPassed = Number.isFinite(atrRatio) &&
    atrRatio >= MARKET_REGIME_ATR_EXPANSION_MIN_RATIO;
  const volumePassed = Number.isFinite(volumeRatio) &&
    volumeRatio >= MARKET_REGIME_VOLUME_EXPANSION_MIN_RATIO;

  const score = [candleMomentumPassed, atrPassed, volumePassed]
    .filter(Boolean).length;
  const allowed = score >= MARKET_REGIME_MIN_SCORE;
  const highActivity = allowed && Number.isFinite(candleMomentum) &&
    candleMomentum >= MARKET_REGIME_HIGH_MOMENTUM_THRESHOLD;

  return {
    allowed,
    regime: allowed ? (highActivity ? "HIGH_MOMENTUM" : "ADEQUATE_MOMENTUM") : "LOW_MOMENTUM",
    score,
    candleMomentum,
    atrRatio,
    volumeRatio,
    candleMomentumPassed,
    atrPassed,
    volumePassed
  };
}

function maybeSendScript2MomentumRegimeCheckpoint(symbol, regime, candleKey) {
  if (!regime || !candleKey) return;

  const previous = script2MomentumRegimeState[symbol];
  const changed = !previous || previous.regime !== regime.regime;

  // Only report regime changes. This keeps the checkpoint useful for
  // studying transitions without creating a message every 5 minutes for
  // every symbol in a large scan universe.
  if (!changed) return;

  script2MomentumRegimeState[symbol] = {
    regime: regime.regime,
    candleKey
  };

  const scoreText = `${regime.score}/${3}`;
  const candleMomentumText = Number.isFinite(regime.candleMomentum)
    ? regime.candleMomentum.toFixed(2)
    : "N/A";
  const atrRatioText = Number.isFinite(regime.atrRatio)
    ? regime.atrRatio.toFixed(2)
    : "N/A";
  const volumeRatioText = Number.isFinite(regime.volumeRatio)
    ? regime.volumeRatio.toFixed(2)
    : "N/A";

  if (regime.allowed) {
    awaitSendScript2Checkpoint(
      `🟢 *MOMENTUM REGIME PASSED* — *${symbol}*\n` +
      `📈 Regime: *${regime.regime}*\n` +
      `⚡ Avg |Candle Momentum|: *${candleMomentumText}*\n` +
      `📏 ATR Activity Ratio: *${atrRatioText}*\n` +
      `📊 Volume Activity Ratio: *${volumeRatioText}*\n` +
      `🎯 Activity Score: *${scoreText}*\n` +
      `✅ New reversal/continuation setups allowed`
    );
  } else {
    awaitSendScript2Checkpoint(
      `⛔ *MOMENTUM GATE FAILED* — *${symbol}*\n` +
      `📉 Regime: *LOW_MOMENTUM*\n` +
      `⚡ Avg |Candle Momentum|: *${candleMomentumText}*\n` +
      `📏 ATR Activity Ratio: *${atrRatioText}*\n` +
      `📊 Volume Activity Ratio: *${volumeRatioText}*\n` +
      `🎯 Activity Score: *${scoreText}* (need ${MARKET_REGIME_MIN_SCORE}/3)\n` +
      `🚫 No new reversal/continuation setups`
    );
  }
}

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

    // Full closed-candle delta series is retained for the delta calculation.
    deltaSeries,

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

function calculate5MATRBands(candles) {
  if (!candles || candles.length < ATR_BAND_EMA_LENGTH + ATR_BAND_ATR_LENGTH + 2) return null;

  const bands = [];

  for (let i = ATR_BAND_EMA_LENGTH + ATR_BAND_ATR_LENGTH; i < candles.length; i++) {
    const window = candles.slice(0, i + 1);
    const emaSeries = calculateEMASeries(window, ATR_BAND_EMA_LENGTH);
    const ema = emaSeries[emaSeries.length - 1];
    const atr = calculateATR(window, ATR_BAND_ATR_LENGTH);

    if (!Number.isFinite(ema) || !Number.isFinite(atr)) continue;

    bands.push({
      time: candles[i].time,
      mid: ema,
      upper: ema + atr * ATR_BAND_MULTIPLIER,
      lower: ema - atr * ATR_BAND_MULTIPLIER,
      width: atr * ATR_BAND_MULTIPLIER * 2
    });
  }

  if (bands.length < 2) return null;

  const current = bands[bands.length - 1];
  const previous = bands[bands.length - 2];

  return {
    current,
    previous
  };
}




function calculateOBVSeries(candles) {
  if (!candles || candles.length < 2) return [];

  const obv = [];
  let currentOBV = 0;

  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      obv.push(currentOBV);
      continue;
    }

    const close = Number(candles[i].close);
    const previousClose = Number(candles[i - 1].close);
    const volume = Number(candles[i].volume);

    if (
      !Number.isFinite(close) ||
      !Number.isFinite(previousClose) ||
      !Number.isFinite(volume)
    ) {
      obv.push(currentOBV);
      continue;
    }

    if (close > previousClose) {
      currentOBV += volume;
    } else if (close < previousClose) {
      currentOBV -= volume;
    }

    obv.push(currentOBV);
  }

  return obv;
}


// =====================================================
// SCRIPT 2 — ZONE + 1-CANDLE VOLUME IMBALANCE
// =====================================================
// Entry begins only after price reaches a detected liquidity
// level or potential order block. The latest CLOSED 5M candle
// is then measured for directional volume imbalance.
// =====================================================

function detectScript2Absorption(candles, zone) {
  if (!Array.isArray(candles) || candles.length < 22 || !zone) return null;

  const recent = candles.slice(-21, -1);
  const latest = candles[candles.length - 1];

  const open = Number(latest.open);
  const high = Number(latest.high);
  const low = Number(latest.low);
  const close = Number(latest.close);
  const volume = Number(latest.volume);

  if (![open, high, low, close, volume].every(Number.isFinite) || volume <= 0) {
    return null;
  }

  // The absorption candle must actually interact with the detected
  // liquidity/order-block zone.
  const candleTouchesZone = zone.kind === "ORDER_BLOCK"
    ? high >= zone.low && low <= zone.high
    : percentDistance(low, zone.price) <= SCRIPT2_ZONE_TOLERANCE_PERCENT ||
      percentDistance(high, zone.price) <= SCRIPT2_ZONE_TOLERANCE_PERCENT ||
      (low <= zone.price && high >= zone.price);

  if (!candleTouchesZone) return null;

  const avgVolume = recent.reduce((sum, candle) => {
    const v = Number(candle.volume);
    return sum + (Number.isFinite(v) && v > 0 ? v : 0);
  }, 0) / recent.length;

  if (!Number.isFinite(avgVolume) || avgVolume <= 0) return null;

  const range = high - low;
  if (range <= 0) return null;

  const body = Math.abs(close - open);
  const upperWick = high - Math.max(open, close);
  const lowerWick = Math.min(open, close) - low;
  const effortRatio = volume / avgVolume;
  const bodyRatio = body / range;
  const upperWickRatio = upperWick / range;
  const lowerWickRatio = lowerWick / range;

  // Bullish absorption: aggressive selling is absorbed by buyers.
  // A bearish candle with elevated volume is rejected from its lows.
  if (
    close < open &&
    effortRatio >= ABSORPTION_VOLUME_MULTIPLE &&
    bodyRatio <= ABSORPTION_MAX_BODY_TO_RANGE &&
    lowerWickRatio >= ABSORPTION_MIN_WICK_TO_RANGE
  ) {
    return {
      direction: "BUY",
      type: "BULLISH ABSORPTION",
      effortRatio,
      bodyRatio,
      wickRatio: lowerWickRatio,
      candle: latest
    };
  }

  // Bearish absorption: aggressive buying is absorbed by sellers.
  // A bullish candle with elevated volume is rejected from its highs.
  if (
    close > open &&
    effortRatio >= ABSORPTION_VOLUME_MULTIPLE &&
    bodyRatio <= ABSORPTION_MAX_BODY_TO_RANGE &&
    upperWickRatio >= ABSORPTION_MIN_WICK_TO_RANGE
  ) {
    return {
      direction: "SELL",
      type: "BEARISH ABSORPTION",
      effortRatio,
      bodyRatio,
      wickRatio: upperWickRatio,
      candle: latest
    };
  }

  return null;
}


// =====================================================
// SCRIPT 2 — LIQUIDITY-ZONE ABSORPTION OBSERVATION
// =====================================================
// Observation only. This tracker does NOT approve, delay, block, or trigger
// an entry by itself. Reversal execution separately uses the qualifying
// absorption check in the entry scanner. It tracks what happens while price remains at a qualifying
// ATR HIGH/ATR LOW liquidity or order-block zone so we can later study
// absorption strength, persistence, and eventual move size.
//
// HIGH absorption uses the same thresholds as detectScript2Absorption().
// LOW means the zone is active but the latest closed 5M candle does not
// meet those absorption thresholds.
// =====================================================
const SCRIPT2_ZONE_ABSORPTION_EXIT_GRACE_MS = 10 * 60 * 1000;

function getScript2ZoneObservationKey(zone) {
  if (!zone) return null;

  const atrName = zone.atrLocation?.name || "ATR ZONE";
  if (zone.kind === "ORDER_BLOCK") {
    return [
      "ORDER_BLOCK",
      zone.type || "ORDER BLOCK",
      Number(zone.low).toFixed(8),
      Number(zone.high).toFixed(8),
      atrName
    ].join("|");
  }

  return [
    "LIQUIDITY",
    zone.type || "LIQUIDITY",
    Number(zone.price).toFixed(8),
    atrName
  ].join("|");
}

function getScript2ZoneAbsorptionObservation(candles, zone) {
  if (!Array.isArray(candles) || candles.length < 22 || !zone) return null;

  const recent = candles.slice(-21, -1);
  const latest = candles[candles.length - 1];

  const open = Number(latest.open);
  const high = Number(latest.high);
  const low = Number(latest.low);
  const close = Number(latest.close);
  const volume = Number(latest.volume);

  if (![open, high, low, close, volume].every(Number.isFinite) || volume <= 0) {
    return null;
  }

  const candleTouchesZone = zone.kind === "ORDER_BLOCK"
    ? high >= zone.low && low <= zone.high
    : percentDistance(low, zone.price) <= SCRIPT2_ZONE_TOLERANCE_PERCENT ||
      percentDistance(high, zone.price) <= SCRIPT2_ZONE_TOLERANCE_PERCENT ||
      (low <= zone.price && high >= zone.price);

  if (!candleTouchesZone) {
    return {
      level: "LOW",
      confirmed: false,
      touchesZone: false,
      effortRatio: null,
      bodyRatio: null,
      wickRatio: null,
      type: null,
      direction: null,
      candle: latest
    };
  }

  const avgVolume = recent.reduce((sum, candle) => {
    const v = Number(candle.volume);
    return sum + (Number.isFinite(v) && v > 0 ? v : 0);
  }, 0) / recent.length;

  const range = high - low;
  if (!Number.isFinite(avgVolume) || avgVolume <= 0 || range <= 0) return null;

  const body = Math.abs(close - open);
  const upperWick = high - Math.max(open, close);
  const lowerWick = Math.min(open, close) - low;
  const effortRatio = volume / avgVolume;
  const bodyRatio = body / range;
  const upperWickRatio = upperWick / range;
  const lowerWickRatio = lowerWick / range;

  if (
    close < open &&
    effortRatio >= ABSORPTION_VOLUME_MULTIPLE &&
    bodyRatio <= ABSORPTION_MAX_BODY_TO_RANGE &&
    lowerWickRatio >= ABSORPTION_MIN_WICK_TO_RANGE
  ) {
    return {
      level: "HIGH",
      confirmed: true,
      touchesZone: true,
      effortRatio,
      bodyRatio,
      wickRatio: lowerWickRatio,
      type: "BULLISH ABSORPTION",
      direction: "BUY",
      candle: latest
    };
  }

  if (
    close > open &&
    effortRatio >= ABSORPTION_VOLUME_MULTIPLE &&
    bodyRatio <= ABSORPTION_MAX_BODY_TO_RANGE &&
    upperWickRatio >= ABSORPTION_MIN_WICK_TO_RANGE
  ) {
    return {
      level: "HIGH",
      confirmed: true,
      touchesZone: true,
      effortRatio,
      bodyRatio,
      wickRatio: upperWickRatio,
      type: "BEARISH ABSORPTION",
      direction: "SELL",
      candle: latest
    };
  }

  return {
    level: "LOW",
    confirmed: true,
    touchesZone: true,
    effortRatio,
    bodyRatio,
    wickRatio: Math.max(upperWickRatio, lowerWickRatio),
    type: null,
    direction: null,
    candle: latest
  };
}

function formatScript2ZoneDwell(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60000));
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
}

async function observeScript2ZoneAbsorption(symbol, closedCandles5, zone, now) {
  try {
    if (!zone || !zone.atrLocation?.side) return;

    const zoneKey = getScript2ZoneObservationKey(zone);
    if (!zoneKey) return;

    let state = script2ZoneAbsorptionState[symbol];
    if (!state || state.zoneKey !== zoneKey) {
      state = {
        zoneKey,
        zone,
        startedAt: now,
        lastSeenAt: now,
        lastCandleKey: null,
        candlesInZone: 0,
        highAbsorptionCandles: 0,
        lowAbsorptionCandles: 0,
        peakEffortRatio: 0,
        latestObservation: null,
        entryAlertSent: false,
        highAlertSent: false
      };
      script2ZoneAbsorptionState[symbol] = state;
    } else {
      state.lastSeenAt = now;
      state.zone = zone;
    }

    const observation = getScript2ZoneAbsorptionObservation(closedCandles5, zone);
    if (observation) {
      const latest = observation.candle;
      const candleKey = `${latest?.openTime || latest?.time || latest?.timestamp || closedCandles5.length}`;

      if (candleKey !== state.lastCandleKey) {
        state.lastCandleKey = candleKey;
        if (observation.touchesZone) {
          state.candlesInZone += 1;
          if (observation.level === "HIGH") state.highAbsorptionCandles += 1;
          else state.lowAbsorptionCandles += 1;
        }
        if (Number.isFinite(observation.effortRatio)) {
          state.peakEffortRatio = Math.max(state.peakEffortRatio, observation.effortRatio);
        }
        state.latestObservation = observation;
      }
    }

    // Telegram alert policy: send one message when HIGH absorption
    // (>= ABSORPTION_VOLUME_MULTIPLE) is confirmed at the zone.
    // Absorption-ended notifications remain disabled.
    const current = observation || {};
    const shouldSendHighAlert = !state.highAlertSent && current.level === "HIGH";

    if (shouldSendHighAlert) {
      state.highAlertSent = true;

      const atrLabel = zone.atrLocation.name || `ATR ${zone.atrLocation.side}`;
      const zoneType = zone.kind === "ORDER_BLOCK" ? `ORDER BLOCK — ${zone.type}` : `LIQUIDITY — ${zone.type}`;
      const absorptionType = current.type || "Qualifying absorption";
      const effortText = Number.isFinite(current.effortRatio) ? `${current.effortRatio.toFixed(2)}x` : "N/A";
      const bodyText = Number.isFinite(current.bodyRatio) ? `${(current.bodyRatio * 100).toFixed(1)}%` : "N/A";
      const wickText = Number.isFinite(current.wickRatio) ? `${(current.wickRatio * 100).toFixed(1)}%` : "N/A";

      await sendMessage(
        `🔥 *HIGH ABSORPTION CONFIRMED*\n\n` +
        `🪙 Coin: *${symbol}*\n` +
        `📍 Zone: *${atrLabel}*\n` +
        `🧱 Type: *${zoneType}*\n` +
        `🛑 Pattern: *${absorptionType}*\n` +
        `📊 Volume vs 20-bar avg: *${effortText}*\n` +
        `📏 Body/Range: *${bodyText}*\n` +
        `↩️ Opposing Wick/Range: *${wickText}*\n\n` +
        `ℹ️ *OBSERVATION ONLY — does not affect execution.*`
      );
    }
  } catch (err) {
    log(`❌ Script 2 zone absorption observation error ${symbol}: ${err?.message || err}`);
  }
}

async function finalizeScript2ZoneAbsorptionObservation(symbol, now) {
  const state = script2ZoneAbsorptionState[symbol];
  if (!state) return;

  if (now - state.lastSeenAt < SCRIPT2_ZONE_ABSORPTION_EXIT_GRACE_MS) return;

  // Zone-absorption end reports are intentionally disabled.

  delete script2ZoneAbsorptionState[symbol];
}

function calculateOneCandleVolumeImbalance(candles) {
  if (!Array.isArray(candles) || candles.length < 1) return null;

  const recentCandles = candles.slice(-1);
  let buyVol = 0;
  let sellVol = 0;
  let delta = 0;

  for (const candle of recentCandles) {
    const volume = Number(candle.volume);
    const takerBuyVolume = Number(candle.takerBuyVolume);

    if (
      !Number.isFinite(volume) ||
      volume <= 0 ||
      !Number.isFinite(takerBuyVolume) ||
      takerBuyVolume < 0 ||
      takerBuyVolume > volume
    ) {
      return null;
    }

    // Binance kline data provides taker-buy base volume. This gives us
    // directional traded volume without using candle body/color as a proxy.
    const candleBuyVol = takerBuyVolume;
    const candleSellVol = volume - takerBuyVolume;

    buyVol += candleBuyVol;
    sellVol += candleSellVol;
  }

  const totalVol = buyVol + sellVol;
  if (totalVol <= 0) return null;

  delta = buyVol - sellVol;
  const buyPct = (buyVol / totalVol) * 100;
  const sellPct = (sellVol / totalVol) * 100;
  const deltaPct = (Math.abs(delta) / totalVol) * 100;

  if (buyPct >= ENTRY_VOLUME_IMBALANCE_MIN_PERCENT) {
    return {
      direction: "BUY",
      buyVol,
      sellVol,
      delta,
      buyPct,
      sellPct,
      deltaPct,
      candles: 1
    };
  }

  if (sellPct >= ENTRY_VOLUME_IMBALANCE_MIN_PERCENT) {
    return {
      direction: "SELL",
      buyVol,
      sellVol,
      delta,
      buyPct,
      sellPct,
      deltaPct,
      candles: 1
    };
  }

  return {
    direction: null,
    buyVol,
    sellVol,
    delta,
    buyPct,
    sellPct,
    deltaPct,
    candles: 1
  };
}

function getScript2CandleKey(candle, fallback = "") {
  if (!candle) return fallback;
  return String(
    candle.openTime ??
    candle.time ??
    candle.timestamp ??
    fallback
  );
}

function getScript2ZoneBoundary(zone, direction) {
  if (!zone || !direction) return null;

  if (zone.kind === "ORDER_BLOCK") {
    const low = Number(zone.low);
    const high = Number(zone.high);

    if (!Number.isFinite(low) || !Number.isFinite(high)) return null;

    return direction === "SELL" ? low : high;
  }

  const price = Number(zone.price);
  return Number.isFinite(price) ? price : null;
}


function getScript2ZoneRetest(candle, zone, direction) {
  if (!candle || !zone || !direction) return false;

  const high = Number(candle.high);
  const low = Number(candle.low);
  const close = Number(candle.close);
  const boundary = getScript2ZoneBoundary(zone, direction);

  if (![high, low, close, boundary].every(Number.isFinite)) return false;

  if (direction === "SELL") {
    // Retest the broken boundary and close back below it.
    return high >= boundary && close < boundary;
  }

  // Retest the broken boundary and close back above it.
  return low <= boundary && close > boundary;
}

function getScript2ContinuationState(candles, setup, currentPrice = null, momentumRegime = "LOW_MOMENTUM") {
  if (!Array.isArray(candles) || !candles.length || !setup) return null;

  const latestIndex = candles.length - 1;
  const latest = candles[latestIndex];
  const latestKey = getScript2CandleKey(latest, String(latestIndex));

  const boundary = Number.isFinite(Number(setup.anchoredBoundary))
    ? Number(setup.anchoredBoundary)
    : getScript2ZoneBoundary(setup.zone, setup.direction);

  if (!Number.isFinite(boundary) || boundary <= 0) {
    return { status: "WAIT", latestKey, latestIndex };
  }

  // Before BOS, there is deliberately NO candle-count expiry. The setup
  // remains alive while price stays within the configured distance of the
  // locked structure level. This lets valid setups take 20, 30, or more
  // minutes to break without being discarded merely because of time.

  const createdIndex = candles.findIndex(
    (candle) => getScript2CandleKey(candle) === String(setup.createdCandleKey)
  );

  if (createdIndex < 0) {
    return { status: "WAIT", latestKey, latestIndex };
  }

  if (setup.stage === "CANDIDATE") {
    const candlesSinceCreation = latestIndex - createdIndex;
    if (candlesSinceCreation <= 0) {
      return { status: "WAIT", latestKey, latestIndex, candlesSinceCreation };
    }

    const close = Number(latest.close);
    if (!Number.isFinite(close)) {
      return { status: "WAIT", latestKey, latestIndex, candlesSinceCreation };
    }

    const breakConfirmed = setup.direction === "SELL"
      ? close < boundary
      : close > boundary;

    if (!breakConfirmed) {
      if (Number.isFinite(Number(currentPrice))) {
        const distanceFromStructure = percentDistance(Number(currentPrice), boundary);
        if (distanceFromStructure > SCRIPT2_CONTINUATION_MAX_DISTANCE_PERCENT) {
          return {
            status: "EXPIRE",
            reason: "STRUCTURE_DISTANCE_EXCEEDED",
            distanceFromStructure,
            boundary
          };
        }
      }
      return { status: "WAIT", latestKey, latestIndex, candlesSinceCreation };
    }

    // Classify the closed BOS candle against the high and adequate thresholds.
    // High-momentum BOS enters directly; adequate-momentum BOS requires retest.
    const candleOpen = Number(latest.open);
    const candleHigh = Number(latest.high);
    const candleLow = Number(latest.low);
    const candleClose = Number(latest.close);
    const candleRange = candleHigh - candleLow;
    const candleMomentum =
      Number.isFinite(candleOpen) &&
      Number.isFinite(candleHigh) &&
      Number.isFinite(candleLow) &&
      Number.isFinite(candleClose) &&
      candleRange > 0
        ? (candleClose - candleOpen) / candleRange
        : null;

    const bosAtr = calculateATR(candles, ATR_PERIOD);
    const candleAtrMultiple = Number.isFinite(bosAtr) && bosAtr > 0 && candleRange > 0
      ? candleRange / bosAtr
      : null;

    const highMomentum = setup.direction === "BUY"
      ? Number.isFinite(candleMomentum) && candleMomentum >= SCRIPT2_HIGH_MOMENTUM_THRESHOLD
      : Number.isFinite(candleMomentum) && candleMomentum <= -SCRIPT2_HIGH_MOMENTUM_THRESHOLD;
    const adequateMomentum = setup.direction === "BUY"
      ? Number.isFinite(candleMomentum) && candleMomentum >= ADEQUATE_MOMENTUM_THRESHOLD
      : Number.isFinite(candleMomentum) && candleMomentum <= -ADEQUATE_MOMENTUM_THRESHOLD;

    if (highMomentum) {
      return {
        status: "HIGH_MOMENTUM_BREAK_CONFIRMED",
        latestKey, latestIndex, boundary, candlesSinceCreation,
        candleMomentum, candleAtrMultiple, bosAtr,
        highMomentum: true
      };
    }

    // Adequate regime uses a lower directional BOS threshold, but requires
    // a later failed-reclaim retest before the continuation is executable.
    if (momentumRegime === "ADEQUATE_MOMENTUM" && adequateMomentum) {
      return {
        status: "BREAK_CONFIRMED",
        latestKey, latestIndex, boundary, candlesSinceCreation,
        candleMomentum, candleAtrMultiple, bosAtr,
        highMomentum: false
      };
    }

    // Keep the structure candidate alive rather than discarding it just
    // because this particular closed candle did not qualify for either path.
    return { status: "WAIT", latestKey, latestIndex, boundary, candlesSinceCreation, candleMomentum };
  }

  if (setup.stage === "HIGH_MOMENTUM_BREAK_CONFIRMED") {
    return {
      status: "HIGH_MOMENTUM_BREAK_CONFIRMED",
      latestKey: setup.breakCandleKey || latestKey,
      latestIndex,
      boundary: setup.breakBoundary,
      candleMomentum: setup.breakCandleMomentum,
      highMomentum: true
    };
  }

  if (setup.stage === "BREAK_CONFIRMED") {
    const breakIndex = candles.findIndex(
      (candle) => getScript2CandleKey(candle) === String(setup.breakCandleKey)
    );
    if (breakIndex < 0) return { status: "EXPIRE", reason: "BREAK_CANDLE_NOT_FOUND" };

    const candlesSinceBreak = latestIndex - breakIndex;
    if (candlesSinceBreak <= 0) return { status: "WAIT", latestKey, latestIndex, candlesSinceBreak };
    if (candlesSinceBreak > SCRIPT2_CONTINUATION_MAX_RETEST_CANDLES) {
      return { status: "EXPIRE", reason: "RETEST_NOT_CONFIRMED" };
    }

    if (getScript2ZoneRetest(latest, setup.zone, setup.direction)) {
      return { status: "RETEST_CONFIRMED", latestKey, latestIndex, candlesSinceBreak };
    }
    return { status: "WAIT", latestKey, latestIndex, candlesSinceBreak };
  }

  return { status: "WAIT", latestKey, latestIndex };
}

async function processScript2Continuation(symbol, closedCandles5, now, currentPrice = null, momentumRegime = "LOW_MOMENTUM") {
  const setup = script2PendingSetups[symbol];
  if (!setup || setup.setupType !== "CONTINUATION") return null;

  const state = getScript2ContinuationState(closedCandles5, setup, currentPrice, momentumRegime);
  if (!state) return null;

  if (state.status === "EXPIRE") {
    log(`⏳ Script 2 continuation expired ${symbol}: ${state.reason || "confirmation timeout"}`);
    if (state.reason === "STRUCTURE_DISTANCE_EXCEEDED") {
      await sendMessage(
        `⏳ *CONTINUATION SETUP EXPIRED* — *${symbol}*\n` +
        `📏 Price moved more than *${SCRIPT2_CONTINUATION_MAX_DISTANCE_PERCENT.toFixed(2)}%* from the locked structure level\n` +
        `🎯 Structure: *${Number(state.boundary).toPrecision(8)}*`
      );
    } else if (state.reason === "RETEST_NOT_CONFIRMED") {
      awaitSendScript2Checkpoint(
        `⏳ *ADEQUATE-MOMENTUM CONTINUATION EXPIRED* — *${symbol}*
` +
        `🔁 Failed-reclaim retest was not confirmed within ${SCRIPT2_CONTINUATION_MAX_RETEST_CANDLES} closed 5M candles.`
      );
    }
    delete script2PendingSetups[symbol];
    return null;
  }

  if (state.status === "HIGH_MOMENTUM_BREAK_CONFIRMED") {
    setup.stage = "HIGH_MOMENTUM_BREAK_CONFIRMED";
    setup.continuationMode = "HIGH_MOMENTUM";
    setup.breakCandleKey = state.latestKey;
    setup.breakConfirmedAt = now;
    setup.breakBoundary = state.boundary;
    setup.breakCandleMomentum = state.candleMomentum;

    if (!setup.highMomentumNotified) {
      setup.highMomentumNotified = true;
      awaitSendScript2Checkpoint(
        `🔥 *HIGH-MOMENTUM CONTINUATION CONFIRMED* — *${symbol}*\n` +
        `⚡ Candle Momentum: *${Number(state.candleMomentum).toFixed(2)}*\n` +
        `🎯 Momentum Threshold: *≥ ${SCRIPT2_HIGH_MOMENTUM_THRESHOLD.toFixed(2)}*\n` +
  
        `📈 Break of structure confirmed — *NO RETEST REQUIRED*\n` +
        `➡️ Direction: *${setup.direction}*`
      );
    }
    return setup.direction;
  }

  if (state.status === "BREAK_CONFIRMED") {
    setup.stage = "BREAK_CONFIRMED";
    setup.continuationMode = "ADEQUATE_MOMENTUM";
    setup.breakCandleKey = state.latestKey;
    setup.breakConfirmedAt = now;
    setup.breakBoundary = state.boundary;

    if (!setup.breakNotified) {
      setup.breakNotified = true;
      awaitSendScript2Checkpoint(
        `📈 *ADEQUATE-MOMENTUM BOS CONFIRMED* — *${symbol}*\n` +
        `➡️ Direction: *${setup.direction}*\n` +
        `⚡ Candle Momentum: *${Number.isFinite(state.candleMomentum) ? state.candleMomentum.toFixed(2) : "N/A"}*\n` +
        `🔁 Retest required before entry.`
      );
    }
    return null;
  }

  if (state.status === "RETEST_CONFIRMED") {
    setup.stage = "RETEST_CONFIRMED";
    setup.continuationMode = "ADEQUATE_MOMENTUM";
    setup.retestCandleKey = state.latestKey;
    setup.retestConfirmedAt = now;
    setup.confirmedAt = now;

    if (!setup.retestNotified) {
      setup.retestNotified = true;
      awaitSendScript2Checkpoint(
        `🔁 *FAILED-RECLAIM RETEST CONFIRMED* — *${symbol}*\n` +
        `➡️ Direction: *${setup.direction}*\n` +
        `✅ Adequate-momentum continuation is ready for remaining checks.`
      );
    }
    return setup.direction;
  }

  return null;
}

function priceInteractsWithZone(price, zone) {
  if (!Number.isFinite(price) || !zone) return false;

  if (zone.kind === "ORDER_BLOCK") {
    return price >= zone.low && price <= zone.high;
  }

  return percentDistance(price, zone.price) <= SCRIPT2_ZONE_TOLERANCE_PERCENT;
}

function getScript2AtrLocation(zone, atr, currentDayHigh, currentDayLow, previousDayHigh, previousDayLow) {
  if (!zone || !Number.isFinite(atr) || atr <= 0) return null;

  const levels = [
    { name: "CURRENT DAY HIGH", price: Number(currentDayHigh), side: "HIGH" },
    { name: "CURRENT DAY LOW", price: Number(currentDayLow), side: "LOW" },
    { name: "PREVIOUS DAY HIGH", price: Number(previousDayHigh), side: "HIGH" },
    { name: "PREVIOUS DAY LOW", price: Number(previousDayLow), side: "LOW" }
  ].filter((level) => Number.isFinite(level.price) && level.price > 0);

  if (!levels.length) return null;

  const zoneLow = zone.kind === "ORDER_BLOCK" ? Number(zone.low) : Number(zone.price);
  const zoneHigh = zone.kind === "ORDER_BLOCK" ? Number(zone.high) : Number(zone.price);

  if (!Number.isFinite(zoneLow) || !Number.isFinite(zoneHigh)) return null;

  let nearest = null;

  for (const level of levels) {
    const distance = level.price < zoneLow
      ? zoneLow - level.price
      : level.price > zoneHigh
        ? level.price - zoneHigh
        : 0;

    const distanceATR = distance / atr;

    if (distanceATR <= SCRIPT2_ATR_LOCATION_MAX_DISTANCE_ATR &&
        (!nearest || distanceATR < nearest.distanceATR)) {
      nearest = {
        ...level,
        distance,
        distanceATR
      };
    }
  }

  return nearest;
}

function findScript2ContinuationStructureLevel(candles, currentPrice) {
  if (!Array.isArray(candles) || candles.length < 10 || !Number.isFinite(currentPrice)) {
    return null;
  }

  const closed = candles.slice(-SCRIPT2_ZONE_LOOKBACK_CANDLES);
  const levels = detectPotentialLiquidityLevels(closed);
  const candidates = [];

  for (const level of levels) {
    const price = Number(level?.price);
    const type = String(level?.type || "");
    if (!Number.isFinite(price) || price <= 0) continue;

    const isHighStructure = type.includes("HIGH");
    const isLowStructure = type.includes("LOW");
    if (!isHighStructure && !isLowStructure) continue;

    const direction = isHighStructure ? "BUY" : "SELL";
    const distancePercent = percentDistance(currentPrice, price);

    // Continuation must interact with the structure level before the
    // directional imbalance is allowed to create a candidate.
    if (distancePercent > SCRIPT2_ZONE_TOLERANCE_PERCENT) continue;

    // Do not treat an already-broken level as a new candidate.
    if (direction === "BUY" && currentPrice > price) continue;
    if (direction === "SELL" && currentPrice < price) continue;

    candidates.push({
      kind: "STRUCTURE",
      type,
      price,
      direction,
      distancePercent
    });
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => a.distancePercent - b.distancePercent);
  return candidates[0];
}

function findScript2Zone(candles, currentPrice, atr, currentDayHigh, currentDayLow, previousDayHigh, previousDayLow) {
  if (!Array.isArray(candles) || candles.length < 10 || !Number.isFinite(currentPrice)) {
    return null;
  }

  const closed = candles.slice(-SCRIPT2_ZONE_LOOKBACK_CANDLES);
  const orderBlocks = detectPotentialOrderBlocks(closed);
  const liquidityLevels = detectPotentialLiquidityLevels(closed);
  const candidates = [];

  for (const block of orderBlocks) {
    const zone = {
      kind: "ORDER_BLOCK",
      type: block.type,
      low: Number(block.low),
      high: Number(block.high)
    };
    if (
      Number.isFinite(zone.low) &&
      Number.isFinite(zone.high) &&
      zone.high >= zone.low &&
      priceInteractsWithZone(currentPrice, zone)
    ) {
      const atrLocation = getScript2AtrLocation(
        zone, atr, currentDayHigh, currentDayLow, previousDayHigh, previousDayLow
      );

      // Script 2 only accepts zones located at/near an ATR high/low area
      // associated with either the current or previous trading day.
      if (!atrLocation) continue;

      const center = (zone.low + zone.high) / 2;
      candidates.push({
        ...zone,
        distancePercent: percentDistance(currentPrice, center),
        atrLocation
      });
    }
  }

  for (const level of liquidityLevels) {
    const price = Number(level.price);
    if (!Number.isFinite(price)) continue;

    const zone = {
      kind: "LIQUIDITY",
      type: level.type,
      price
    };

    if (priceInteractsWithZone(currentPrice, zone)) {
      const atrLocation = getScript2AtrLocation(
        zone, atr, currentDayHigh, currentDayLow, previousDayHigh, previousDayLow
      );

      if (!atrLocation) continue;

      candidates.push({
        ...zone,
        distancePercent: percentDistance(currentPrice, price),
        atrLocation
      });
    }
  }

  if (!candidates.length) return null;

  // Prefer an order block when price is inside one; otherwise use the
  // closest qualifying liquidity level/zone.
  candidates.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "ORDER_BLOCK" ? -1 : 1;
    return a.distancePercent - b.distancePercent;
  });

  return candidates[0];
}

function formatScript2Zone(zone) {
  if (!zone) return "N/A";
  if (zone.kind === "ORDER_BLOCK") {
    return `${zone.type}: ${Number(zone.low).toPrecision(8)}–${Number(zone.high).toPrecision(8)}`;
  }
  return `${zone.type}: ${Number(zone.price).toPrecision(8)}`;
}

function hasEntryVolumeImbalance(candles, direction) {
  if (!candles || candles.length < 1) return false;

  // Measure directional volume on the latest CLOSED 5M candle
  // using Binance taker-buy volume. Candle body size/color is not used.
  const recentCandles = candles.slice(-1);
  let buyVol = 0;
  let sellVol = 0;

  for (const candle of recentCandles) {
    const volume = Number(candle.volume);
    const takerBuyVolume = Number(candle.takerBuyVolume);

    if (
      !Number.isFinite(volume) ||
      volume <= 0 ||
      !Number.isFinite(takerBuyVolume) ||
      takerBuyVolume < 0 ||
      takerBuyVolume > volume
    ) {
      return false;
    }

    buyVol += takerBuyVolume;
    sellVol += volume - takerBuyVolume;
  }

  const totalVol = buyVol + sellVol;
  if (totalVol <= 0) return false;

  const buyPct = (buyVol / totalVol) * 100;
  const sellPct = (sellVol / totalVol) * 100;

  if (direction === "BUY") {
    return buyPct >= ENTRY_VOLUME_IMBALANCE_MIN_PERCENT;
  }

  if (direction === "SELL") {
    return sellPct >= ENTRY_VOLUME_IMBALANCE_MIN_PERCENT;
  }

  return false;
}
// =====================================================
// 5M STC DIVERGENCE — 30M STC TRANSITION WARNING
// =====================================================
// This is NOT an entry trigger. It is a protective filter.
// When the 1H cycle is BULL, bearish 5M STC divergence blocks
// new BUYs. When the 1H cycle is BEAR, bullish 5M STC divergence
// blocks new SELLs. The 30M STC cycle must still actually flip
// before the opposite-direction entries are allowed.
// =====================================================
const STC_DIVERGENCE_LOOKBACK = 36;
const STC_DIVERGENCE_PIVOT_STRENGTH = 2;
const STC_DIVERGENCE_MAX_AGE_CANDLES = 8;

function has5MSTCDivergence(candles, divergenceType) {
  if (!candles || candles.length < 30) return false;

  const start = Math.max(0, candles.length - STC_DIVERGENCE_LOOKBACK);
  const recentCandles = candles.slice(start);
  const closes = recentCandles.map(c => Number(c.close));

  if (closes.some(v => !Number.isFinite(v))) return false;

  const stcSeries = [];
  for (let i = 0; i < closes.length; i++) {
    const value = calculateSTC(closes.slice(0, i + 1), {
      cycle: 4,
      fast: 10,
      slow: 20,
      signal: 3
    });
    stcSeries.push(value);
  }

  const strength = STC_DIVERGENCE_PIVOT_STRENGTH;
  const pivotLows = [];
  const pivotHighs = [];

  for (let i = strength; i < recentCandles.length - strength; i++) {
    const price = closes[i];
    const stc = stcSeries[i];
    if (!Number.isFinite(stc)) continue;

    let isLow = true;
    let isHigh = true;

    for (let j = 1; j <= strength; j++) {
      if (price >= closes[i - j] || price >= closes[i + j]) isLow = false;
      if (price <= closes[i - j] || price <= closes[i + j]) isHigh = false;
    }

    if (isLow) pivotLows.push({ index: i, price, stc });
    if (isHigh) pivotHighs.push({ index: i, price, stc });
  }

  const pivots = divergenceType === "BULLISH" ? pivotLows : pivotHighs;
  if (pivots.length < 2) return false;

  const latest = pivots[pivots.length - 1];
  const previous = pivots[pivots.length - 2];
  const latestAge = recentCandles.length - 1 - latest.index;

  // Only use a recently confirmed divergence so an old divergence
  // cannot block an otherwise valid new entry indefinitely.
  if (latestAge > STC_DIVERGENCE_MAX_AGE_CANDLES) return false;

  if (divergenceType === "BULLISH") {
    return latest.price < previous.price && latest.stc > previous.stc;
  }

  if (divergenceType === "BEARISH") {
    return latest.price > previous.price && latest.stc < previous.stc;
  }

  return false;
}

function calculateOBVConfirmation(candles, direction) {
  // OBV confirmation uses ONLY the latest CLOSED 5M candle.
  // A fresh crossover is NOT required. OBV only needs to be on the
  // correct side of its 50 EMA for the requested trade direction.
  if (!candles || candles.length < OBV_EMA_LENGTH + 2) return false;

  const obvSeries = calculateOBVSeries(candles);
  if (obvSeries.length !== candles.length) return false;

  const obvCandles = candles.map((candle, index) => ({
    ...candle,
    close: obvSeries[index]
  }));

  const obvEMA = calculateEMASeries(obvCandles, OBV_EMA_LENGTH);
  if (obvEMA.length !== candles.length) return false;

  const lastIndex = candles.length - 1;
  const latestOBV = obvSeries[lastIndex];
  const latestEMA = obvEMA[lastIndex];

  if (!Number.isFinite(latestOBV) || !Number.isFinite(latestEMA)) return false;

  if (direction === "BUY") return latestOBV > latestEMA;
  if (direction === "SELL") return latestOBV < latestEMA;

  return false;
}

// =====================================================
// LIQUIDITY FILTER
// =====================================================
// Checks public Binance Futures market liquidity immediately
// before an entry. If liquidity is insufficient, the trade is
// blocked and the scanner continues to the next symbol.
// =====================================================
async function checkLiquidity(symbol, direction, estimatedTradeNotional = 0) {
  try {
    const [depthRes, tickerRes] = await Promise.all([
      fetch(`https://fapi.binance.com/fapi/v1/depth?symbol=${symbol}&limit=10`),
      fetch(`https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${symbol}`),
    ]);

    if (!depthRes.ok) throw new Error(`Depth HTTP ${depthRes.status}`);
    if (!tickerRes.ok) throw new Error(`Ticker HTTP ${tickerRes.status}`);

    const depth = await depthRes.json();
    const ticker = await tickerRes.json();

    const bids = Array.isArray(depth?.bids) ? depth.bids : [];
    const asks = Array.isArray(depth?.asks) ? depth.asks : [];

    if (!bids.length || !asks.length) {
      return {
        passed: false,
        reason: "Order book unavailable or empty",
        spreadPct: null,
        quoteVolume24h: null,
        bidDepth: 0,
        askDepth: 0,
      };
    }

    const bestBid = Number(bids[0][0]);
    const bestAsk = Number(asks[0][0]);
    const quoteVolume24h = Number(ticker?.quoteVolume || 0);

    const spreadPct = bestBid > 0
      ? ((bestAsk - bestBid) / bestBid) * 100
      : Infinity;

    const bidDepth = bids.reduce(
      (sum, level) => sum + Number(level[0]) * Number(level[1]),
      0
    );
    const askDepth = asks.reduce(
      (sum, level) => sum + Number(level[0]) * Number(level[1]),
      0
    );

    const requiredDepth = Math.max(
      LIQUIDITY_MIN_BOOK_DEPTH_USDT,
      Number(estimatedTradeNotional || 0) * LIQUIDITY_MIN_BOOK_DEPTH_MULTIPLE
    );

    const volumePass = quoteVolume24h >= LIQUIDITY_MIN_24H_QUOTE_VOLUME_USDT;
    const spreadPass = spreadPct <= LIQUIDITY_MAX_SPREAD_PCT;
    const depthPass = bidDepth >= requiredDepth && askDepth >= requiredDepth;

    return {
      passed: volumePass && spreadPass && depthPass,
      reason: !volumePass
        ? `24H quote volume below ${LIQUIDITY_MIN_24H_QUOTE_VOLUME_USDT.toLocaleString()} USDT`
        : !spreadPass
          ? `spread ${spreadPct.toFixed(3)}% exceeds ${LIQUIDITY_MAX_SPREAD_PCT.toFixed(2)}%`
          : !depthPass
            ? `top-10 order-book depth below required ${requiredDepth.toFixed(0)} USDT`
            : "Liquidity sufficient",
      spreadPct,
      quoteVolume24h,
      bidDepth,
      askDepth,
      requiredDepth,
      bestBid,
      bestAsk,
      direction,
    };
  } catch (err) {
    return {
      passed: false,
      reason: `Liquidity check error: ${err?.message || err}`,
      spreadPct: null,
      quoteVolume24h: null,
      bidDepth: 0,
      askDepth: 0,
    };
  }
}

async function sendLiquidityWarning(symbol, direction, liquidity) {
  const now = Date.now();
  const lastWarning = liquidityWarningState[symbol] || 0;

  // Prevent repeated warnings while the same coin remains illiquid.
  if (now - lastWarning < ABSORPTION_ALERT_COOLDOWN_MS) return;
  liquidityWarningState[symbol] = now;

  const spreadText = Number.isFinite(liquidity.spreadPct)
    ? `${liquidity.spreadPct.toFixed(3)}%`
    : "N/A";
  const volumeText = Number.isFinite(liquidity.quoteVolume24h)
    ? `${liquidity.quoteVolume24h.toLocaleString(undefined, { maximumFractionDigits: 0 })} USDT`
    : "N/A";

  await sendMessage(
    `🚫 *LIQUIDITY FILTER — TRADE BLOCKED*\n\n` +
    `🪙 Coin: *${symbol}*\n` +
    `📈 Direction: *${direction === "BUY" ? "LONG 🟢" : "SHORT 🔴"}*\n\n` +
    `❌ Liquidity: *INSUFFICIENT*\n` +
    `📊 24H Quote Volume: *${volumeText}*\n` +
    `↔️ Spread: *${spreadText}*\n` +
    `📚 Bid Depth (Top 10): *${Number(liquidity.bidDepth || 0).toFixed(0)} USDT*\n` +
    `📚 Ask Depth (Top 10): *${Number(liquidity.askDepth || 0).toFixed(0)} USDT*\n\n` +
    `⚠️ Reason: *${liquidity.reason}*\n\n` +
    `🚫 *No trade was placed.*\n` +
    `➡️ The scanner will continue to the next active coin.\n` +
    `💡 You may deactivate *${symbol}* manually if you do not want it considered.`
  );
}

// =====================================================
// ABSORPTION WARNING — INFORMATIONAL ONLY
// =====================================================
// Uses the latest CLOSED 15M candle and the same volume-signed
// delta concept already used by the Trend-Reset Delta system.
// Absorption is detected when unusually large directional effort
// produces a relatively small candle body with a strong opposing wick.
// This warning NEVER blocks a trade.
// =====================================================
async function checkAndWarnAbsorption(symbol, direction, closedCandles15) {
  try {
    if (!closedCandles15 || closedCandles15.length < 25) return false;

    const latest = closedCandles15[closedCandles15.length - 1];
    const recent = closedCandles15.slice(-21, -1);

    const open = Number(latest.open);
    const high = Number(latest.high);
    const low = Number(latest.low);
    const close = Number(latest.close);
    const volume = Number(latest.volume);

    if (![open, high, low, close, volume].every(Number.isFinite)) return false;

    const range = high - low;
    if (range <= 0 || volume <= 0) return false;

    const avgVolume = recent.reduce((sum, candle) => sum + Number(candle.volume || 0), 0) / recent.length;
    if (!avgVolume || !Number.isFinite(avgVolume)) return false;

    const body = Math.abs(close - open);
    const upperWick = high - Math.max(open, close);
    const lowerWick = Math.min(open, close) - low;
    const effortRatio = volume / avgVolume;
    const bodyRatio = body / range;
    const upperWickRatio = upperWick / range;
    const lowerWickRatio = lowerWick / range;

    const bullishBarDelta = close > open;
    const bearishBarDelta = close < open;

    let absorption = null;

    // LONG setup: heavy bullish effort + poor upside result + upper rejection.
    if (
      direction === "BUY" &&
      bullishBarDelta &&
      effortRatio >= ABSORPTION_VOLUME_MULTIPLE &&
      bodyRatio <= ABSORPTION_MAX_BODY_TO_RANGE &&
      upperWickRatio >= ABSORPTION_MIN_WICK_TO_RANGE
    ) {
      absorption = "BEARISH ABSORPTION";
    }

    // SHORT setup: heavy bearish effort + poor downside result + lower rejection.
    if (
      direction === "SELL" &&
      bearishBarDelta &&
      effortRatio >= ABSORPTION_VOLUME_MULTIPLE &&
      bodyRatio <= ABSORPTION_MAX_BODY_TO_RANGE &&
      lowerWickRatio >= ABSORPTION_MIN_WICK_TO_RANGE
    ) {
      absorption = "BULLISH ABSORPTION";
    }

    if (!absorption) return false;

    const candleKey = `${latest.openTime || latest.time || latest.timestamp || closedCandles15.length}`;
    if (!absorptionWarningState[symbol]) absorptionWarningState[symbol] = {};

    const directionKey = direction;
    if (absorptionWarningState[symbol][directionKey] === candleKey) return true;
    absorptionWarningState[symbol][directionKey] = candleKey;

    const bodyPct = (bodyRatio * 100).toFixed(1);
    const wickPct = ((direction === "BUY" ? upperWickRatio : lowerWickRatio) * 100).toFixed(1);

    await sendMessage(
      `⚠️ *ABSORPTION WARNING*\n\n` +
      `🪙 Coin: *${symbol}*\n` +
      `📈 Setup: *${direction === "BUY" ? "LONG 🟢" : "SHORT 🔴"}*\n` +
      `🛑 Detected: *${absorption}*\n\n` +
      `📊 Volume vs 20-bar average: *${effortRatio.toFixed(2)}x*\n` +
      `📏 Candle body/range: *${bodyPct}%*\n` +
      `↩️ Opposing wick/range: *${wickPct}%*\n\n` +
      `⚠️ Price is showing possible absorption of the directional pressure.\n` +
      `ℹ️ *INFORMATIONAL ONLY — trade will NOT be blocked.*`
    );

    return true;
  } catch (err) {
    log(`❌ Absorption warning error ${symbol}: ${err?.message || err}`);
    return false;
  }
}

// --- Floor qty ---
function floorToStep(qty, step) {
  const s = Number(step);
  if (!s || s <= 0) return qty;
  const factor = Math.round(1 / s);
  return Number((Math.floor(qty * factor) / factor).toFixed((s.toString().split(".")[1] || "").length));
}

// =====================================================
// STOP-LOSS LIQUIDITY DIAGNOSTIC — INFORMATIONAL ONLY
// =====================================================
// Checks the bot's existing SL against observable potential
// liquidity: recent 5M swing highs/lows, clustered highs/lows,
// and nearby visible Binance Futures order-book levels.
//
// Hidden stop orders cannot be directly observed. This is a
// precautionary diagnostic only and NEVER changes the trade,
// SL, trailing stop, runner, or entry logic.
// =====================================================

function getStopLossPrice(entryPrice, direction) {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null;

  return direction === "BUY"
    ? entryPrice * (1 - SL_PCT / 100)
    : entryPrice * (1 + SL_PCT / 100);
}

function percentDistance(priceA, priceB) {
  if (!Number.isFinite(priceA) || !Number.isFinite(priceB) || priceA <= 0) return Infinity;
  return Math.abs(priceA - priceB) / priceA * 100;
}

function detectPotentialLiquidityLevels(candles) {
  if (!Array.isArray(candles) || candles.length < 7) return [];

  const levels = [];
  const strength = SL_LIQUIDITY_SWING_STRENGTH;

  for (let i = strength; i < candles.length - strength; i++) {
    const high = Number(candles[i].high);
    const low = Number(candles[i].low);
    if (!Number.isFinite(high) || !Number.isFinite(low)) continue;

    let swingHigh = true;
    let swingLow = true;

    for (let j = 1; j <= strength; j++) {
      const lh = Number(candles[i - j].high);
      const rh = Number(candles[i + j].high);
      const ll = Number(candles[i - j].low);
      const rl = Number(candles[i + j].low);

      if (![lh, rh, ll, rl].every(Number.isFinite)) {
        swingHigh = false;
        swingLow = false;
        break;
      }

      if (high < lh || high < rh) swingHigh = false;
      if (low > ll || low > rl) swingLow = false;
    }

    if (swingHigh) levels.push({ price: high, type: "SWING HIGH" });
    if (swingLow) levels.push({ price: low, type: "SWING LOW" });
  }

  // Repeated/equal highs and lows are treated as clustered potential liquidity.
  for (let i = 0; i < candles.length; i++) {
    const high = Number(candles[i].high);
    const low = Number(candles[i].low);
    if (!Number.isFinite(high) || !Number.isFinite(low)) continue;

    for (let j = i + 1; j < candles.length; j++) {
      const high2 = Number(candles[j].high);
      const low2 = Number(candles[j].low);
      if (!Number.isFinite(high2) || !Number.isFinite(low2)) continue;

      if (percentDistance(high, high2) <= SL_LIQUIDITY_EQUAL_LEVEL_PERCENT) {
        levels.push({ price: (high + high2) / 2, type: "EQUAL HIGH CLUSTER" });
      }
      if (percentDistance(low, low2) <= SL_LIQUIDITY_EQUAL_LEVEL_PERCENT) {
        levels.push({ price: (low + low2) / 2, type: "EQUAL LOW CLUSTER" });
      }
    }
  }

  levels.sort((a, b) => a.price - b.price);

  // Merge nearby observations into one liquidity area.
  const merged = [];
  for (const level of levels) {
    const previous = merged[merged.length - 1];

    if (
      previous &&
      percentDistance(previous.price, level.price) <= SL_LIQUIDITY_EQUAL_LEVEL_PERCENT
    ) {
      previous.price = (previous.price + level.price) / 2;
      if (!previous.type.includes(level.type)) {
        previous.type += ` + ${level.type}`;
      }
    } else {
      merged.push({ ...level });
    }
  }

  return merged;
}

// Approximate Volume Profile POC for the diagnostic message only.
// Uses recent closed 1M candles, groups traded volume into price bins,
// and returns the price bin with the greatest accumulated volume.
function calculateVolumeProfilePOC(candles, binCount = 50) {
  if (!Array.isArray(candles) || candles.length < 20) return null;

  const valid = candles.filter(c => {
    const h = Number(c.high), l = Number(c.low), v = Number(c.volume);
    return Number.isFinite(h) && Number.isFinite(l) && Number.isFinite(v) && h >= l && v > 0;
  });
  if (valid.length < 20) return null;

  const rangeHigh = Math.max(...valid.map(c => Number(c.high)));
  const rangeLow = Math.min(...valid.map(c => Number(c.low)));
  const range = rangeHigh - rangeLow;
  if (!Number.isFinite(range) || range <= 0) return rangeLow;

  const bins = Math.max(20, Math.min(100, Math.floor(binCount)));
  const binSize = range / bins;
  const volumeByBin = new Array(bins).fill(0);

  // Allocate each 1M candle's volume to the price bin containing its
  // volume-weighted typical price. This is an approximation of a
  // lower-timeframe Volume Profile suitable for an informational report.
  for (const candle of valid) {
    const high = Number(candle.high);
    const low = Number(candle.low);
    const close = Number(candle.close);
    const price = Number.isFinite(close) ? (high + low + close) / 3 : (high + low) / 2;
    let index = Math.floor((price - rangeLow) / binSize);
    if (index < 0) index = 0;
    if (index >= bins) index = bins - 1;
    volumeByBin[index] += Number(candle.volume);
  }

  let pocIndex = 0;
  for (let i = 1; i < volumeByBin.length; i++) {
    if (volumeByBin[i] > volumeByBin[pocIndex]) pocIndex = i;
  }

  return rangeLow + (pocIndex + 0.5) * binSize;
}

function getPOCHoldStatus(candles, poc) {
  if (!Array.isArray(candles) || candles.length < 2 || !Number.isFinite(poc)) {
    return { status: "UNAVAILABLE", closes: [] };
  }

  const lastTwo = candles.slice(-2);
  const closes = lastTwo.map(c => Number(c.close));
  if (!closes.every(Number.isFinite)) return { status: "UNAVAILABLE", closes };

  const above = closes.every(close => close > poc);
  const below = closes.every(close => close < poc);

  if (above) return { status: "ABOVE", closes };
  if (below) return { status: "BELOW", closes };
  return { status: "NO CLEAR HOLD", closes };
}

function detectPotentialOrderBlocks(candles) {
  if (!Array.isArray(candles) || candles.length < 8) return [];

  const blocks = [];
  const recent = candles.slice(-SL_ORDER_BLOCK_LOOKBACK_CANDLES);

  for (let i = 2; i < recent.length - 2; i++) {
    const base = recent[i];
    const o = Number(base.open), h = Number(base.high), l = Number(base.low), c = Number(base.close);
    if (![o, h, l, c].every(Number.isFinite) || h <= l) continue;

    const baseBull = c > o;
    const baseBear = c < o;
    if (!baseBull && !baseBear) continue;

    const baseRange = h - l;
    const f1 = recent[i + 1];
    const f2 = recent[i + 2];
    const f1o = Number(f1.open), f1h = Number(f1.high), f1l = Number(f1.low), f1c = Number(f1.close);
    const f2o = Number(f2.open), f2h = Number(f2.high), f2l = Number(f2.low), f2c = Number(f2.close);
    if (![f1o, f1h, f1l, f1c, f2o, f2h, f2l, f2c].every(Number.isFinite)) continue;

    const displacementRange = Math.max(f1h - f1l, f2h - f2l);
    if (displacementRange < baseRange * SL_ORDER_BLOCK_DISPLACEMENT_MULTIPLIER) continue;

    if (baseBear && f1c > f1o && f2c > f2o && f2c > h) {
      blocks.push({ type: "BULLISH ORDER BLOCK", low: l, high: h });
    }
    if (baseBull && f1c < f1o && f2c < f2o && f2c < l) {
      blocks.push({ type: "BEARISH ORDER BLOCK", low: l, high: h });
    }
  }

  return blocks;
}

function calculateLiquidityEventStats(closed5mCandles, closed1mCandles, liquidityLevel) {
  if (!Array.isArray(closed1mCandles) || closed1mCandles.length < 10 || !liquidityLevel || !Number.isFinite(Number(liquidityLevel.price))) {
    return null;
  }

  const levelPrice = Number(liquidityLevel.price);
  const oneMinute = closed1mCandles.filter(c =>
    Number.isFinite(Number(c.open)) &&
    Number.isFinite(Number(c.high)) &&
    Number.isFinite(Number(c.low)) &&
    Number.isFinite(Number(c.close)) &&
    Number.isFinite(Number(c.volume))
  );
  if (oneMinute.length < 10) return null;

  // Find the most recent 1M candle that actually interacted with the detected liquidity level.
  let eventIndex = -1;
  for (let i = oneMinute.length - 1; i >= 0; i--) {
    const c = oneMinute[i];
    if (Number(c.low) <= levelPrice && Number(c.high) >= levelPrice) {
      eventIndex = i;
      break;
    }
  }
  if (eventIndex < 0) return null;

  // Use a compact 5-minute event window ending at the liquidity interaction.
  const eventCandles = oneMinute.slice(Math.max(0, eventIndex - 4), eventIndex + 1);
  if (eventCandles.length < 3) return null;

  let buyVolume = 0;
  let sellVolume = 0;
  let eventVolume = 0;

  for (const c of eventCandles) {
    const volume = Number(c.volume) || 0;
    eventVolume += volume;
    if (Number(c.close) > Number(c.open)) buyVolume += volume;
    else if (Number(c.close) < Number(c.open)) sellVolume += volume;
    else {
      buyVolume += volume / 2;
      sellVolume += volume / 2;
    }
  }

  // Normalize against the coin's own average closed 5M volume.
  const normal5m = Array.isArray(closed5mCandles)
    ? closed5mCandles
        .filter(c => Number.isFinite(Number(c.volume)))
        .slice(-20)
        .map(c => Number(c.volume))
    : [];
  const normalVolume = normal5m.length
    ? normal5m.reduce((sum, v) => sum + v, 0) / normal5m.length
    : 0;

  return {
    buyVolume,
    sellVolume,
    eventVolume,
    normalVolume,
    eventStrength: normalVolume > 0 ? eventVolume / normalVolume : null,
    eventType: buyVolume > sellVolume ? "BUY" : sellVolume > buyVolume ? "SELL" : "BALANCED",
    levelPrice,
    eventCandles: eventCandles.length
  };
}

async function checkStopLossLiquidity(symbol, direction, entryPrice) {
  try {
    const slPrice = getStopLossPrice(entryPrice, direction);
    if (!Number.isFinite(slPrice) || slPrice <= 0) {
      return { status: "UNAVAILABLE", reason: "Invalid SL price." };
    }

    const [candles, pocCandles, depthRes] = await Promise.all([
      fetchFuturesKlines(symbol, "5m", SL_LIQUIDITY_LOOKBACK_CANDLES + 10),
      fetchFuturesKlines(symbol, "1m", 300),
      fetch(`https://fapi.binance.com/fapi/v1/depth?symbol=${symbol}&limit=${SL_LIQUIDITY_ORDER_BOOK_LEVELS}`)
    ]);

    if (!Array.isArray(candles) || candles.length < 10) {
      return {
        status: "UNAVAILABLE",
        entryPrice,
        slPrice,
        reason: "Not enough 5M candles available."
      };
    }

    // Only closed candles are used.
    const closedCandles = candles.slice(0, -1).slice(-SL_LIQUIDITY_LOOKBACK_CANDLES);
    const levels = detectPotentialLiquidityLevels(closedCandles);
    const orderBlocks = detectPotentialOrderBlocks(closedCandles);

    // POC is informational only: it does not affect entry, SL, runner,
    // trailing stop, absorption, imbalance, or STC logic.
    const closedPOCCandles = Array.isArray(pocCandles) ? pocCandles.slice(0, -1) : [];
    const poc = calculateVolumeProfilePOC(closedPOCCandles);
    const pocHold = getPOCHoldStatus(closedCandles, poc);

    let nearest = null;
    for (const level of levels) {
      const distance = percentDistance(slPrice, level.price);
      if (!nearest || distance < nearest.distancePercent) {
        nearest = { ...level, distancePercent: distance };
      }
    }

    // Informational only: estimate the size and direction of the liquidity event
    // relative to this coin's normal 5M volume. This does not affect execution.
    const liquidityEvent = nearest
      ? calculateLiquidityEventStats(closedCandles, closedPOCCandles, nearest)
      : null;

    // Visible resting orders near the SL are reported separately.
    let nearestBook = null;
    if (depthRes.ok) {
      const depth = await depthRes.json();
      const book = [
        ...(Array.isArray(depth?.bids) ? depth.bids : []),
        ...(Array.isArray(depth?.asks) ? depth.asks : [])
      ]
        .map(x => ({ price: Number(x[0]), qty: Number(x[1]) }))
        .filter(x => Number.isFinite(x.price) && x.price > 0 && Number.isFinite(x.qty));

      for (const level of book) {
        const distance = percentDistance(slPrice, level.price);
        if (distance <= SL_LIQUIDITY_ORDER_BOOK_NEAR_PERCENT) {
          if (!nearestBook || distance < nearestBook.distancePercent) {
            nearestBook = {
              price: level.price,
              qty: level.qty,
              distancePercent: distance
            };
          }
        }
      }
    }

    let status = "CLEAR";
    let reason = "No nearby potential liquidity area detected.";

    if (nearest && nearest.distancePercent <= SL_LIQUIDITY_INSIDE_PERCENT) {
      status = "INSIDE";
      reason = `SL overlaps a detected ${nearest.type} potential liquidity area.`;
    } else if (nearest && nearest.distancePercent <= SL_LIQUIDITY_NEAR_PERCENT) {
      status = "NEAR";
      reason = `SL is close to a detected ${nearest.type} potential liquidity area.`;
    }

    let nearestOrderBlock = null;
    for (const block of orderBlocks) {
      const inside = slPrice >= block.low && slPrice <= block.high;
      const distancePercent = inside
        ? 0
        : Math.min(percentDistance(slPrice, block.low), percentDistance(slPrice, block.high));
      if (!nearestOrderBlock || distancePercent < nearestOrderBlock.distancePercent) {
        nearestOrderBlock = { ...block, distancePercent, inside };
      }
    }

    return { status, entryPrice, slPrice, nearest, nearestBook, nearestOrderBlock, poc, pocHold, liquidityEvent, reason };
  } catch (err) {
    log(`⚠️ SL liquidity diagnostic error ${symbol}: ${err?.message || err}`);
    return {
      status: "UNAVAILABLE",
      entryPrice,
      slPrice: getStopLossPrice(entryPrice, direction),
      reason: `Diagnostic error: ${err?.message || err}`
    };
  }
}

async function sendStopLossLiquidityReport(symbol, direction, entryPrice) {
  const result = await checkStopLossLiquidity(symbol, direction, entryPrice);

  const directionText = direction === "BUY" ? "BUY 🟢" : "SELL 🔴";
  const ob = result.nearestOrderBlock;
  const obStatus = ob
    ? (ob.inside || ob.distancePercent <= SL_ORDER_BLOCK_INSIDE_PERCENT ? "🔴 INSIDE" :
       ob.distancePercent <= SL_ORDER_BLOCK_NEAR_PERCENT ? "🟡 NEAR" : "🟢 CLEAR")
    : "🟢 CLEAR";
  const liqStatus = result.status === "INSIDE" ? "🔴 INSIDE" :
    result.status === "NEAR" ? "🟡 NEAR" :
    result.status === "CLEAR" ? "🟢 CLEAR" : "⚪ N/A";

  let message =
    `🔍 *SL DIAGNOSTIC — ${symbol}*\n\n` +
    `📊 *${directionText}* | Entry: *${Number(result.entryPrice || 0).toPrecision(8)}* | SL: *${Number(result.slPrice || 0).toPrecision(8)}*\n\n` +
    `📦 Order Block: *${obStatus}*`;

  if (ob && obStatus !== "🟢 CLEAR") {
    message += `\nZone: *${Number(ob.low).toPrecision(8)}–${Number(ob.high).toPrecision(8)}*`;
  }

  message += `\n💧 Liquidity: *${liqStatus}*`;
  if (result.nearest) {
    message += `\nNearest: *${Number(result.nearest.price).toPrecision(8)}* (${result.nearest.distancePercent.toFixed(2)}%)`;
  }

  if (result.nearestBook) {
    message += `\n📚 Order Book: *${Number(result.nearestBook.price).toPrecision(8)}* (${result.nearestBook.distancePercent.toFixed(2)}%)`;
  }

  if (result.liquidityEvent) {
    const le = result.liquidityEvent;
    const eventLabel = le.eventType === "BUY" ? "🟢 BUY" :
      le.eventType === "SELL" ? "🔴 SELL" : "⚪ BALANCED";
    message += `\n\n🔥 *LIQUIDITY EVENT*`;
    message += `\n${eventLabel} Volume: *${Number(le.eventType === "BUY" ? le.buyVolume : le.eventType === "SELL" ? le.sellVolume : le.eventVolume).toPrecision(8)}*`;
    message += `\n🟢 BUY Volume: *${Number(le.buyVolume).toPrecision(8)}*`;
    message += `\n🔴 SELL Volume: *${Number(le.sellVolume).toPrecision(8)}*`;
    message += `\n📊 Normal Volume: *${Number(le.normalVolume).toPrecision(8)}*`;
    message += `\n⚡ Event Strength: *${Number.isFinite(le.eventStrength) ? le.eventStrength.toFixed(2) : "N/A"}×*`;
  }

  if (Number.isFinite(result.poc)) {
    const pocStatus = result.pocHold?.status === "ABOVE"
      ? "🟢 Price holding above POC"
      : result.pocHold?.status === "BELOW"
        ? "🔴 Price holding below POC"
        : result.pocHold?.status === "NO CLEAR HOLD"
          ? "⚪ No clear hold"
          : "⚪ N/A";
    message += `\n\n📍 POC: *${Number(result.poc).toPrecision(8)}*`;
    message += `\nPOC: *${pocStatus}*`;
  } else {
    message += `\n\n📍 POC: *N/A*`;
  }

  await sendMessage(message);
}

// --- Execute market orders for all users ---
async function executeMarketOrderForAllUsers(symbol, direction) {
  const clients = Object.entries(userClients).map(([userId, client]) => ({ userId, client }));
  const result = {
    attempted: clients.length,
    executed: 0,
    skipped: 0,
    failed: 0
  };

  if (!clients.length) {
    return result;
  }

  for (const { userId, client } of clients) {
    try {
      // Check user MAX_TRADES
      const userOpenTrades = Object.values(activePositions).reduce((sum, sym) => sum + (sym[userId] ? 1 : 0), 0);
      if (userOpenTrades >= MAX_TRADES) {
        result.skipped += 1;
        log(`User ${userId} has max open trades.`);
        continue;
      }

      await client.futuresLeverage(symbol, LEVERAGE).catch(() => {});
      const balances = await client.futuresBalance();
      const usdtBal = balances.find((b) => b.asset === "USDT");
      const bal = usdtBal ? parseFloat(usdtBal.balance) : 0;
      if (!bal || bal <= 0) {
        result.skipped += 1;
        log(`User ${userId} has NO USDT. Trade skipped.`);
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
        result.skipped += 1;
        log(`markPrice invalid for ${symbol}, skipping user ${userId}`);
        continue;
      }

      const tradeValue = bal * TRADE_PERCENT;
      const rawQty = (tradeValue * LEVERAGE) / markPrice;

      let lotStep = 0.001;
      try {
        const info = await client.futuresExchangeInfo();
        const symInfo = info.symbols.find((s) => s.symbol === symbol);
        if (symInfo) lotStep = parseFloat(symInfo.filters.find((f) => f.filterType === "LOT_SIZE")?.stepSize || lotStep);
      } catch {}

      const qty = floorToStep(rawQty, lotStep);
      if (!qty || qty <= 0) {
        result.skipped += 1;
        continue;
      }

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
        symbolCooldowns[symbol] = Date.now();

        // Persist only after Binance confirms the market order succeeded.
        // This is the first durable record of the newly opened position.
        saveActivePositions();

        tradeHistory.push({
          date: getTradeHistoryDate(),
          symbol,
          direction,
          entryPrice: markPrice,
          qty,
          userId,
          timestamp: Date.now()
        });

        result.executed += 1;

        // Informational only: inspect the existing SL after the trade is placed.
        if (!slLiquidityReportSent[symbol]) {
          slLiquidityReportSent[symbol] = true;
          await sendStopLossLiquidityReport(symbol, direction, markPrice);
        }
      } catch (err) {
        result.failed += 1;
        log(`Order failed for ${userId} on ${symbol}: ${err?.message || err}`);
      }
    } catch (err) {
      result.failed += 1;
      log(`executeMarketOrder error for ${userId} ${symbol}: ${err?.message || err}`);
    }
  }

  // Once at least one user has successfully entered the trade,
  // automatically deactivate this symbol exactly as /deactivate SYMBOL
  // would. Existing positions remain open and continue to be monitored.
  if (result.executed > 0) {
    await deactivateSymbol(symbol, true);
  }

  return result;
}

// =====================================================
// 15M TRADE PROGRESS / TREND CONTINUATION MONITOR
// =====================================================
// Informational only. This scans every bot-opened position
// every 15 minutes and reports whether the existing trend is
// continuing, weakening, or showing failure risk.
//
// It does NOT replace or modify the existing:
// • SL
// • pre-runner trailing stop
// • +2% runner activation
// • 30-minute post-activation runner timeout
//
// The monitor combines the same market context already used
// by the bot: 4H trend/quality, 1H momentum + STC, 15M ATR
// bands/structure/delta, and 5M price structure.
// =====================================================

const TRADE_PROGRESS_INTERVAL_MS = 15 * 60 * 1000;
const TRADE_PROGRESS_SCHEDULER_MS = 60 * 1000;
const tradeProgressLastReport = {};
const tradeProgressPrevious = {};

function getTradeProgressStructure(candles, direction, lookback = 6) {
  if (!candles || candles.length < lookback + 2) {
    return { aligned: false, status: "UNAVAILABLE", text: "N/A" };
  }

  const recent = candles.slice(-lookback);
  const prior = candles.slice(-(lookback * 2), -lookback);
  if (recent.length < 3 || prior.length < 3) {
    return { aligned: false, status: "UNAVAILABLE", text: "N/A" };
  }

  const recentHigh = Math.max(...recent.map(c => Number(c.high)));
  const recentLow = Math.min(...recent.map(c => Number(c.low)));
  const priorHigh = Math.max(...prior.map(c => Number(c.high)));
  const priorLow = Math.min(...prior.map(c => Number(c.low)));
  const last = recent[recent.length - 1];
  const prev = recent[recent.length - 2];

  const hh = recentHigh > priorHigh;
  const hl = recentLow > priorLow;
  const lh = recentHigh < priorHigh;
  const ll = recentLow < priorLow;
  const close = Number(last.close);
  const prevClose = Number(prev.close);

  if (direction === "BUY") {
    const aligned = (hh && hl) || (close > prevClose && recentLow >= priorLow);
    return {
      aligned,
      status: aligned ? "HH/HL" : (ll || lh ? "LH/LL" : "PULLBACK/FLAT"),
      text: aligned ? "HH/HL intact" : (ll || lh ? "LH/LL risk" : "pullback/flat")
    };
  }

  const aligned = (lh && ll) || (close < prevClose && recentHigh <= priorHigh);
  return {
    aligned,
    status: aligned ? "LH/LL" : (hh || hl ? "HH/HL" : "PULLBACK/FLAT"),
    text: aligned ? "LH/LL intact" : (hh || hl ? "HH/HL risk" : "pullback/flat")
  };
}

function getTradeProgressBands(candles, direction) {
  const bands = calculate5MATRBands(candles);
  if (!bands) return { aligned: false, status: "UNAVAILABLE", text: "N/A" };

  const latest = candles[candles.length - 1];
  const close = Number(latest.close);
  const aboveMid = close > bands.current.mid;
  const belowMid = close < bands.current.mid;

  if (direction === "BUY") {
    const aligned = aboveMid && close >= bands.current.lower;
    return {
      aligned,
      status: close > bands.current.upper ? "ABOVE UPPER" : (aboveMid ? "ABOVE MID" : "BELOW MID"),
      text: close > bands.current.upper ? "above upper band" : (aboveMid ? "above EMA mid" : "below EMA mid"),
      width: bands.current.width,
      widthChange: bands.current.width - bands.previous.width
    };
  }

  const aligned = belowMid && close <= bands.current.upper;
  return {
    aligned,
    status: close < bands.current.lower ? "BELOW LOWER" : (belowMid ? "BELOW MID" : "ABOVE MID"),
    text: close < bands.current.lower ? "below lower band" : (belowMid ? "below EMA mid" : "above EMA mid"),
    width: bands.current.width,
    widthChange: bands.current.width - bands.previous.width
  };
}

function getTradeProgressDelta(candles, direction) {
  const trDelta = calculateTrendResetCumulativeDelta(candles);
  if (!trDelta) return { aligned: false, strong: false, status: "UNAVAILABLE", text: "N/A" };

  const aligned = direction === "BUY"
    ? trDelta.cumDelta > 0 && trDelta.cumDelta > trDelta.deltaMA
    : trDelta.cumDelta < 0 && trDelta.cumDelta < trDelta.deltaMA;

  const strong = direction === "BUY"
    ? trDelta.deltaStrength >= DELTA_STRENGTH_THRESHOLD
    : trDelta.deltaStrength <= -DELTA_STRENGTH_THRESHOLD;

  return {
    aligned,
    strong,
    status: aligned ? (strong ? "STRONG" : "ALIGNED") : "CONFLICTING",
    text: aligned ? (strong ? "aligned + strong" : "aligned but weaker") : "against trade",
    cumDelta: trDelta.cumDelta,
    deltaMA: trDelta.deltaMA,
    deltaStrength: trDelta.deltaStrength
  };
}

function getTradeProgressStc(candles, direction) {
  if (!candles || candles.length < 40) {
    return { aligned: false, status: "UNAVAILABLE", text: "N/A" };
  }

  const closes = candles.map(c => Number(c.close));
  const current = calculateSTC(closes);
  const previous = calculateSTC(closes.slice(0, -1));
  if (!Number.isFinite(current) || !Number.isFinite(previous)) {
    return { aligned: false, status: "UNAVAILABLE", text: "N/A" };
  }

  const aligned = direction === "BUY" ? current >= 50 : current <= 50;
  const movingWithTrade = direction === "BUY" ? current >= previous : current <= previous;

  return {
    aligned,
    movingWithTrade,
    status: aligned ? (movingWithTrade ? "CONFIRMING" : "WEAKENING") : "AGAINST",
    text: aligned ? (movingWithTrade ? "aligned/rising" : "aligned/falling") : "against trade",
    current,
    previous
  };
}

function getTradeProgress4H(candles, direction) {
  if (!candles || candles.length < 50) {
    return { aligned: false, quality: null, trend: "N/A", text: "N/A" };
  }

  const trend = calculate4HTrendATR(candles);
  if (!trend) return { aligned: false, quality: null, trend: "N/A", text: "N/A" };

  const aligned = direction === "BUY"
    ? trend.trendState === 1
    : trend.trendState === -1;

  let quality = null;
  try {
    quality = analyzeTrendQuality(candles, trend);
  } catch {}

  return {
    aligned,
    quality,
    trend: trend.trend || "NEUTRAL",
    text: aligned ? (quality?.status || "directional") : "trend conflict"
  };
}

function getTradeProgressAbsorption(candles, direction) {
  if (!candles || candles.length < 22) return { warning: false, text: "N/A" };

  const candle = candles[candles.length - 1];
  const prior = candles.slice(-21, -1);
  const avgVolume = prior.reduce((sum, c) => sum + Number(c.volume || 0), 0) / prior.length;
  const range = Number(candle.high) - Number(candle.low);
  if (!(range > 0) || !(avgVolume > 0)) return { warning: false, text: "none" };

  const body = Math.abs(Number(candle.close) - Number(candle.open));
  const upperWick = Number(candle.high) - Math.max(Number(candle.open), Number(candle.close));
  const lowerWick = Math.min(Number(candle.open), Number(candle.close)) - Number(candle.low);
  const highVolume = Number(candle.volume) >= avgVolume * ABSORPTION_VOLUME_MULTIPLE;

  const bearishAbsorption = direction === "BUY" &&
    Number(candle.close) > Number(candle.open) &&
    highVolume &&
    body / range <= ABSORPTION_MAX_BODY_TO_RANGE &&
    upperWick / range >= ABSORPTION_MIN_WICK_TO_RANGE;

  const bullishAbsorption = direction === "SELL" &&
    Number(candle.close) < Number(candle.open) &&
    highVolume &&
    body / range <= ABSORPTION_MAX_BODY_TO_RANGE &&
    lowerWick / range >= ABSORPTION_MIN_WICK_TO_RANGE;

  return {
    warning: bearishAbsorption || bullishAbsorption,
    text: bearishAbsorption ? "bearish absorption" : (bullishAbsorption ? "bullish absorption" : "none")
  };
}

function formatTradeProgressState(state) {
  if (state === "HOLD") return "🟢 HOLD — TREND CONTINUATION";
  if (state === "PROTECT") return "🟡 PROTECT PROFIT — TREND WEAKENING";
  if (state === "TAKE_PROFIT") return "🟠 TAKE PROFIT — MOVE LOSING SUPPORT";
  return "🔴 EXIT WATCH — TREND FAILURE RISK";
}

function evaluateTradeProgress(direction, data, previous) {
  const hardConflict = !data.higher.aligned ||
    data.structure.status === (direction === "BUY" ? "LH/LL" : "HH/HL");

  const deltaConflict = !data.delta.aligned;
  const stcConflict = !data.stc.aligned;
  const bandConflict = !data.bands.aligned;
  const structureConflict = !data.structure.aligned;
  const weakeningSignals = [
    !data.momentum.aligned,
    !data.stc.movingWithTrade,
    !data.bands.expanding,
    !data.delta.strong,
    data.absorption.warning
  ].filter(Boolean).length;

  if (hardConflict && (deltaConflict || structureConflict || stcConflict)) {
    return "EXIT";
  }

  if (hardConflict || (structureConflict && deltaConflict)) {
    return "TAKE_PROFIT";
  }

  if (deltaConflict && bandConflict && weakeningSignals >= 2) {
    return "TAKE_PROFIT";
  }

  if (weakeningSignals >= 3 || (previous?.state === "HOLD" && weakeningSignals >= 2)) {
    return "PROTECT";
  }

  return "HOLD";
}

async function monitorTradeProgress() {
  const now = Date.now();
  const slot = Math.floor(now / TRADE_PROGRESS_INTERVAL_MS);

  // Group users by the actual position (symbol + side) so everyone
  // holding the same bot position receives one shared market report.
  for (const [symbol, users] of Object.entries(activePositions)) {
    const positionGroups = {};

    for (const [userId, pos] of Object.entries(users)) {
      const groupKey = `${symbol}:${pos.side}`;
      if (!positionGroups[groupKey]) positionGroups[groupKey] = [];
      positionGroups[groupKey].push({ userId, pos });
    }

    for (const [groupKey, group] of Object.entries(positionGroups)) {
      if (tradeProgressLastReport[groupKey] === slot) continue;

      const side = group[0].pos.side;

      try {
        // Market data is fetched/calculated once for the whole position group,
        // instead of repeating the same work for every user.
        const [candles4H, candles1H, candles15, candles5] = await Promise.all([
          fetchFuturesKlines(symbol, "4h", 100),
          fetchFuturesKlines(symbol, "1h", 80),
          fetchFuturesKlines(symbol, "15m", 150),
          fetchFuturesKlines(symbol, "5m", 100)
        ]);

        const closed4H = candles4H?.slice(0, -1) || [];
        const closed1H = candles1H?.slice(0, -1) || [];
        const closed15 = candles15?.slice(0, -1) || [];
        const closed5 = candles5?.slice(0, -1) || [];

        if (closed4H.length < 50 || closed1H.length < 40 || closed15.length < 40 || closed5.length < 25) {
          continue;
        }

        const higher = getTradeProgress4H(closed4H, side);
        const momentum = calculate1HMomentum(closed1H);
        const momentumAligned = side === "BUY"
          ? Number(momentum?.current) > 0
          : Number(momentum?.current) < 0;
        const momentumData = {
          aligned: momentumAligned,
          accelerating: momentum?.state === "ACCELERATING",
          text: momentumAligned ? (momentum?.state || "aligned") : "against trade"
        };

        const stc = getTradeProgressStc(closed1H, side);
        const bands = getTradeProgressBands(closed15, side);
        const structure = getTradeProgressStructure(closed15, side, 6);
        const delta = getTradeProgressDelta(closed15, side);
        const absorption = getTradeProgressAbsorption(closed15, side);
        const structure5 = getTradeProgressStructure(closed5, side, 6);

        const data = {
          higher,
          momentum: momentumData,
          stc,
          bands,
          structure,
          delta,
          absorption,
          structure5
        };

        const previous = tradeProgressPrevious[groupKey] || null;
        const state = evaluateTradeProgress(side, data, previous);
        const currentClose = Number(closed15[closed15.length - 1].close);

        const qualityText = higher.quality?.status || "N/A";
        const qualityScore = Number.isFinite(higher.quality?.score) ? higher.quality.score : null;

        let userLines = "";
        for (const { userId, pos } of group) {
          const move = side === "BUY"
            ? ((currentClose - pos.entryPrice) / pos.entryPrice) * 100
            : ((pos.entryPrice - currentClose) / pos.entryPrice) * 100;

          userLines +=
            `• User ${userId}: *${move >= 0 ? "+" : ""}${move.toFixed(2)}%*` +
            ` | Entry: ${pos.entryPrice}` +
            ` | Qty: ${pos.qty}\n`;
        }

        const report =
          `📡 *15M TRADE PROGRESS — ${symbol} ${side}*\n\n` +
          `👥 *Users holding this position:* ${group.length}\n` +
          userLines + `\n` +
          `${formatTradeProgressState(state)}\n\n` +
          `4️⃣ *4H TREND*\n` +
          `• Direction: ${higher.trend}\n` +
          `• Quality: ${qualityText}${qualityScore !== null ? ` (${qualityScore}/100)` : ""}\n` +
          `• Status: ${higher.aligned ? "✅ aligned" : "❌ conflict"}\n\n` +
          `1️⃣ *1H MOMENTUM / STC*\n` +
          `• Momentum: ${momentumData.text}\n` +
          `• STC: ${stc.text}${Number.isFinite(stc.current) ? ` (${stc.current.toFixed(1)})` : ""}\n\n` +
          `1️⃣5️⃣ *15M STRUCTURE / ATR*\n` +
          `• Structure: ${structure.text}\n` +
          `• ATR bands: ${bands.text}\n` +
          `• Band expansion: ${bands.expanding ? "✅ directional" : "⚠️ not expanding"}\n\n` +
          `📊 *15M CUMULATIVE DELTA*\n` +
          `• Pressure: ${delta.text}\n` +
          `• Strength: ${Number.isFinite(delta.deltaStrength) ? delta.deltaStrength.toFixed(2) : "N/A"}\n\n` +
          `5️⃣ *5M PRICE STRUCTURE*\n` +
          `• ${structure5.text}\n\n` +
          `⚠️ Absorption: ${absorption.text}\n\n` +
          `🧭 This is a *monitoring report only*. Existing SL, trailing stop and runner rules remain unchanged.`;

        await sendMessage(report);
        tradeProgressLastReport[groupKey] = slot;
        tradeProgressPrevious[groupKey] = {
          state,
          timestamp: now,
          deltaStrength: delta.deltaStrength,
          stc: stc.current,
          bandWidth: bands.width
        };
      } catch (err) {
        log(`❌ 15M trade progress error ${groupKey}: ${err?.message || err}`);
      }
    }
  }

  // Clean state for positions that no longer exist.
  for (const key of Object.keys(tradeProgressLastReport)) {
    const [symbol, side] = key.split(":");
    const stillExists = Object.values(activePositions[symbol] || {})
      .some(pos => pos.side === side);

    if (!stillExists) {
      delete tradeProgressLastReport[key];
      delete tradeProgressPrevious[key];
    }
  }
}

setInterval(() => {
  monitorTradeProgress().catch(err =>
    log(`❌ Trade progress scheduler error: ${err?.message || err}`)
  );
}, TRADE_PROGRESS_SCHEDULER_MS);


// --- Monitor positions (TP/SL/Trailing Stop) ---
async function monitorPositions() {
  for (const [symbol, users] of Object.entries(activePositions)) {
    for (const [userId, pos] of Object.entries(users)) {
      const client = userClients[userId];
      if (!client) {
        delete activePositions[symbol][userId];
        saveActivePositions();
        continue;
      }

      try {
        const positions = await client.futuresPositionRisk();
        const p = Array.isArray(positions)
          ? positions.find((x) => x.symbol === symbol)
          : null;
        const amt = p ? parseFloat(p.positionAmt || 0) : 0;

        if (!p || amt === 0) {
          // Binance confirms the position is already closed. Remove only the
          // stale local JSON/in-memory record; do NOT send a close order.
          delete activePositions[symbol][userId];
          saveActivePositions();
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
          pos.runnerActivatedAt = Date.now();
          pos.runnerActivationMove = move;
          pos.runnerTargetMove = move + RUNNER_POST_ACTIVATION_EXTRA_PCT;
          pos.runnerTargetReached = false;
          saveActivePositions();

          if (!runnerActivationNotified[symbol]) {
            runnerActivationNotified[symbol] = true;

            await sendMessage(
              `🏃 RUNNER ACTIVATED: *${symbol}* ${pos.side}\n\n` +
              `💰 Profit: +${move.toFixed(2)}%\n` +
              `🎯 Activation: +${RUNNER_ACTIVATION_PCT.toFixed(2)}%\n\n` +
              `📊 Runner Mode: ACTIVE\n` +
              `🎯 Runner Rule: +1% more within 30 minutes\n\n` +
              `👥 All users' ${symbol} positions are now in runner mode.`
            );
          }
        }

        // =====================================================
        // RUNNER POST-ACTIVATION TARGET / TIMEOUT
        // After runner activation at +2%, price must achieve an additional
        // +1 percentage point of trade profit within 30 minutes.
        // Example: activation at +2.00% -> target +3.00%.
        // Once the target is reached, this timeout condition is permanently
        // satisfied for the current position.
        // =====================================================
        if (pos.runnerActive) {
          // Backward-compatible recovery for positions saved before this
          // runner timeout feature existed.
          if (!Number.isFinite(Number(pos.runnerActivatedAt))) {
            pos.runnerActivatedAt = Date.now();
            pos.runnerActivationMove = Number.isFinite(Number(pos.runnerActivationMove))
              ? Number(pos.runnerActivationMove)
              : Math.max(move, RUNNER_ACTIVATION_PCT);
            pos.runnerTargetMove = pos.runnerActivationMove + RUNNER_POST_ACTIVATION_EXTRA_PCT;
            pos.runnerTargetReached = false;
            saveActivePositions();
          }

          if (!Number.isFinite(Number(pos.runnerTargetMove))) {
            pos.runnerTargetMove =
              (Number.isFinite(Number(pos.runnerActivationMove))
                ? Number(pos.runnerActivationMove)
                : RUNNER_ACTIVATION_PCT) + RUNNER_POST_ACTIVATION_EXTRA_PCT;
            saveActivePositions();
          }

          if (move >= Number(pos.runnerTargetMove)) {
            if (!pos.runnerTargetReached) {
              pos.runnerTargetReached = true;
              saveActivePositions();

              await sendMessage(
                `🎯 RUNNER TARGET REACHED: *${symbol}* ${pos.side}\n` +
                `Profit: +${move.toFixed(2)}%\n` +
                `Target: +${Number(pos.runnerTargetMove).toFixed(2)}%\n` +
                `30-minute runner extension requirement satisfied.`
              );
            }
          } else if (!pos.runnerTargetReached &&
                     Date.now() - Number(pos.runnerActivatedAt) >= RUNNER_POST_ACTIVATION_TIMEOUT_MS) {
            // Use the exact same close-order path as /close SYMBOL.
            // Only this timed-out user's position is removed from tracking.
            await closeTrackedPositionOrder(client, symbol, pos);

            delete activePositions[symbol][userId];
            saveActivePositions();

            await sendMessage(
              `⏱️ RUNNER TIMEOUT EXIT: *${symbol}* ${pos.side}\n` +
              `Current Profit: ${move.toFixed(2)}%\n` +
              `Runner activated at: +${Number(pos.runnerActivationMove || RUNNER_ACTIVATION_PCT).toFixed(2)}%\n` +
              `Required target: +${Number(pos.runnerTargetMove).toFixed(2)}%\n` +
              `The extra +${RUNNER_POST_ACTIVATION_EXTRA_PCT.toFixed(2)}% was not reached within 30 minutes.`
            );

            continue;
          }
        }

        // =====================================================
        // TRAILING STOP
        // Active only before runner mode.
        // Once runner mode activates, the post-activation runner timer/target applies.
        // =====================================================
        if (!pos.runnerActive && pos.side === "BUY") {
          pos.highest = Math.max(pos.highest, mark);
          const trail = pos.highest * (1 - TRAILING_STOP_PCT / 100);

          if (!pos.trailingStop || trail > pos.trailingStop) {
            pos.trailingStop = trail;
            saveActivePositions();
          }

          if (mark <= pos.trailingStop) {
            await client.futuresMarketSell(symbol, Math.abs(amt));
            delete activePositions[symbol][userId];
            saveActivePositions();

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
            saveActivePositions();
          }

          if (mark >= pos.trailingStop) {
            await client.futuresMarketBuy(symbol, Math.abs(amt));
            delete activePositions[symbol][userId];
            saveActivePositions();

            await sendMessage(
              `🔒 Trailing Stop Hit: *${symbol}* (User ${userId})`
            );

            continue;
          }
        }

        // =====================================================
        // RUNNER EXIT
        // The runner has NO Delta-based exit. After activation, the
        // only runner-management exit is the post-activation target
        // requirement: an additional +1 percentage point within 30 minutes.
        // =====================================================
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
          saveActivePositions();

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
      delete slLiquidityReportSent[symbol];
      delete activePositions[symbol];
    }
  }

  // Persist runner/trailing-stop updates and removals so a restart can restore them.
  saveActivePositions();
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
        // Automatically perform the same state change as /activate <symbol>.
        // This makes reaching the configured price actually activate the coin
        // for the normal trading scanner, not just unlock the price gate.
        priceActivated[symbol] = true;
        symbolActive[symbol] = true;
        
        const crossDirection = crossedUp ? "UPWARD ⬆️" : "DOWNWARD ⬇️";

        await sendMessage(
          `🔓 *PRICE ACTIVATION TRIGGERED*\n\n` +
          `🪙 Coin: *${symbol}*\n` +
          `🎯 Activation Price: *${activationPrice}*\n` +
          `💰 Current Price: *${currentPrice}*\n` +
          `↕️ Cross: *${crossDirection}*\n\n` +
          `✅ *${symbol}* has been automatically ACTIVATED for trading.\n` +
          `This is the same action as /activate ${symbol}.\n` +
          `The 1H STC is monitored for trend context. Entry execution is based on zone, absorption/continuation and 1-candle directional volume imbalance.`
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

// --- Full-auto 1H STC monitoring + Script 2 entry scanning loop ---

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
      // 1H STC SLOPE — INFORMATIONAL / TREND CONTEXT ONLY
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
      if (!isActive || BOT_PAUSED) {
        // Force a fresh alignment/strength confirmation after a symbol is
        // reactivated or the bot is unpaused; do not reuse a stale unlock.
        script2DeltaGateState[symbol] = { alignmentDirection: null, confirmed: false };
        continue;
      }

      // Price activation gate. This does not change /activate or /deactivate.
      if (
        priceActivationLevels[symbol] !== undefined &&
        priceActivated[symbol] !== true
      ) continue;

      if (symbolCooldowns[symbol] && now - symbolCooldowns[symbol] < COOLDOWN_MS) continue;

      // =====================================================
      // 1H STC CYCLE — INFORMATIONAL / TREND CONTEXT ONLY
      // =====================================================
      // In AUTO mode (MANUAL_CYCLE === null), the cycle is
      // continuously synchronized with the latest CLOSED 1H
      // STC direction. When STC changes from rising to falling
      // or falling to rising, the trading cycle changes
      // automatically without requiring /setbull or /setbear.
      //
      // In MANUAL mode, the manually selected cycle remains
      // unchanged.
      // =====================================================
      if (MANUAL_CYCLE === null) {
        const autoCycle = stcRising ? "BULL" : stcFalling ? "BEAR" : null;

        if (autoCycle && autoCycle !== currentCycle[symbol]) {
          const previousCycle = currentCycle[symbol];
          currentCycle[symbol] = autoCycle;

          if (previousCycle) {
            // Immediately measure the opposing 5M pressure after every real
            // 1H STC cycle flip. This is informational only and does not
            // change entry, exit, or trade-management behavior.
            let opposingDirection = autoCycle === "BULL" ? "SELL" : "BUY";
            let opposingDelta = "N/A";
            let opposingVolume = "N/A";

            try {
              const flipCandles5 = await fetchFuturesKlines(symbol, "5m", 150);
              if (flipCandles5 && flipCandles5.length >= 40) {
                const flipClosedCandles5 = flipCandles5.slice(0, -1);
                const flipDelta = calculateTrendResetCumulativeDelta(flipClosedCandles5);

                if (flipDelta && Number.isFinite(flipDelta.deltaStrength)) {
                  const pressureStrength = autoCycle === "BULL"
                    ? Math.max(0, -flipDelta.deltaStrength)
                    : Math.max(0, flipDelta.deltaStrength);
                  opposingDelta = pressureStrength.toFixed(2);
                }

                const recentPressureCandles = flipClosedCandles5.slice(-2);
                let buyVol = 0;
                let sellVol = 0;

                for (const candle of recentPressureCandles) {
                  const open = Number(candle.open);
                  const close = Number(candle.close);
                  const volume = Number(candle.volume);

                  if (Number.isFinite(open) && Number.isFinite(close) && Number.isFinite(volume) && volume > 0) {
                    if (close > open) buyVol += volume;
                    else if (close < open) sellVol += volume;
                  }
                }

                const totalPressureVol = buyVol + sellVol;
                if (totalPressureVol > 0) {
                  const pct = autoCycle === "BULL"
                    ? (sellVol / totalPressureVol) * 100
                    : (buyVol / totalPressureVol) * 100;
                  opposingVolume = `${pct.toFixed(1)}%`;
                }
              }
            } catch (pressureErr) {
              log(`⚠️ STC flip pressure measurement failed for ${symbol}: ${pressureErr?.message || pressureErr}`);
            }

            const pressureEmoji =
              opposingDelta !== "N/A" && Number(opposingDelta) >= 0.80
                ? "⚠️"
                : "✅";

            await sendMessage(
              `🔄 1H STC FLIP — *${symbol}*\n` +
              `${previousCycle === "BULL" ? "🟢" : "🔴"}→${autoCycle === "BULL" ? "🟢" : "🔴"} *${autoCycle}*\n` +
              `${pressureEmoji} Opposing ${opposingDirection}: ${opposingDelta} Delta | ${opposingVolume} Vol`,
            );
          } else {
            await sendMessage(
              `🔁 1H STC Auto Cycle Set for *${symbol}*: *${autoCycle}*`,
            );
          }
        }
      } else if (!currentCycle[symbol]) {
        currentCycle[symbol] = MANUAL_CYCLE;
      }

      const trendCycle = currentCycle[symbol];

      // =====================================================
// SCRIPT 2 ENTRY LOGIC — ZONE → REVERSAL OR CONTINUATION
// =====================================================
// 1) Price must first interact with a potential liquidity level
//    or order block that is located at/near an ATR high/low area
//    associated with the current-day or previous-day high/low.
// 2) DECISION ORDER: absorption is checked FIRST at the ATR extreme.
//    A qualifying absorption owns the setup decision. ATR LOW bullish
//    absorption = BUY reversal; ATR HIGH bearish absorption = SELL reversal.
//    A mismatched qualifying absorption blocks continuation rather than
//    being interpreted as continuation pressure.
// 3) CONTINUATION is evaluated ONLY when no qualifying absorption exists.
//    At ATR HIGH, BUY imbalance can create a BUY continuation candidate;
//    at ATR LOW, SELL imbalance can create a SELL continuation candidate.
// 4) The latest CLOSED 5M candle directional volume imbalance threshold is 70%.
// 5) A direction-neutral market-activity gate must allow NEW setups.
//    Adequate momentum keeps the original 0.25 threshold and 2-of-3 activity
//    score; high momentum is classified at 0.40. Low momentum remains blocked.
// 6) The 1H STC is NOT used to approve, delay, block or trigger execution.
//
// 1H STC flip/pressure messages, absorption, liquidity, SL and
// trade-management messages remain available as context/diagnostics.
// =====================================================

const candles5 = await fetchFuturesKlines(symbol, "5m", 150);
if (!candles5 || candles5.length < 40) continue;

// Only CLOSED 5M candles are used for the volume imbalance.
const closedCandles5 = candles5.slice(0, -1);

// Global market-activity regime. Adequate and high momentum allow new setups;
// low momentum blocks new setup creation. Staged setups continue through their
// corresponding BOS-only or BOS-plus-retest confirmation path.
const script2MomentumRegime = getScript2MomentumRegime(closedCandles5);
const script2LatestClosedCandleKey = getScript2CandleKey(
  closedCandles5[closedCandles5.length - 1],
  String(closedCandles5.length - 1)
);


maybeSendScript2MomentumRegimeCheckpoint(
  symbol,
  script2MomentumRegime,
  script2LatestClosedCandleKey
);

// Current market price is used only to determine whether price has
// reached/interacted with a detected zone.
let script2CurrentPrice = null;
try {
  const priceRes = await fetch(
    `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`
  );
  if (priceRes.ok) {
    const priceData = await priceRes.json();
    script2CurrentPrice = Number(priceData?.price);
  }
} catch (priceErr) {
  log(`⚠️ Script 2 price check failed for ${symbol}: ${priceErr?.message || priceErr}`);
}

if (!Number.isFinite(script2CurrentPrice)) continue;

// Keep the existing 15M absorption warning informational only.
const candles15ForAbsorption = await fetchFuturesKlines(symbol, "15m", 40);
if (candles15ForAbsorption && candles15ForAbsorption.length >= 26) {
  const closedCandles15ForAbsorption = candles15ForAbsorption.slice(0, -1);
  await checkAndWarnAbsorption(
    symbol,
    trendCycle === "BULL" ? "BUY" : "SELL",
    closedCandles15ForAbsorption
  );
}

// -----------------------------------------------------
// MASTER UNLOCK — CLOSED 15M + 5M TREND-RESET DELTA
// -----------------------------------------------------
// Stage 1: 15M and 5M Delta must agree directionally relative to their own
// Delta MAs. Send one Telegram message when a new alignment event begins.
// Stage 2: the existing adaptive strength threshold must be met by the 5M
// Delta before Script 2 setup creation/execution is unlocked.
// If alignment breaks before confirmation, cancel the pending confirmation.
// Once confirmed, the unlock remains valid only while the two timeframes
// continue to align. All inputs below use CLOSED candles only.
const closedCandles15ForDelta =
  candles15ForAbsorption && candles15ForAbsorption.length > 1
    ? candles15ForAbsorption.slice(0, -1)
    : null;

if (!closedCandles15ForDelta || closedCandles15ForDelta.length < 30) {
  script2DeltaGateState[symbol] = { alignmentDirection: null, confirmed: false };
  continue;
}

const delta15ForGate = calculateTrendResetCumulativeDelta(closedCandles15ForDelta);
const delta5ForGate = calculateTrendResetCumulativeDelta(closedCandles5);

if (!delta15ForGate || !delta5ForGate) {
  script2DeltaGateState[symbol] = { alignmentDirection: null, confirmed: false };
  continue;
}

const getDeltaPositionDirection = (delta) => {
  if (delta.cumDelta > 0 && delta.cumDelta > delta.deltaMA) return "BUY";
  if (delta.cumDelta < 0 && delta.cumDelta < delta.deltaMA) return "SELL";
  return null;
};

const delta15Direction = getDeltaPositionDirection(delta15ForGate);
const delta5Direction = getDeltaPositionDirection(delta5ForGate);
const alignedDeltaDirection =
  delta15Direction && delta15Direction === delta5Direction
    ? delta15Direction
    : null;

let deltaGateState = script2DeltaGateState[symbol] || {
  alignmentDirection: null,
  confirmed: false
};

if (!alignedDeltaDirection) {
  if (deltaGateState.alignmentDirection && !deltaGateState.confirmed) {
    log(`⛔ ${symbol} 15M/5M Delta alignment broke before 5M strength confirmation; pending confirmation cancelled.`);
  }
  script2DeltaGateState[symbol] = {
    alignmentDirection: null,
    confirmed: false
  };
  continue;
}

if (deltaGateState.alignmentDirection !== alignedDeltaDirection) {
  deltaGateState = {
    alignmentDirection: alignedDeltaDirection,
    confirmed: false,
    alignmentStartedAt: Date.now()
  };
  script2DeltaGateState[symbol] = deltaGateState;

  // Do not carry a staged setup in the opposite direction into a new
  // directional Delta alignment event.
  if (
    script2PendingSetups[symbol] &&
    script2PendingSetups[symbol].direction !== alignedDeltaDirection
  ) {
    delete script2PendingSetups[symbol];
  }

  await sendMessage(
    `🧭 *15M + 5M DELTA ALIGNMENT* — *${symbol}*\n\n` +
    `${alignedDeltaDirection === "BUY" ? "🟢" : "🔴"} Direction: *${alignedDeltaDirection}*\n` +
    `• 15M Delta: ${delta15Direction} (CumDelta ${delta15ForGate.cumDelta.toFixed(2)} vs MA ${delta15ForGate.deltaMA.toFixed(2)})\n` +
    `• 5M Delta: ${delta5Direction} (CumDelta ${delta5ForGate.cumDelta.toFixed(2)} vs MA ${delta5ForGate.deltaMA.toFixed(2)})\n\n` +
    `⏳ Waiting for 5M Delta strength confirmation (threshold: ${DELTA_STRENGTH_THRESHOLD.toFixed(2)}).\n` +
    `🔒 Setups remain locked until confirmation.`
  );
}

// The 5M threshold is the second-stage confirmation. It is evaluated only
// after directional 15M/5M alignment has been established.
const delta5StrengthConfirmed = alignedDeltaDirection === "BUY"
  ? delta5ForGate.deltaStrength >= DELTA_STRENGTH_THRESHOLD
  : delta5ForGate.deltaStrength <= -DELTA_STRENGTH_THRESHOLD;

if (!deltaGateState.confirmed && delta5StrengthConfirmed) {
  deltaGateState.confirmed = true;
  deltaGateState.confirmedAt = Date.now();
  script2DeltaGateState[symbol] = deltaGateState;

  await sendMessage(
    `✅ *5M DELTA STRENGTH CONFIRMED* — *${symbol}*\n\n` +
    `${alignedDeltaDirection === "BUY" ? "🟢" : "🔴"} Direction: *${alignedDeltaDirection}*\n` +
    `📊 5M Delta strength: *${delta5ForGate.deltaStrength.toFixed(2)}*\n` +
    `🎯 Required threshold: *${DELTA_STRENGTH_THRESHOLD.toFixed(2)}*\n\n` +
    `🔓 *${alignedDeltaDirection} setups unlocked.* Existing setup, OBV, liquidity and execution checks remain in force.`
  );
}

if (!deltaGateState.confirmed) {
  continue;
}

// -----------------------------------------------------
// STEP 1 — ZONE REACH
// -----------------------------------------------------

const currentDayCandle = dailyCandles[dailyCandles.length - 1];
const currentDayHigh = Number(currentDayCandle?.high);
const currentDayLow = Number(currentDayCandle?.low);
const previousDayHigh = Number(lastClosedDaily?.high);
const previousDayLow = Number(lastClosedDaily?.low);

const script2Zone = findScript2Zone(
  closedCandles5,
  script2CurrentPrice,
  atr,
  currentDayHigh,
  currentDayLow,
  previousDayHigh,
  previousDayLow
);

if (script2Zone) {
  const zoneCheckpointKey = getScript2ZoneObservationKey(script2Zone);
  if (script2CheckpointState[symbol]?.zoneKey !== zoneCheckpointKey) {
    script2CheckpointState[symbol] = { zoneKey: zoneCheckpointKey, zoneNotified: false };
  }
  if (!script2CheckpointState[symbol].zoneNotified) {
    script2CheckpointState[symbol].zoneNotified = true;
    await sendMessage(
      `📍 *ZONE REACHED* — *${symbol}*\n` +
      `📍 ${script2Zone.atrLocation?.name || `ATR ${script2Zone.atrLocation?.side || "ZONE"}`}\n` +
      `🏦 ${script2Zone.kind === "ORDER_BLOCK" ? `ORDER BLOCK — ${script2Zone.type || "ORDER BLOCK"}` : `LIQUIDITY — ${script2Zone.type || "LIQUIDITY"}`}`
    );
  }

  // Observation-only liquidity-zone absorption tracking.
  await observeScript2ZoneAbsorption(symbol, closedCandles5, script2Zone, now);

  // ---------------------------------------------------
  // STEP 2 — DETERMINE REVERSAL OR CONTINUATION
  // ---------------------------------------------------
  // The market-regime gate is direction-neutral and applies only to NEW
  // setup creation. A valid staged setup remains anchored while its BOS or
  // required retest confirmation is processed.
  if (script2MomentumRegime.allowed) {
  const atrSide = script2Zone.atrLocation?.side;
  const absorption = detectScript2Absorption(closedCandles5, script2Zone);
  const latestClosedCandle = closedCandles5[closedCandles5.length - 1];
  const latestClosedCandleKey = getScript2CandleKey(
    latestClosedCandle,
    String(closedCandles5.length - 1)
  );

  // ===================================================
  // DECISION GATE — PREVIOUS-DAY REVERSAL / ALL-DAY CONTINUATION
  // ===================================================
  // Previous-day high/low (PDH/PDL) can produce either a reversal
  // or a continuation. Current-day high/low (CDH/CDL) can produce
  // continuation only.
  //
  // The selected ATR location is authoritative because getScript2AtrLocation()
  // already chooses the nearest qualifying current/previous-day level.
  const liquiditySource = String(script2Zone.atrLocation?.name || "");
  const isPreviousDayLiquidity = liquiditySource === "PREVIOUS DAY HIGH" ||
    liquiditySource === "PREVIOUS DAY LOW";
  const hasAbsorption = Boolean(absorption?.direction);
  const reversalEligible = isPreviousDayLiquidity && hasAbsorption;

  if (reversalEligible) {
    // Only qualifying absorption at PDH/PDL may create a reversal.
    // A mismatched absorption is not continuation evidence.
    // IMPORTANT: never cancel an already-active continuation setup merely
    // because ATR expansion/reselection now points at another zone. The
    // active continuation owns its anchored zone until success or expiry.
    const activeContinuationSetup = script2PendingSetups[symbol]?.setupType === "CONTINUATION";
    if (!activeContinuationSetup) {
      delete script2PendingSetups[symbol];
    }

    const reversalDirection =
      atrSide === "LOW" && absorption.direction === "BUY" ? "BUY" :
      atrSide === "HIGH" && absorption.direction === "SELL" ? "SELL" :
      null;

    if (reversalDirection && !activeContinuationSetup) {
      const volumeImbalance = calculateOneCandleVolumeImbalance(closedCandles5);

      await sendMessage(
        `🛑 *ABSORPTION CONFIRMED* — *${symbol}*\n` +
        `🟢 ${absorption.type}\n` +
        `📊 Volume: *${Number(absorption.effortRatio).toFixed(2)}x average*\n` +
        `📏 Body/Range: *${(Number(absorption.bodyRatio) * 100).toFixed(1)}%*\n` +
        `↩️ Wick/Range: *${(Number(absorption.wickRatio) * 100).toFixed(1)}%*`
      );

      await sendMessage(
        `🔄 *REVERSAL DIRECTION CONFIRMED* — *${symbol}*\n` +
        `➡️ Direction: *${reversalDirection}*`
      );

      if (volumeImbalance?.direction === reversalDirection) {
        await sendMessage(
          `📊 *VOLUME IMBALANCE PASSED* — *${symbol}*\n` +
          `${reversalDirection === "BUY" ? "🟢" : "🔴"} ${reversalDirection}: *${Number(volumeImbalance?.[reversalDirection === "BUY" ? "buyPct" : "sellPct"] || 0).toFixed(1)}%*\n` +
          `🎯 Threshold: *${ENTRY_VOLUME_IMBALANCE_MIN_PERCENT}%*`
        );
        script2PendingSetups[symbol] = {
          direction: reversalDirection,
          setupType: "REVERSAL",
          absorption,
          zone: script2Zone,
          detectedAt: Date.now(),
          executionDirectionNotified: false,
          obvNotified: false,
          liquidityNotified: false,
          volumeImbalance
        };
      }
    }
  }
  }
}

// -----------------------------------------------------
// STEP 2B — STRUCTURE-BASED CONTINUATION CANDIDATE
// -----------------------------------------------------
// Continuation is intentionally independent of current-day ATR high/low.
// A meaningful swing/equal high can produce BUY continuation evidence; a
// meaningful swing/equal low can produce SELL continuation evidence.
// Once created, the structure level is locked to the setup.
if (script2MomentumRegime.allowed) {
  const existing = script2PendingSetups[symbol];
  const activeContinuation = existing?.setupType === "CONTINUATION";
  const activeReversal = existing?.setupType === "REVERSAL";

  if (!activeContinuation && !activeReversal) {
    const structureLevel = findScript2ContinuationStructureLevel(
      closedCandles5,
      script2CurrentPrice
    );

    if (structureLevel) {
      const volumeImbalance = calculateOneCandleVolumeImbalance(closedCandles5);
      const continuationDirection =
        volumeImbalance?.direction === structureLevel.direction
          ? structureLevel.direction
          : null;

      if (continuationDirection) {
        const latestClosedCandle = closedCandles5[closedCandles5.length - 1];
        const latestClosedCandleKey = getScript2CandleKey(
          latestClosedCandle,
          String(closedCandles5.length - 1)
        );

        const anchoredZone = {
          kind: "STRUCTURE",
          type: structureLevel.type,
          price: structureLevel.price,
          direction: continuationDirection
        };

        script2PendingSetups[symbol] = {
          direction: continuationDirection,
          setupType: "CONTINUATION",
          stage: "CANDIDATE",
          absorption: null,
          zone: anchoredZone,
          zoneLocked: true,
          anchoredZoneKey: `${structureLevel.type}:${structureLevel.price}`,
          anchoredBoundary: structureLevel.price,
          detectedAt: Date.now(),
          createdCandleKey: latestClosedCandleKey,
          breakCandleKey: null,
          continuationMode: "PENDING",
          breakNotified: false,
          highMomentumNotified: false,
          executionDirectionNotified: false,
          obvNotified: false,
          liquidityNotified: false,
          volumeImbalanceNotified: false,
          candidateNotified: false,
          volumeImbalance
        };

        await sendMessage(
          `📍 *CONTINUATION STRUCTURE REACHED* — *${symbol}*\n` +
          `🏗️ ${structureLevel.type}\n` +
          `🎯 Structure Level: *${Number(structureLevel.price).toPrecision(8)}*`
        );

        await sendMessage(
          `📊 *VOLUME IMBALANCE PASSED* — *${symbol}*\n` +
          `${continuationDirection === "BUY" ? "🟢" : "🔴"} ${continuationDirection}: *${Number(volumeImbalance?.[continuationDirection === "BUY" ? "buyPct" : "sellPct"] || 0).toFixed(1)}%*\n` +
          `🎯 Threshold: *${ENTRY_VOLUME_IMBALANCE_MIN_PERCENT}%*`
        );

        await sendMessage(
          `➡️ *CONTINUATION CANDIDATE CREATED* — *${symbol}*\n` +
          `Direction: *${continuationDirection}*\n` +
          `🔒 Structure locked at: *${Number(structureLevel.price).toPrecision(8)}*\n` +
          `📏 Setup remains alive while price stays within *${SCRIPT2_CONTINUATION_MAX_DISTANCE_PERCENT.toFixed(2)}%* of the structure`
        );
      }
    }
  }
}

// -----------------------------------------------------
// STEP 3 — ADVANCE A STAGED CONTINUATION
// -----------------------------------------------------
// This runs even after price leaves the original zone. Once a candidate
// exists, the bot watches for BOS without a fixed BOS time limit. High
// momentum can execute on BOS alone; adequate momentum requires a retest.
const confirmedContinuationDirection = await processScript2Continuation(
  symbol,
  closedCandles5,
  now,
  script2CurrentPrice,
  script2MomentumRegime.regime
);

// If a continuation was confirmed, it is now executable through the
// same existing manual-direction and liquidity gates below.
if (confirmedContinuationDirection) {
  const confirmedSetup = script2PendingSetups[symbol];
  if (confirmedSetup) {
    confirmedSetup.direction = confirmedContinuationDirection;
  }
}

// If price is no longer detected in a qualifying zone, keep the observation
// alive briefly to avoid false exits caused by a single scanner miss.
if (!script2Zone) {
  await finalizeScript2ZoneAbsorptionObservation(symbol, now);
}

// -----------------------------------------------------
// STEP 4 — EXECUTION DIRECTION + OBV CONFIRMATION
// -----------------------------------------------------
// STC is completely removed from execution. Once a valid setup is
// created and its direction is confirmed, the existing 5M OBV
// confirmation is the final directional confirmation before liquidity
// is checked and the market order is placed.

let direction = null;
const pendingSetup = script2PendingSetups[symbol];

if (pendingSetup) {
  // Continuations are executable after high-momentum BOS or after the
  // adequate-momentum BOS + failed-reclaim retest sequence.
  const continuationReady =
    pendingSetup.setupType !== "CONTINUATION" ||
    pendingSetup.stage === "HIGH_MOMENTUM_BREAK_CONFIRMED" ||
    pendingSetup.stage === "RETEST_CONFIRMED";

  const setupDirection = pendingSetup.direction;

  // Manual BULL/BEAR mode controls execution direction only.
  // It does not reintroduce STC into the entry logic.
  // /setbull = BUY only, /setbear = SELL only, /setauto = no manual restriction.
  const manualDirection =
    MANUAL_CYCLE === "BULL" ? "BUY" :
    MANUAL_CYCLE === "BEAR" ? "SELL" :
    null;

  if (
    continuationReady &&
    (!manualDirection || setupDirection === manualDirection)
  ) {
    direction = setupDirection;
  }
}

      // =====================================================
      // LIQUIDITY GATE + EXECUTION
      // =====================================================
      if (direction) {
        // Estimate total notional across active users so order-book depth
        // is evaluated against the actual size the bot is preparing to place.
        let estimatedTradeNotional = 0;
        for (const client of Object.values(userClients)) {
          try {
            const balances = await client.futuresBalance();
            const usdtBal = balances.find((b) => b.asset === "USDT");
            const bal = usdtBal ? parseFloat(usdtBal.balance) : 0;
            if (Number.isFinite(bal) && bal > 0) {
              estimatedTradeNotional += bal * TRADE_PERCENT;
            }
          } catch {}
        }

        if (!pendingSetup.executionDirectionNotified) {
          pendingSetup.executionDirectionNotified = true;
          await sendMessage(
            `🧭 *EXECUTION DIRECTION PASSED* — *${symbol}*\n` +
            `🟢 ${direction} allowed`
          );
        }

        // ---------------------------------------------------
        // FINAL CONFIRMATION — 5M OBV
        // ---------------------------------------------------
        // OBV is the final confirmation for both reversal and continuation
        // setups. A fresh crossover is NOT required; the latest closed 5M
        // OBV only needs to be on the correct side of its 50 EMA.
        const obvConfirmed = calculateOBVConfirmation(closedCandles5, direction);

        if (!obvConfirmed) {
          continue;
        }

        if (!pendingSetup.obvNotified) {
          pendingSetup.obvNotified = true;
          await sendMessage(
            `📈 *OBV CONFIRMATION PASSED* — *${symbol}*\n` +
            `${direction === "BUY" ? "🟢" : "🔴"} ${direction}\n` +
            `📊 Latest closed 5M OBV is on the correct side of the ${OBV_EMA_LENGTH}-EMA\n` +
            `✅ OBV is on the correct side of the EMA — no fresh crossover required`
          );
        }

        const liquidity = await checkLiquidity(symbol, direction, estimatedTradeNotional);
        if (!liquidity.passed) {
          await sendLiquidityWarning(symbol, direction, liquidity);
          continue;
        }

        if (liquidity.passed && !pendingSetup.liquidityNotified) {
          pendingSetup.liquidityNotified = true;
          await sendMessage(
            `💧 *LIQUIDITY GATE PASSED* — *${symbol}*\n` +
            `📚 Order-book liquidity sufficient`
          );
        }

        const setupForReport = pendingSetup;
        const executionResult = await executeMarketOrderForAllUsers(symbol, direction);

        if (executionResult.executed > 0) {
          const modeText = setupForReport.setupType === "CONTINUATION"
            ? (setupForReport.continuationMode === "HIGH_MOMENTUM"
              ? "🔥 HIGH-MOMENTUM CONTINUATION"
              : "⛔ CONTINUATION REJECTED")
            : "🔄 REVERSAL";

          await sendMessage(
            `🚀 *${modeText} ENTRY EXECUTED* — *${symbol}*\n` +
            `${direction === "BUY" ? "🟢" : "🔴"} *${symbol} ${direction}*\n` +
            `📈 Market Regime: *${script2MomentumRegime.regime}*\n` +
            `👥 Orders executed: ${executionResult.executed}/${executionResult.attempted}` +
            (executionResult.failed ? `\n⚠️ Failed: ${executionResult.failed}` : "") +
            (executionResult.skipped ? `\n⏭️ Skipped: ${executionResult.skipped}` : "")
          );
        }

        delete script2PendingSetups[symbol];
        symbolCooldowns[symbol] = now;
      }
    } catch (err) {
      log(`❌ Script 2 scan error ${symbol}: ${err?.message || err}`);
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

// --- Trend Quality / Consolidation Filter ---
// A coin must show directional structure, efficient price movement,
// and a meaningful 4H EMA slope before it can enter the TOP 7.
const TREND_QUALITY_LOOKBACK = 10;
const TREND_QUALITY_STRUCTURE_LOOKBACK = 5;
const TREND_QUALITY_MIN_EFFICIENCY = 0.30;
const TREND_QUALITY_MIN_ATR_RATIO = 0.80;
const TREND_QUALITY_MIN_EMA_SLOPE_PCT = 0.05;



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
// 4H TREND QUALITY / CONSOLIDATION FILTER
//
// The 4H ATR-band trend can remain bullish/bearish even while
// price becomes compressed and moves sideways. This filter checks:
//
// • directional structure
// • price efficiency (trend vs chop)
// • EMA20 slope
// • current ATR relative to recent ATR
//
// STRONG TREND requires all core directional conditions.
// TRANSITION is shown for diagnostics but is NOT eligible for TOP 7.
// CONSOLIDATING coins are excluded from recommendations.
//======================================================

function analyzeTrendQuality(
    candles4H,
    trend4H
) {

    if (
        !candles4H ||
        !trend4H ||
        trend4H.trendState === 0
    ) {
        return {
            status: "CONSOLIDATING",
            score: 0,
            efficiency: 0,
            atrRatio: 0,
            emaSlopePct: 0,
            structure: "NONE",
            reason: "No established directional 4H trend"
        };
    }

    const needed =
        Math.max(
            TREND_EMA_LENGTH + 5,
            TREND_QUALITY_LOOKBACK + 1,
            TREND_QUALITY_STRUCTURE_LOOKBACK + 2
        );

    if (candles4H.length < needed) {
        return {
            status: "CONSOLIDATING",
            score: 0,
            efficiency: 0,
            atrRatio: 0,
            emaSlopePct: 0,
            structure: "UNKNOWN",
            reason: "Insufficient 4H data"
        };
    }

    const end = candles4H.length - 1;
    const lookbackStart = end - TREND_QUALITY_LOOKBACK;
    const structureStart = end - TREND_QUALITY_STRUCTURE_LOOKBACK;

    const closes = candles4H.map(c => Number(c.close));
    const highs = candles4H.map(c => Number(c.high));
    const lows = candles4H.map(c => Number(c.low));

    if (
        !Number.isFinite(closes[end]) ||
        !Number.isFinite(closes[lookbackStart])
    ) {
        return {
            status: "CONSOLIDATING",
            score: 0,
            efficiency: 0,
            atrRatio: 0,
            emaSlopePct: 0,
            structure: "UNKNOWN",
            reason: "Invalid 4H price data"
        };
    }

    // -----------------------------------------------
    // PRICE EFFICIENCY
    // Net directional movement divided by total
    // absolute movement over the last 10 closed 4H bars.
    // Higher values = cleaner trend; lower values = chop.
    // -----------------------------------------------
    let path = 0;

    for (let i = lookbackStart + 1; i <= end; i++) {
        if (
            Number.isFinite(closes[i]) &&
            Number.isFinite(closes[i - 1])
        ) {
            path += Math.abs(closes[i] - closes[i - 1]);
        }
    }

    const netMove =
        closes[end] - closes[lookbackStart];

    const efficiency =
        path > 0
            ? Math.abs(netMove) / path
            : 0;

    // -----------------------------------------------
    // EMA20 SLOPE
    // Compare the latest EMA20 with its value five
    // closed 4H candles earlier.
    // -----------------------------------------------
    const emaNow =
        calculateEMAValue(
            candles4H.slice(0, end + 1),
            TREND_EMA_LENGTH
        );

    const emaEarlier =
        calculateEMAValue(
            candles4H.slice(0, end - 5 + 1),
            TREND_EMA_LENGTH
        );

    const emaSlopePct =
        Number.isFinite(emaNow) &&
        Number.isFinite(emaEarlier) &&
        emaEarlier !== 0
            ? ((emaNow - emaEarlier) / Math.abs(emaEarlier)) * 100
            : 0;

    // -----------------------------------------------
    // ATR EXPANSION / COMPRESSION
    // Current ATR14 compared with the average ATR14
    // over the previous 10 available ATR readings.
    // -----------------------------------------------
    const atrValues = [];

    for (
        let i = Math.max(TREND_ATR_LENGTH, end - 19);
        i <= end;
        i++
    ) {
        const atr =
            calculateATRValue(
                candles4H.slice(0, i + 1),
                TREND_ATR_LENGTH
            );

        if (Number.isFinite(atr) && atr > 0) {
            atrValues.push(atr);
        }
    }

    const currentATR =
        atrValues.length
            ? atrValues[atrValues.length - 1]
            : null;

    const previousATRValues =
        atrValues.length > 1
            ? atrValues.slice(0, -1)
            : [];

    const averagePreviousATR =
        previousATRValues.length
            ? previousATRValues.reduce((sum, value) => sum + value, 0) / previousATRValues.length
            : null;

    const atrRatio =
        Number.isFinite(currentATR) &&
        Number.isFinite(averagePreviousATR) &&
        averagePreviousATR > 0
            ? currentATR / averagePreviousATR
            : 0;

    // -----------------------------------------------
    // DIRECTIONAL STRUCTURE
    // Require the latest close to continue moving in
    // the established 4H direction and to sit on the
    // correct side of the recent range midpoint.
    // -----------------------------------------------
    const recentHighs = highs.slice(structureStart, end + 1).filter(Number.isFinite);
    const recentLows = lows.slice(structureStart, end + 1).filter(Number.isFinite);

    const priorHighs = highs.slice(Math.max(0, structureStart - TREND_QUALITY_STRUCTURE_LOOKBACK), structureStart).filter(Number.isFinite);
    const priorLows = lows.slice(Math.max(0, structureStart - TREND_QUALITY_STRUCTURE_LOOKBACK), structureStart).filter(Number.isFinite);

    const recentHigh = recentHighs.length ? Math.max(...recentHighs) : null;
    const recentLow = recentLows.length ? Math.min(...recentLows) : null;
    const priorHigh = priorHighs.length ? Math.max(...priorHighs) : null;
    const priorLow = priorLows.length ? Math.min(...priorLows) : null;

    const rangeHigh = Math.max(...highs.slice(lookbackStart, end + 1).filter(Number.isFinite));
    const rangeLow = Math.min(...lows.slice(lookbackStart, end + 1).filter(Number.isFinite));
    const rangeMid = (rangeHigh + rangeLow) / 2;

    let structure = "NEUTRAL";

    if (trend4H.trendState === 1) {
        structure =
            closes[end] > closes[structureStart] &&
            closes[end] > rangeMid &&
            recentHigh !== null &&
            priorHigh !== null &&
            recentHigh > priorHigh
                ? "BULLISH STRUCTURE"
                : "WEAK BULLISH STRUCTURE";
    }
    else if (trend4H.trendState === -1) {
        structure =
            closes[end] < closes[structureStart] &&
            closes[end] < rangeMid &&
            recentLow !== null &&
            priorLow !== null &&
            recentLow < priorLow
                ? "BEARISH STRUCTURE"
                : "WEAK BEARISH STRUCTURE";
    }

    const structureAligned =
        structure === "BULLISH STRUCTURE" ||
        structure === "BEARISH STRUCTURE";

    const emaSlopeAligned =
        (trend4H.trendState === 1 && emaSlopePct >= TREND_QUALITY_MIN_EMA_SLOPE_PCT) ||
        (trend4H.trendState === -1 && emaSlopePct <= -TREND_QUALITY_MIN_EMA_SLOPE_PCT);

    const efficiencyStrong =
        efficiency >= TREND_QUALITY_MIN_EFFICIENCY;

    const volatilityHealthy =
        atrRatio >= TREND_QUALITY_MIN_ATR_RATIO;

    const strongTrend =
        structureAligned &&
        emaSlopeAligned &&
        efficiencyStrong &&
        volatilityHealthy;

    const transitionTrend =
        structureAligned &&
        emaSlopeAligned &&
        efficiency >= 0.20;

    let status = "CONSOLIDATING";
    let score = 0;

    if (strongTrend) {
        status = "STRONG TREND";
        score = 100;
        if (atrRatio >= 1) score += 10;
        if (efficiency >= 0.50) score += 10;
    }
    else if (transitionTrend) {
        status = "TRANSITION";
        score = 50;
    }

    return {
        status,
        score,
        efficiency,
        atrRatio,
        emaSlopePct,
        structure,
        reason: strongTrend
            ? "Directional structure, EMA slope, efficiency and volatility confirmed"
            : transitionTrend
                ? "Directional structure present but trend strength/volatility is not fully confirmed"
                : "Price action lacks sufficient directional structure; consolidation risk is high"
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

        let trendQuality =
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

            trendQuality =
                analyzeTrendQuality(
                    closed4H,
                    trend4H
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

            trendQuality,

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

                        const strongTrend =
                            coin.trendQuality &&
                            coin.trendQuality.status ===
                            "STRONG TREND";


                        return (
                            bullishMomentum &&
                            bullishDelta &&
                            healthy &&
                            lowExhaustion &&
                            strongTrend
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

                        const strongTrend =
                            coin.trendQuality &&
                            coin.trendQuality.status ===
                            "STRONG TREND";


                        return (
                            bearishMomentum &&
                            bearishDelta &&
                            healthy &&
                            lowExhaustion &&
                            strongTrend
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
• Strong 4H trend quality (not consolidation)

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
                    // TREND QUALITY
                    //================================================

                    const quality =
                        coin.trendQuality || {
                            status: "UNKNOWN",
                            efficiency: 0,
                            atrRatio: 0,
                            emaSlopePct: 0,
                            structure: "UNKNOWN"
                        };

                    const qualityIcon =
                        quality.status === "STRONG TREND"
                            ? "🟢"
                            : quality.status === "TRANSITION"
                                ? "🟡"
                                : "🔴";

                    const qualityText =
                        `${qualityIcon} ${quality.status}`;


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
📐 4H QUALITY: ${qualityText}

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
4H trend quality must be STRONG TREND

📌 *TREND QUALITY GUIDE*
🟢 STRONG TREND = directional structure + efficient movement + EMA slope + healthy volatility
🟡 TRANSITION = directional structure is forming but confirmation is incomplete
🔴 CONSOLIDATING = insufficient directional structure / price efficiency

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

const ADMIN_CHAT_IDS = [
  "1718404728", // Existing admin
  "6907653103"  // Additional admin authorized to control the bot
];

// Helper function to check admin
function isAdmin(msg) {
  return ADMIN_CHAT_IDS.includes(String(msg?.chat?.id ?? ""));
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
  saveActivePositions();
  await sendMessage("🛑 All positions closed.");
});

// Execute the exact same tracked-position close order used by /close SYMBOL.
// BUY positions are closed with a market SELL; SELL positions with a market BUY.
async function closeTrackedPositionOrder(client, symbol, pos) {
  if (!client) throw new Error(`No client available for ${symbol}`);
  if (!pos || !Number.isFinite(Number(pos.qty)) || Number(pos.qty) <= 0) {
    throw new Error(`Invalid tracked quantity for ${symbol}`);
  }

  if (pos.side === "BUY") {
    return client.futuresMarketSell(symbol, pos.qty);
  }

  if (pos.side === "SELL") {
    return client.futuresMarketBuy(symbol, pos.qty);
  }

  throw new Error(`Unknown position side for ${symbol}: ${pos.side}`);
}

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
      await closeTrackedPositionOrder(client, symbol, pos);
      await sendMessage(`🛑 Closed *${symbol}* for User ${userId}`);
    } catch (err) {
      log(`❌ Failed to close ${symbol} for ${userId}: ${err?.message || err}`);
    }
  }
  delete activePositions[symbol];
  saveActivePositions();
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
async function deactivateSymbol(symbol, notify = true) {
  const normalizedSymbol = String(symbol || "").toUpperCase();
  if (!(normalizedSymbol in symbolActive)) return false;

  symbolActive[normalizedSymbol] = false;

  if (notify) {
    await sendMessage(
      `🚫 *${normalizedSymbol}* deactivated. No trades will be placed for this symbol.`
    );
  }

  return true;
}

bot.onText(/\/deactivate (\w+)/, async (msg, match) => {
  if (!isAdmin(msg)) return;
  const symbol = match[1].toUpperCase();
  if (!(symbol in symbolActive)) {
    await sendMessage(`⚠️ Symbol *${symbol}* not recognized.`);
    return;
  }
  await deactivateSymbol(symbol, true);
});

bot.onText(/\/activate (\w+)/, async (msg, match) => {
  if (!isAdmin(msg)) return;
  const symbol = match[1].toUpperCase();
  if (!(symbol in symbolActive)) {
    await sendMessage(`⚠️ Symbol *${symbol}* not recognized.`);
    return;
  }
  symbolActive[symbol] = true;
    await sendMessage(`✅ *${symbol}* activated. Trading resumed for this symbol. A fresh 5M OBV/50 EMA cross is required before entry.`);
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
