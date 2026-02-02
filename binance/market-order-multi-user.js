// =====================================================
// MULTI-USER MARKET ORDER BOT - BINANCE FUTURES (USDT-PERP)
// CID SIGNALS + VOLUME IMBALANCE
// TP/SL/TRAILING STOP INTACT
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
const TRAILING_STOP_PCT = 1.7;
const MONITOR_INTERVAL_MS = 5000;
const SIGNAL_CHECK_INTERVAL_MS = 60 * 1000;
const MAX_TRADES = 7; // per user
const COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
const COIN_LIST = [
  "AVAXUSDT","NEARUSDT","LTCUSDT","XRPUSDT","APTUSDT",
  "BNBUSDT","SOLUSDT","UNIUSDT","TRUMPUSDT","BCHUSDT",
  "AAVEUSDT","ADAUSDT","TONUSDT","FILUSDT","LINKUSDT"
];

// --- In-memory ---
let activePositions = {};      // { symbol: { userId: position } }
let userClients = {};
let last1HBias = {};           // { symbol: "BULL"|"BEAR" }
let BOT_PAUSED = false;
let symbolCooldowns = {};      // { symbol: timestamp }

// --- STC cycle trackers ---
let currentCycle = {};        // { symbol: "BULL" | "BEAR" }
let last1HSTC = {};           // { symbol: previous 1H STC value }
let last15MSTCValue = {};     // { symbol: previous 15M STC value }

// --- Logging ---
function log(msg){ console.log(`[${new Date().toISOString()}] ${msg}`); }

// --- Load Users ---
function loadUsers(){
  try{
    if(!fs.existsSync(USERS_FILE)) return [];
    const raw = fs.readFileSync(USERS_FILE,"utf8").trim();
    if(!raw) return [];
    const parsed = JSON.parse(raw);
    const users = [];
    if(Array.isArray(parsed)){
      for(const u of parsed) if(u.active && u.apiKey && u.apiSecret) users.push({id:String(u.id),apiKey:u.apiKey,apiSecret:u.apiSecret});
    } else {
      for(const [k,v] of Object.entries(parsed)) if(v.active && v.apiKey && v.apiSecret) users.push({id:String(k),apiKey:v.apiKey,apiSecret:v.apiSecret});
    }
    return users;
  } catch(err){ log(`❌ loadUsers error: ${err?.message||err}`); return []; }
}

// --- Create Binance clients ---
function createBinanceClients(){
  const userList = loadUsers();
  userClients = {};
  for(const u of userList){
    try{
      const client = new Binance();
      client.options({APIKEY:u.apiKey,APISECRET:u.apiSecret,useServerTime:true,recvWindow:60000});
      userClients[u.id] = client;
    } catch(err){ log(`❌ createBinanceClients failed for ${u.id}: ${err?.message||err}`); }
  }
  return Object.entries(userClients).map(([userId, client])=>({ userId, client }));
}
createBinanceClients();
log("✅ Binance clients initialized at startup.");
setInterval(createBinanceClients, 60*1000);

// --- Telegram send ---
async function sendMessage(msg){
  try{ await bot.sendMessage(GROUP_CHAT_ID,msg,{parse_mode:"Markdown"}); } catch{}
  try{ await bot.sendMessage(ADMIN_ID,msg,{parse_mode:"Markdown"}); } catch{}
}

