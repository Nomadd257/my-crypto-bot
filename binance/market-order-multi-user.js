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

// --- TELEGRAM DETAILS ---  
const TELEGRAM_BOT_TOKEN = "8247817335:AAEKf92ex9eiDZKoan1O8uzZ3ls5uEjJsQw";  
const GROUP_CHAT_ID = "-1003419090746";  
const ADMIN_ID = "7476742687";  
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });  

// --- USERS FILE ---  
const USERS_FILE = "./users.json";  

// --- Settings ---  
const TRADE_PERCENT = 0.10;        
const LEVERAGE = 20;  
const TP_PCT = 2.0;  
const SL_PCT = 1.5;                  
const TRAILING_STOP_PCT = 2.0;  

const MONITOR_INTERVAL_MS = 5000;  
const SIGNAL_CHECK_INTERVAL_MS = 60 * 1000;  
const COIN_LIST = [  
  "AVAXUSDT","NEARUSDT","LTCUSDT","XRPUSDT","APTUSDT",  
  "BNBUSDT","SOLUSDT","UNIUSDT","TRUMPUSDT","BCHUSDT",  
  "AAVEUSDT","ADAUSDT","TONUSDT","FILUSDT","LINKUSDT"  
];  
const MAX_TRADES = 4;  
const SYMBOL_COOLDOWN_MS = 1.5 * 60 * 60 * 1000; // 1.5 hours  
let BOT_PAUSED = false;  

// --- Trading sessions (UTC) ---  
const SESSIONS = [  
  { name: "Asia", start: 0, end: 9 },  
  { name: "London", start: 7, end: 16 },  
  { name: "New York", start: 12, end: 21 }  
];  

// --- In-memory ---  
let activePositions = {};  
let symbolCooldowns = {};  
let userClients = {};  

// --- Logging ---  
function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }  

// --- Load Users ---  
function loadUsers() {  
  try {  
    if (!fs.existsSync(USERS_FILE)) return [];  
    const raw = fs.readFileSync(USERS_FILE, "utf8").trim();  
    if (!raw) return [];  
    const parsed = JSON.parse(raw);  
    const users = [];  
    if (Array.isArray(parsed)) {  
      for (const u of parsed) if(u.active && u.apiKey && u.apiSecret) users.push({id:String(u.id),apiKey:u.apiKey,apiSecret:u.apiSecret});  
    } else {  
      for (const [k,v] of Object.entries(parsed)) if(v.active && v.apiKey && v.apiSecret) users.push({id:String(k),apiKey:v.apiKey,apiSecret:v.apiSecret});  
    }  
    return users;  
  } catch(err) { log(`❌ loadUsers error: ${err?.message||err}`); return []; }  
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
createBinanceClients();  
log("✅ Binance clients initialized at startup.");  
setInterval(createBinanceClients, 60 * 1000);  

// --- Telegram send ---  
async function sendMessage(msg){  
  try{ await bot.sendMessage(GROUP_CHAT_ID,msg,{parse_mode:"Markdown"}); } catch{}  
  try{ await bot.sendMessage(ADMIN_ID,msg,{parse_mode:"Markdown"}); } catch{}  
}  

// --- Session check ---  
function isSessionActive(){  
  const h = new Date().getUTCHours();  
  return SESSIONS.some(s=>h>=s.start && h<s.end);  
}  

// --- Fetch Futures Klines ---  
async function fetchFuturesKlines(symbol, interval="15m", limit=20){  
  try{  
    const res = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);  
    if(!res.ok) throw new Error(`HTTP ${res.status}`);  
    const data = await res.json();  
    return data.map(c=>({time:c[0],open:+c[1],high:+c[2],low:+c[3],close:+c[4],volume:+c[5]}));  
  } catch(err){ log(`❌ fetchFuturesKlines error for ${symbol}: ${err?.message||err}`); return null; }  
}  

