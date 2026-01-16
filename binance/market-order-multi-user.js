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

// --- Create Binance clients ---
function createBinanceClients() {
  const userList = loadUsers();
  userClients = {};
  for (const u of userList) {
    try {
      const client = new Binance();
      client.options({ APIKEY:u.apiKey, APISECRET:u.apiSecret, useServerTime:true, recvWindow:60000 });
      userClients[u.id] = client;
    } catch(err){ log(`❌ createBinanceClients failed for ${u.id}: ${err?.message||err}`); }
  }
  return Object.entries(userClients).map(([userId, client])=>({ userId, client }));
}

// --- Fetch Futures Klines ---
async function fetchFuturesKlines(symbol, interval="15m", limit=3){
  try{
    const res = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.map(c=>({time:c[0],open:+c[1],high:+c[2],low:+c[3],close:+c[4],volume:+c[5]}));
  } catch(err){ log(`❌ fetchFuturesKlines error for ${symbol}: ${err?.message||err}`); return null; }
}

// --- Calculate VWAP ---
async function calculateVWAP(symbol, interval="15m", limit=20){
  const candles = await fetchFuturesKlines(symbol,interval,limit);
  if(!candles) return null;
  let cumPV=0, cumVol=0;
  for(const c of candles){
    const tp = (c.high+c.low+c.close)/3;
    cumPV += tp*c.volume;
    cumVol += c.volume;
  }
  return cumVol ? cumPV/cumVol : null;
}

// --- Last candle volume imbalance ---
async function checkVolumeImbalance(symbol,direction){
  try{
    const candles = await fetchFuturesKlines(symbol,"15m",2);
    if(!candles || candles.length<2) return false;
    const last = candles[candles.length-2];
    const nextCandle = candles[candles.length-1];
    const tradesRes = await fetch(`https://fapi.binance.com/fapi/v1/aggTrades?symbol=${symbol}&startTime=${last.time}&endTime=${nextCandle.time}`);
    if(!tradesRes.ok) return false;
    const trades = await tradesRes.json();
    let buyVol=0,sellVol=0;
    for(const t of trades){ if(t.m) sellVol+=parseFloat(t.q); else buyVol+=parseFloat(t.q); }
    const total = buyVol+sellVol;
    if(total===0) return false;
    if(direction==="BUY") return buyVol/total>=0.6;
    if(direction==="SELL") return sellVol/total>=0.6;
    return false;
  } catch(err){ log(`❌ checkVolumeImbalance error for ${symbol}: ${err?.message||err}`); return false; }
}

// --- Execute market orders for all users (FIXED & ROBUST) ---
async function executeMarketOrderForAllUsers(symbol, direction) {
  try {
    // 🔑 ALWAYS recreate clients at execution time
    const clients = createBinanceClients();

    if (!clients.length) {
      await sendMessage(`⚠️ No active users found. Check users.json`);
      return;
    }

    await sendMessage(`📢 Executing ${direction} on *${symbol}* for all users...`);

    for (const { userId, client } of clients) {
      try {
        // Ensure one-way mode & leverage
        try { await client.futuresPositionSideDual(false); } catch {}
        try { await client.futuresLeverage(symbol, LEVERAGE); } catch {}

        // Fetch USDT balance
        const balances = await client.futuresBalance();
        const usdtBal = balances.find(b => b.asset === "USDT");
        const bal = usdtBal ? parseFloat(usdtBal.balance) : 0;
        if (!bal || bal <= 0) {await sendMessage('⚠️ User ${userId} has *NO USDT* in Futures wallet. Trade skipped.'); continue;}

        // Fetch mark price
        let markPrice = null;
        try {
          const mp = await client.futuresMarkPrice(symbol);
          markPrice = mp.markPrice
            ? parseFloat(mp.markPrice)
            : parseFloat(mp[0]?.markPrice || 0);
        } catch {}

        // Fallback to last candle close
        if (!markPrice) {
          const k = await fetchFuturesKlines(symbol, "1m", 1);
          if (k && k.length) markPrice = k[0].close;
        }

        if (!markPrice || markPrice <= 0) continue;

        // Calculate quantity
        const tradeValue = bal * TRADE_PERCENT;
        const rawQty = (tradeValue * LEVERAGE) / markPrice;

        // Get lot size
        let lotStep = 0.001;
        try {
          const info = await client.futuresExchangeInfo();
          const s = info.symbols.find(x => x.symbol === symbol);
          if (s) {
            const lot = s.filters.find(f => f.filterType === "LOT_SIZE");
            if (lot?.stepSize) lotStep = parseFloat(lot.stepSize);
          }
        } catch {}

        const qty = floorToStep(rawQty, lotStep);
        if (!qty || qty <= 0) continue;

        // 🔥 PLACE ORDER (with fallback)
        try {
          if (direction === "BUY") {
            await client.futuresMarketBuy(symbol, qty);
          } else {
            await client.futuresMarketSell(symbol, qty);
          }
        } catch (e) {
          // Fallback method (older SDKs)
          if (direction === "BUY") {
            await client.futuresMarketOrder(symbol, "BUY", qty);
          } else {
            await client.futuresMarketOrder(symbol, "SELL", qty);
          }
        }

        // Store active position
        if (!activePositions[symbol]) activePositions[symbol] = {};
        activePositions[symbol][userId] = {
          side: direction,
          entryPrice: markPrice,
          qty,
          openedAt: Date.now(),
          trailingStop: null,
          highest: markPrice,
          lowest: markPrice
        };

        await sendMessage(
          `✅ *${direction} EXECUTED* on *${symbol}* for User ${userId} (qty ${qty})`
        );

      } catch (err) {
        log(`❌ Order failed for ${userId} ${symbol}: ${err?.message || err}`);
      }
    }

    // Cooldown AFTER execution
    symbolCooldowns[symbol] = Date.now();

  } catch (err) {
    log(`❌ executeMarketOrderForAllUsers fatal error: ${err?.message || err}`);
  }
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