// --- Fetch Futures Klines ---
async function fetchFuturesKlines(symbol, interval="15m", limit=100){
  try{
    const res = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.map(c=>({time:c[0],open:+c[1],high:+c[2],low:+c[3],close:+c[4],volume:+c[5]}));
  } catch(err){ log(`❌ fetchFuturesKlines error for ${symbol}: ${err?.message||err}`); return null; }
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

// --- Floor qty ---
function floorToStep(qty, step){
  const s = Number(step); if(!s||s<=0) return qty;
  const factor = Math.round(1/s);
  return Number((Math.floor(qty*factor)/factor).toFixed((s.toString().split(".")[1]||"").length));
}

// --- Execute market orders for all users ---
async function executeMarketOrderForAllUsers(symbol, direction){
  const clients = Object.entries(userClients).map(([userId, client])=>({userId,client}));
  if(!clients.length){ await sendMessage(`⚠️ No active users.`); return; }

  await sendMessage(`⚡ Executing *${direction}* on *${symbol}* for all users...`);

  for(const {userId, client} of clients){
    try{
      // Check user MAX_TRADES
      const userOpenTrades = Object.values(activePositions).reduce((sum,sym)=>sum + (sym[userId]?1:0),0);
      if(userOpenTrades >= MAX_TRADES){ log(`User ${userId} has max open trades.`); continue; }

      await client.futuresLeverage(symbol,LEVERAGE).catch(()=>{});
      const balances = await client.futuresBalance();
      const usdtBal = balances.find(b=>b.asset==="USDT");
      const bal = usdtBal?parseFloat(usdtBal.balance):0;
      if(!bal || bal<=0){ await sendMessage(`⚠️ User ${userId} has *NO USDT*. Trade skipped.`); continue; }

      let markPrice=0;
      try{ const mp = await client.futuresMarkPrice(symbol); markPrice = mp.markPrice?parseFloat(mp.markPrice):parseFloat(mp[0]?.markPrice||0); } catch{}
      if(!markPrice || markPrice<=0){ const k = await fetchFuturesKlines(symbol,"1m",1); markPrice = k&&k.length?k[0].close:0; }
      if(!markPrice || markPrice<=0){ log(`⚠️ markPrice invalid for ${symbol}, skipping user ${userId}`); continue; }

      const tradeValue = bal*TRADE_PERCENT;
      const rawQty = (tradeValue*LEVERAGE)/markPrice;

      let lotStep = 0.001;
      try{ const info = await client.futuresExchangeInfo(); const s = info.symbols.find(s=>s.symbol===symbol); if(s) lotStep=parseFloat(s.filters.find(f=>f.filterType==="LOT_SIZE")?.stepSize||lotStep); } catch{}

      const qty = floorToStep(rawQty,lotStep);
      if(!qty || qty<=0) continue;

      try{
        if(direction==="BUY") await client.futuresMarketBuy(symbol,qty);
        else await client.futuresMarketSell(symbol,qty);

        if(!activePositions[symbol]) activePositions[symbol]={};
        activePositions[symbol][userId] = {side:direction,entryPrice:markPrice,qty,openedAt:Date.now(),trailingStop:null,highest:markPrice,lowest:markPrice};
        // Start cooldown for this symbol
        symbolCooldowns[symbol] = Date.now();
        await sendMessage(`✅ *${direction} EXECUTED* on *${symbol}* for User ${userId} (qty ${qty})`);
      } catch(err){ log(`❌ Order failed for ${userId} on ${symbol}: ${err?.message||err}`); }

    } catch(err){ log(`❌ executeMarketOrder error for ${userId} ${symbol}: ${err?.message||err}`); }
  }
}

// --- Monitor positions (TP/SL/Trailing Stop) ---
async function monitorPositions(){
  for(const [symbol, users] of Object.entries(activePositions)){
    for(const [userId, pos] of Object.entries(users)){
      const client = userClients[userId];
      if(!client){ delete activePositions[symbol][userId]; continue; }

      try{
        const positions = await client.futuresPositionRisk();
        const p = Array.isArray(positions)?positions.find(x=>x.symbol===symbol):null;
        const amt = p?parseFloat(p.positionAmt||0):0;
        if(!p||amt===0){ delete activePositions[symbol][userId]; continue; }

        let mark = 0;
        try{ const mp = await client.futuresMarkPrice(symbol); mark = mp?.markPrice?parseFloat(mp.markPrice):0; } catch{}
        if(!mark||mark<=0) continue;

        // Trailing Stop
        if(pos.side==="BUY"){
          pos.highest = Math.max(pos.highest, mark);
          const trail = pos.highest*(1-TRAILING_STOP_PCT/100);
          if(!pos.trailingStop || trail>pos.trailingStop) pos.trailingStop=trail;
          if(mark<=pos.trailingStop){ await client.futuresMarketSell(symbol,Math.abs(amt)); delete activePositions[symbol][userId]; await sendMessage(`🔒 Trailing Stop Hit: *${symbol}* (User ${userId})`); continue; }
        } else {
          pos.lowest = Math.min(pos.lowest, mark);
          const trail = pos.lowest*(1+TRAILING_STOP_PCT/100);
          if(!pos.trailingStop || trail < pos.trailingStop) pos.trailingStop=trail;
          if(mark>=pos.trailingStop){ await client.futuresMarketBuy(symbol,Math.abs(amt)); delete activePositions[symbol][userId]; await sendMessage(`🔒 Trailing Stop Hit: *${symbol}* (User ${userId})`); continue; }
        }

        // TP / SL
        const move = pos.side==="BUY"?((mark-pos.entryPrice)/pos.entryPrice)*100:((pos.entryPrice-mark)/pos.entryPrice)*100;
        if(move>=TP_PCT){ if(pos.side==="BUY") await client.futuresMarketSell(symbol,Math.abs(amt)); else await client.futuresMarketBuy(symbol,Math.abs(amt)); delete activePositions[symbol][userId]; await sendMessage(`🎯 TAKE PROFIT: *${symbol}* User ${userId}`); continue; }
        if(move<=-SL_PCT){ if(pos.side==="BUY") await client.futuresMarketSell(symbol,Math.abs(amt)); else await client.futuresMarketBuy(symbol,Math.abs(amt)); delete activePositions[symbol][userId]; await sendMessage(`🔻 STOP LOSS: *${symbol}* User ${userId}`); continue; }

      } catch(err){ log(`❌ monitorPositions error ${userId} ${symbol}: ${err?.message||err}`); }
    }
  }
}
setInterval(monitorPositions, MONITOR_INTERVAL_MS);

// --- Full-auto STC scanning loop with confirmed 1H cycle and 15M flip trades ---
setInterval(async () => {
  if (BOT_PAUSED) return;

  for (const symbol of COIN_LIST) {
    try {
      const now = Date.now();

      // --- Check symbol cooldown ---
      if(symbolCooldowns[symbol] && now - symbolCooldowns[symbol] < COOLDOWN_MS) continue;

      // --- 1H STC for cycle detection (closed candle only) ---
      const candles1H = await fetchFuturesKlines(symbol, "1h", 100);
      if (!candles1H || candles1H.length < 20) continue;
      const closes1H = candles1H.slice(0,-1).map(c => c.close); // exclude current forming candle
      const stc1H = calculateSTC(closes1H, { cycle: 4, fast: 10, slow: 20 });
      if(stc1H === null) continue;

      // --- Detect 1H flip based on closed candle ---
      const prev1H = last1HSTC[symbol] ?? stc1H;
      let flip = null;

      // Bullish flip: crosses 25 upward
      if(prev1H < 25 && stc1H >= 25) flip = "BULL";

      // Bearish flip: crosses 75 downward
      if(prev1H > 75 && stc1H <= 75) flip = "BEAR";

      if(flip){
        currentCycle[symbol] = flip;
        last15MSTCValue[symbol] = null; // reset 15M flip tracker on new cycle
        await sendMessage(`🔄 STC FLIP confirmed on closed 1H candle for *${symbol}*: ${flip} cycle started`);
      }

      last1HSTC[symbol] = stc1H; // update previous 1H STC

      // --- 15M STC for entry trades ---
      const candles15 = await fetchFuturesKlines(symbol, "15m", 100);
      if (!candles15 || candles15.length < 20) continue;
      const closes15 = candles15.map(c => c.close);
      const stc15 = calculateSTC(closes15, { cycle: 4, fast: 10, slow: 20 });
      if(stc15 === null) continue;

      // --- Detect 15M flips in the same 1H cycle ---
      const cycle = currentCycle[symbol]; // "BULL" or "BEAR"
      const prev15M = last15MSTCValue[symbol] ?? stc15;
      let direction = null;

      // Buy flip: 15M crosses above 25 in bullish cycle
      if(cycle === "BULL" && prev15M < 25 && stc15 >= 25) {
        direction = "BUY";
      }

      // Sell flip: 15M crosses below 75 in bearish cycle
      if(cycle === "BEAR" && prev15M > 75 && stc15 <= 75) {
        direction = "SELL";
      }

      last15MSTCValue[symbol] = stc15; // update 15M tracker

      // --- Execute trade if flip detected ---
      if(direction) await executeMarketOrderForAllUsers(symbol, direction);

      // --- Volume imbalance report ---
      const buyVol = candles15.reduce((sum, c) => sum + (c.close > c.open ? c.volume : 0), 0);
      const sellVol = candles15.reduce((sum, c) => sum + (c.close < c.open ? c.volume : 0), 0);
      const totalVol = buyVol + sellVol;
      const buyPct = totalVol > 0 ? ((buyVol / totalVol) * 100).toFixed(1) : 0;
      const sellPct = totalVol > 0 ? ((sellVol / totalVol) * 100).toFixed(1) : 0;
      await sendMessage(`📊 Volume Imbalance Report: *${symbol}*\nBuy Vol: ${buyVol.toFixed(2)} (${buyPct}%)\nSell Vol: ${sellVol.toFixed(2)} (${sellPct}%)`);

    } catch (err) {
      log(`❌ STC scan error ${symbol}: ${err?.message || err}`);
    }
  }
}, SIGNAL_CHECK_INTERVAL_MS);

// --- Telegram commands ---
bot.onText(/\/pause/, async()=>{ BOT_PAUSED=true; await sendMessage("⏸️ Bot paused."); });
bot.onText(/\/resume/, async()=>{ BOT_PAUSED=false; await sendMessage("▶️ Bot resumed."); });

bot.onText(/\/closeall/, async()=>{
  for(const [symbol, users] of Object.entries(activePositions)){
    for(const [userId,pos] of Object.entries(users)){
      const client = userClients[userId]; if(!client) continue;
      try{ if(pos.side==="BUY") await client.futuresMarketSell(symbol,pos.qty); else await client.futuresMarketBuy(symbol,pos.qty); } catch{}
    }
  }
  activePositions={};
  await sendMessage("🛑 All positions closed.");
});

bot.onText(/\/close (.+)/, async(msg, match)=>{
  const symbol = match[1].toUpperCase().trim();
  if(!activePositions[symbol]) { await sendMessage(`⚠️ No active position for *${symbol}*`); return; }
  for(const [userId,pos] of Object.entries(activePositions[symbol])){
    const client = userClients[userId]; if(!client) continue;
    try{ if(pos.side==="BUY") await client.futuresMarketSell(symbol,pos.qty); else await client.futuresMarketBuy(symbol,pos.qty); await sendMessage(`🛑 Closed *${symbol}* for User ${userId}`); } catch(err){ log(`❌ Failed to close ${symbol} for ${userId}: ${err?.message||err}`); }
  }
  delete activePositions[symbol];
  await sendMessage(`✅ *${symbol}* fully closed for all users`);
});