// --- EMA3 calculation (15m closes) ---
function calculateEMA3(closes) {
  if (!closes || closes.length < 3) return null;
  let ema = closes[0];
  const k = 2 / (3 + 1);
  for (let i = 1; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

// --- Support/Resistance detection (30m) ---
async function getSupportResistance(symbol){
  const candles = await fetchFuturesKlines(symbol,"30m",50);
  if(!candles) return null;
  const highs = candles.map(c=>c.high);
  const lows = candles.map(c=>c.low);
  const resistance = Math.max(...highs);
  const support = Math.min(...lows);
  return {support,resistance};
}

// --- Volume Imbalance Report (15m) ---
async function sendVolumeImbalanceReport(symbol){
  const candles = await fetchFuturesKlines(symbol,"15m",20);
  if(!candles || candles.length === 0) return;

  let buyVol = 0, sellVol = 0;
  for(const c of candles){
    if(c.close > c.open) buyVol += c.volume;
    else sellVol += c.volume;
  }

  const totalVol = buyVol + sellVol;
  const buyPct = totalVol > 0 ? (buyVol / totalVol * 100).toFixed(1) : 0;
  const sellPct = totalVol > 0 ? (sellVol / totalVol * 100).toFixed(1) : 0;

  await sendMessage(
    `📊 Volume Imbalance Report: *${symbol}*\n` +
    `Buy Vol: ${buyVol.toFixed(2)} (${buyPct}%)\n` +
    `Sell Vol: ${sellVol.toFixed(2)} (${sellPct}%)`
  );
}

// --- Floor qty ---  
function floorToStep(qty,step){  
  const s=Number(step); if(!s||s<=0) return qty;  
  const factor=Math.round(1/s);  
  return Number((Math.floor(qty*factor)/factor).toFixed((s.toString().split(".")[1]||"").length));  
}  

// --- Execute market orders for all users ---  
async function executeMarketOrderForAllUsers(symbol, direction) {  
  const clients = Object.entries(userClients).map(([userId, client]) => ({ userId, client }));  
  if (!clients.length) { await sendMessage(`⚠️ No active users.`); return; }  

  await sendMessage(`📢 Executing ${direction} on *${symbol}* for all users...`);  

  for (const { userId, client } of clients) {  
    try {  
      await client.futuresLeverage(symbol, LEVERAGE).catch(()=>{});  
      const balances = await client.futuresBalance();  
      const usdtBal = balances.find(b => b.asset === "USDT");  
      const bal = usdtBal ? parseFloat(usdtBal.balance) : 0;  
      if(!bal || bal<=0){ await sendMessage(`⚠️ User ${userId} has *NO USDT*. Trade skipped.`); continue; }  

      let markPrice=0;  
      try { const mp = await client.futuresMarkPrice(symbol); markPrice = mp.markPrice ? parseFloat(mp.markPrice) : parseFloat(mp[0]?.markPrice||0); } catch{}  
      if(!markPrice || markPrice<=0){ const k = await fetchFuturesKlines(symbol,"1m",1); markPrice=k&&k.length?k[0].close:0; }  
      if(!markPrice || markPrice<=0){ log(`⚠️ markPrice invalid for ${symbol}, skipping user ${userId}`); continue; }  

      const tradeValue = bal * TRADE_PERCENT;  
      const rawQty = (tradeValue*LEVERAGE)/markPrice;  

      let lotStep = 0.001;  
      try{ const info = await client.futuresExchangeInfo(); const s=info.symbols.find(s=>s.symbol===symbol); if(s) lotStep=parseFloat(s.filters.find(f=>f.filterType==="LOT_SIZE")?.stepSize||lotStep); } catch{}  

      const qty=floorToStep(rawQty,lotStep);  
      if(!qty || qty<=0) continue;  

      try{  
        if(direction==="BUY") await client.futuresMarketBuy(symbol,qty);  
        else await client.futuresMarketSell(symbol,qty);  

        if(!activePositions[symbol]) activePositions[symbol]={};  
        activePositions[symbol][userId]={  
          side:direction, entryPrice:markPrice, qty, openedAt:Date.now(), trailingStop:null, highest:markPrice, lowest:markPrice  
        };  
        await sendMessage(`✅ *${direction} EXECUTED* on *${symbol}* for User ${userId} (qty ${qty})`);  
      } catch(err){ log(`❌ Order failed for ${userId} on ${symbol}: ${err?.message||err}`); }  

    } catch(err){ log(`❌ executeMarketOrder error for ${userId} ${symbol}: ${err?.message||err}`); }  
  }  

  symbolCooldowns[symbol] = Date.now();  
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
        const p = Array.isArray(positions) ? positions.find(x => x.symbol === symbol) : null;
        const amt = p ? parseFloat(p.positionAmt || 0) : 0;
        if (!p || amt === 0) { delete activePositions[symbol][userId]; continue; }

        let mark = 0;
        try { const mp = await client.futuresMarkPrice(symbol); mark = mp?.markPrice ? parseFloat(mp.markPrice) : 0; } catch{}
        if (!mark || mark <= 0) continue;

        // Trailing Stop
        if (pos.side === "BUY") {
          pos.highest = Math.max(pos.highest, mark);
          const trail = pos.highest * (1 - TRAILING_STOP_PCT / 100);
          if (!pos.trailingStop || trail > pos.trailingStop) pos.trailingStop = trail;
          if (mark <= pos.trailingStop) { await client.futuresMarketSell(symbol, Math.abs(amt)); delete activePositions[symbol][userId]; await sendMessage(`🔒 Trailing Stop Hit: *${symbol}* (User ${userId})`); continue; }
        } else {
          pos.lowest = Math.min(pos.lowest, mark);
          const trail = pos.lowest * (1 + TRAILING_STOP_PCT / 100);
          if (!pos.trailingStop || trail < pos.trailingStop) pos.trailingStop = trail;
          if (mark >= pos.trailingStop) { await client.futuresMarketBuy(symbol, Math.abs(amt)); delete activePositions[symbol][userId]; await sendMessage(`🔒 Trailing Stop Hit: *${symbol}* (User ${userId})`); continue; }
        }

        // TP / SL
        const move = pos.side==="BUY"?((mark-pos.entryPrice)/pos.entryPrice)*100:((pos.entryPrice-mark)/pos.entryPrice)*100;
        if (move>=TP_PCT) { if(pos.side==="BUY") await client.futuresMarketSell(symbol,Math.abs(amt)); else await client.futuresMarketBuy(symbol,Math.abs(amt)); delete activePositions[symbol][userId]; await sendMessage(`🎯 TAKE PROFIT: *${symbol}* User ${userId}`); continue; }
        if (move<=-SL_PCT) { if(pos.side==="BUY") await client.futuresMarketSell(symbol,Math.abs(amt)); else await client.futuresMarketBuy(symbol,Math.abs(amt)); delete activePositions[symbol][userId]; await sendMessage(`🔻 STOP LOSS: *${symbol}* User ${userId}`); continue; }

      } catch (err) {
        log(`❌ monitorPositions error ${userId} ${symbol}: ${err?.message || err}`);
      }
    }
  }
}
setInterval(monitorPositions, MONITOR_INTERVAL_MS);

