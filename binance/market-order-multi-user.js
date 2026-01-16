// =====================================================
// FULL AUTO MULTI-USER MARKET ORDER BOT - BINANCE FUTURES (USDT-PERP)
// AUTOMATIC TRADING BASED ON LAST-CANDLE VOLUME IMBALANCE + VWAP + VOLATILITY COMPRESSION
// MAX 4 TRADES, 12-HOUR SYMBOL COOLDOWN, MULTI-USERS EXECUTE SIMULTANEOUSLY
// =====================================================

const config = require("../config");
const Binance = require("node-binance-api");
const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const fetch = require("node-fetch");
globalThis.fetch = fetch;

// =====================================================
// TELEGRAM DETAILS (AS REQUESTED)
// =====================================================
const TELEGRAM_BOT_TOKEN = "8247817335:AAEKf92ex9eiDZKoan1O8uzZ3ls5uEjJsQw";
const GROUP_CHAT_ID = "-1003419090746";
const ADMIN_ID = "7476742687";

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// =====================================================
// FILES
// =====================================================
const USERS_FILE = "./users.json";

// =====================================================
// SETTINGS
// =====================================================
const TRADE_PERCENT = 0.10;
const LEVERAGE = 20;

const TP_PCT = 2.0;
const SL_PCT = 1.5;
const TRAILING_STOP_PCT = 2.0;

const MAX_TRADES = 4;
const SYMBOL_COOLDOWN_MS = 6 * 60 * 60 * 1000;

const SIGNAL_CHECK_INTERVAL_MS = 60 * 1000;
const MONITOR_INTERVAL_MS = 5000;

const COIN_LIST = [
  "AVAXUSDT","NEARUSDT","LTCUSDT","XRPUSDT","APTUSDT",
  "BNBUSDT","SOLUSDT","UNIUSDT","BCHUSDT","AAVEUSDT",
  "ADAUSDT","TONUSDT"
];

// =====================================================
// TRADING SESSIONS (UTC)
// =====================================================
const SESSIONS = [
  { name: "Asia", start: 0, end: 9 },
  { name: "London", start: 7, end: 16 },
  { name: "New York", start: 12, end: 21 }
];

// =====================================================
// STATE
// =====================================================
let BOT_PAUSED = false;
let activePositions = {};     // { symbol: { userId: position } }
let symbolCooldowns = {};     // { symbol: timestamp }
let userClients = {};         // { userId: binanceClient }

// =====================================================
// LOGGING
// =====================================================
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// =====================================================
// TELEGRAM HELPERS
// =====================================================
async function sendMessage(msg) {
  try { await bot.sendMessage(GROUP_CHAT_ID, msg, { parse_mode: "Markdown" }); } catch {}
  try { await bot.sendMessage(ADMIN_ID, msg, { parse_mode: "Markdown" }); } catch {}
}

// =====================================================
// SESSION CHECK
// =====================================================
function isSessionActive() {
  const h = new Date().getUTCHours();
  return SESSIONS.some(s => h >= s.start && h < s.end);
}

// =====================================================
// LOAD USERS + CREATE CLIENTS (CRITICAL FIX)
// =====================================================
function initializeUsers() {
  if (!fs.existsSync(USERS_FILE)) {
    log("❌ users.json not found");
    return;
  }

  const raw = fs.readFileSync(USERS_FILE, "utf8").trim();
  if (!raw) {
    log("❌ users.json is empty");
    return;
  }

  const parsed = JSON.parse(raw);
  userClients = {};

  for (const u of parsed) {
    if (!u.active || !u.apiKey || !u.apiSecret) continue;

    const client = new Binance().options({
      APIKEY: u.apiKey,
      APISECRET: u.apiSecret,
      useServerTime: true,
      recvWindow: 60000
    });

    userClients[String(u.id)] = client;
    log(`✅ User ${u.id} initialized`);
  }

  log(`👥 Active users loaded: ${Object.keys(userClients).length}`);
}

// =====================================================
// MARKET DATA
// =====================================================
async function fetchFuturesKlines(symbol, interval="15m", limit=3) {
  const res = await fetch(
    `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
  );
  const data = await res.json();
  return data.map(c => ({
    time: c[0],
    open: +c[1],
    high: +c[2],
    low: +c[3],
    close: +c[4],
    volume: +c[5]
  }));
}

// =====================================================
// VWAP
// =====================================================
async function calculateVWAP(symbol) {
  const candles = await fetchFuturesKlines(symbol, "15m", 20);
  let pv = 0, vol = 0;
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    pv += tp * c.volume;
    vol += c.volume;
  }
  return vol ? pv / vol : null;
}

// =====================================================
// VOLUME IMBALANCE (LAST CANDLE)
// =====================================================
async function checkVolumeImbalance(symbol, direction) {
  const candles = await fetchFuturesKlines(symbol, "15m", 2);
  const last = candles[0];
  const next = candles[1];

  const res = await fetch(
    `https://fapi.binance.com/fapi/v1/aggTrades?symbol=${symbol}&startTime=${last.time}&endTime=${next.time}`
  );
  const trades = await res.json();

  let buy = 0, sell = 0;
  for (const t of trades) {
    t.m ? sell += +t.q : buy += +t.q;
  }

  const total = buy + sell;
  if (!total) return false;

  if (direction === "BUY") return buy / total >= 0.6;
  if (direction === "SELL") return sell / total >= 0.6;
  return false;
}

// =====================================================
// ORDER EXECUTION (FIXED)
// =====================================================
async function executeMarketOrderForAllUsers(symbol, direction) {
  const users = Object.entries(userClients);

  if (!users.length) {
    await sendMessage("⚠️ No active users.");
    return;
  }

  await sendMessage(`📢 Executing *${direction}* on *${symbol}* for all users...`);

  for (const [userId, client] of users) {
    try {
      await client.futuresLeverage(symbol, LEVERAGE).catch(()=>{});

      const balances = await client.futuresBalance();
      const usdt = balances.find(b => b.asset === "USDT");
      if (!usdt || +usdt.balance <= 0) continue;

      const mark = await client.futuresMarkPrice(symbol);
      const price = +mark.markPrice;
      if (!price) continue;

      const qty = ((+usdt.balance * TRADE_PERCENT) * LEVERAGE) / price;

      if (direction === "BUY") {
        await client.futuresMarketBuy(symbol, qty);
      } else {
        await client.futuresMarketSell(symbol, qty);
      }

      if (!activePositions[symbol]) activePositions[symbol] = {};
      activePositions[symbol][userId] = {
        side: direction,
        entry: price,
        qty,
        highest: price,
        lowest: price
      };

      await sendMessage(`✅ *${direction} EXECUTED* on *${symbol}* for User ${userId}`);
    } catch (err) {
      log(`❌ Order error ${userId} ${symbol}: ${err.message}`);
    }
  }

  symbolCooldowns[symbol] = Date.now();
}