// --- Full-auto scanning loop (Support/Resistance + EMA3 + Volume Imbalance) ---
setInterval(async () => {
  if (BOT_PAUSED) return;
  if (!isSessionActive()) return;

  let openTrades = Object.keys(activePositions).length;

  for (const symbol of COIN_LIST) {
    if (openTrades >= MAX_TRADES) break;

    const lastTradeTime = symbolCooldowns[symbol] || 0;
    if (Date.now() - lastTradeTime < SYMBOL_COOLDOWN_MS) continue;

    try {
      // Get 30m support & resistance
      const sr = await getSupportResistance(symbol);
      if(!sr) continue;

      // Get last 5 x 15m closes for EMA3
      const candles15 = await fetchFuturesKlines(symbol,"15m",5);
      if(!candles15 || candles15.length<3) continue;
      const closes = candles15.map(c=>c.close);
      const ema3 = calculateEMA3(closes);
      if(!ema3) continue;

      const lastClose = closes[closes.length-1];

      // --- Determine trade type & direction ---
      let tradeType = null;
      let direction = null;

      // 1️⃣ Bounce trades
      if (lastClose <= sr.support && lastClose > ema3) {
        tradeType = "BOUNCE";
        direction = "BUY";
      }
      if (lastClose >= sr.resistance && lastClose < ema3) {
        tradeType = "BOUNCE";
        direction = "SELL";
      }

      // 2️⃣ Breakout trades
      if (lastClose < sr.support && lastClose < ema3) {
        tradeType = "BREAKOUT";
        direction = "SELL";
      }
      if (lastClose > sr.resistance && lastClose > ema3) {
        tradeType = "BREAKOUT";
        direction = "BUY";
      }

      // --- Execute trade if any ---
      if (tradeType && direction) {
        await sendMessage(`⚡ *${tradeType} Trade Detected* on *${symbol}* → Direction: *${direction}*`);

        // Volume imbalance report (15m) with dominance %
        const candlesVol = await fetchFuturesKlines(symbol,"15m",20);
        if(candlesVol && candlesVol.length > 0){
          let buyVol = 0, sellVol = 0;
          for(const c of candlesVol){
            if(c.close > c.open) buyVol += c.volume;
            else sellVol += c.volume;
          }
          const totalVol = buyVol + sellVol;
          const buyPct = totalVol > 0 ? (buyVol / totalVol * 100).toFixed(1) : 0;
          const sellPct = totalVol > 0 ? (sellVol / totalVol * 100).toFixed(1) : 0;

          await sendMessage(
            `📊 Volume Imbalance Report: *${symbol}*\n` +
            `Buy Vol: ${buyVol.toFixed(2)} (${buyPct}%)\n` +
            `Sell Vol: ${sellVol.toFixed(2)} (${sellPct}%)`
          );
        }

        // Execute market order for all users
        await executeMarketOrderForAllUsers(symbol, direction);
      }

      openTrades = Object.keys(activePositions).length;

    } catch(err){
      log(`❌ scanLoop error ${symbol}: ${err?.message||err}`);
    }
  }
}, SIGNAL_CHECK_INTERVAL_MS);