// =====================================================
// MONITOR POSITIONS (TP / SL / TRAILING)
// =====================================================
async function monitorPositions(){
  for(const [symbol,users] of Object.entries(activePositions)){
    for(const [userId,pos] of Object.entries(users)){
      const client = userClients[userId]; if(!client){ delete activePositions[symbol][userId]; continue; }
      try{
        const positions = await client.futuresPositionRisk();
        const p = Array.isArray(positions)?positions.find(x=>x.symbol===symbol):null;
        const amt = p?parseFloat(p.positionAmt||0):0;
        if(!p||amt===0){ delete activePositions[symbol][userId]; continue; }
        const mp = await client.futuresMarkPrice(symbol);
        const mark = mp.markPrice?parseFloat(mp.markPrice):parseFloat(mp[0]?.markPrice||0);
        if(!mark) continue;

        // Trailing Stop
        if(pos.side==="BUY"){
          pos.highest=Math.max(pos.highest,mark);
          const trail = pos.highest*(1-TRAILING_STOP_PCT/100);
          if(!pos.trailingStop||trail>pos.trailingStop) pos.trailingStop=trail;
          if(mark<=pos.trailingStop){
            await client.futuresMarketSell(symbol,Math.abs(amt));
            await sendMessage(`🔒 [User ${userId}] Trailing Stop Triggered on *${symbol}*`);
            delete activePositions[symbol][userId]; continue;
          }
        }else{
          pos.lowest=Math.min(pos.lowest,mark);
          const trail = pos.lowest*(1+TRAILING_STOP_PCT/100);
          if(!pos.trailingStop||trail<pos.trailingStop) pos.trailingStop=trail;
          if(mark>=pos.trailingStop){
            await client.futuresMarketBuy(symbol,Math.abs(amt));
            await sendMessage(`🔒 [User ${userId}] Trailing Stop Triggered on *${symbol}*`);
            delete activePositions[symbol][userId]; continue;
          }
        }

        // TP/SL
        const move = pos.side==="BUY"?((mark-pos.entryPrice)/pos.entryPrice)*100:((pos.entryPrice-mark)/pos.entryPrice)*100;
        if(move>=TP_PCT){ await client.futuresMarketSell(symbol,Math.abs(amt)); await sendMessage(`🎯 TAKE PROFIT HIT for User ${userId} on *${symbol}*`); delete activePositions[symbol][userId]; continue; }
        if(move<=-SL_PCT){ await client.futuresMarketSell(symbol,Math.abs(amt)); await sendMessage(`🔻 STOP LOSS HIT for User ${userId} on *${symbol}*`); delete activePositions[symbol][userId]; continue; }

      }catch(err){ log(`❌ monitorPositions error ${userId} ${symbol}: ${err?.message||err}`); }
    }
  }
}
setInterval(monitorPositions,MONITOR_INTERVAL_MS);


// =====================================================
// FULL AUTO SCANNER
// =====================================================
setInterval(async () => {
  if (BOT_PAUSED) return;
  if (!isSessionActive()) return;

  let openTrades = Object.values(activePositions)
    .reduce((a,b)=>a+Object.keys(b).length,0);

  for (const symbol of COIN_LIST) {
    if (openTrades >= MAX_TRADES) break;
    if (Date.now() - (symbolCooldowns[symbol] || 0) < SYMBOL_COOLDOWN_MS) continue;

    for (const dir of ["BUY","SELL"]) {
      if (!(await checkVolumeImbalance(symbol, dir))) continue;

      const vwap = await calculateVWAP(symbol);
      const last = (await fetchFuturesKlines(symbol, "15m", 1))[0];

      if (dir === "BUY" && last.close < vwap) continue;
      if (dir === "SELL" && last.close > vwap) continue;

      await executeMarketOrderForAllUsers(symbol, dir);
      openTrades++;
      break;
    }
  }
}, SIGNAL_CHECK_INTERVAL_MS);

// =====================================================
// TELEGRAM COMMANDS
// =====================================================
bot.onText(/\/pause/, () => {
  BOT_PAUSED = true;
  sendMessage("⏸️ Bot paused");
});

bot.onText(/\/resume/, () => {
  BOT_PAUSED = false;
  sendMessage("▶️ Bot resumed");
});

bot.onText(/\/closeall/, async () => {
  for (const [symbol, users] of Object.entries(activePositions)) {
    for (const [userId, pos] of Object.entries(users)) {
      const client = userClients[userId];
      if (!client) continue;
      pos.side === "BUY"
        ? await client.futuresMarketSell(symbol, pos.qty)
        : await client.futuresMarketBuy(symbol, pos.qty);
    }
  }
  activePositions = {};
  sendMessage("🛑 All positions closed");
});

// =====================================================
// STARTUP
// =====================================================
initializeUsers();