// --- Telegram commands ---
bot.onText(/\/pause/, async () => { BOT_PAUSED = true; await sendMessage("⏸️ Bot has been paused."); });
bot.onText(/\/resume/, async () => { BOT_PAUSED = false; await sendMessage("▶️ Bot has resumed operation."); });

bot.onText(/\/closeall/, async () => {
  for (const [symbol, users] of Object.entries(activePositions)) {
    for (const [userId, pos] of Object.entries(users)) {
      const client = userClients[userId]; if(!client) continue;
      try { if(pos.side==="BUY") await client.futuresMarketSell(symbol,pos.qty); else await client.futuresMarketBuy(symbol,pos.qty); } catch{}
    }
  }
  activePositions={};
  await sendMessage("🛑 All positions have been closed.");
});

bot.onText(/\/close (.+)/, async (msg, match) => {
  const symbol = match[1].toUpperCase().trim();
  if (!activePositions[symbol]) { await sendMessage(`⚠️ No active position found for *${symbol}*`); return; }
  for (const [userId, pos] of Object.entries(activePositions[symbol])) {
    const client = userClients[userId]; if(!client) continue;
    try { if(pos.side==="BUY") await client.futuresMarketSell(symbol,pos.qty); else await client.futuresMarketBuy(symbol,pos.qty); await sendMessage(`🛑 Closed *${symbol}* for User ${userId}`); } catch(err){ log(`❌ Failed to close ${symbol} for ${userId}: ${err?.message||err}`); }
  }
  delete activePositions[symbol];
  await sendMessage(`✅ *${symbol}* fully closed for all users`);
});
