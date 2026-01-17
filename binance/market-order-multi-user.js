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
const TRADE_PERCENT = 0.10;        // 10% of USDT balance
const LEVERAGE = 20;
const TP_PCT = 2.0;
const SL_PCT = 1.5;                // positive number
const TRAILING_STOP_PCT = 2.0;
const MONITOR_INTERVAL_MS = 5000;
const SIGNAL_CHECK_INTERVAL_MS = 60 * 1000;
const COIN_LIST = ["AVAXUSDT","NEARUSDT","LTCUSDT","XRPUSDT","APTUSDT","BNBUSDT","SOLUSDT","UNIUSDT","TRUMPUSDT","BCHUSDT","AAVEUSDT","ADAUSDT","TONUSDT","FILUSDT","LINKUSDT"];
const MAX_TRADES = 4;
const SYMBOL_COOLDOWN_MS = 3 * 60 * 60 * 1000; // 3 hours
let BOT_PAUSED = false;

// --- Trading sessions in UTC ---
const SESSIONS = [
  { name: "Asia", start: 0, end: 9 },
  { name: "London", start: 7, end: 16 },
  { name: "New York", start: 12, end: 21 }
];

// --- In-memory ---
let activePositions = {};   // { symbol: { userId: { side, entryPrice, qty, highest, lowest, trailingStop, openedAt } } }
let symbolCooldowns = {};   // { symbol: timestamp }
let userClients = {};       // { userId: client }

// --- Initialize Binance clients at startup ---
createBinanceClients();
log("✅ Binance clients initialized at startup.");

// --- Refresh users periodically ---
setInterval(() => {
  createBinanceClients();
  log("🔄 User clients refreshed.");
}, 60 * 1000);

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

// --- 1H Support & Resistance Filter ---
async function isNear1HSupportResistance(symbol, direction) {
  try {
    // Fetch last 20 1H candles
    const candles = await fetchFuturesKlines(symbol, "1h", 20);
    if (!candles || candles.length < 20) return false;

    // Find the highest high and lowest low
    const highs = candles.map(c => c.high);
    const lows  = candles.map(c => c.low);

    const resistance = Math.max(...highs);
    const support = Math.min(...lows);

    // Current price (last closed candle)
    const price = candles[candles.length - 1].close;

    // Buffer of 0.5%
    const BUFFER = 0.005; // 0.5%

    // Check proximity
    if (direction === "BUY" && price <= resistance * (1 + BUFFER)) return true;
    if (direction === "SELL" && price >= support * (1 - BUFFER)) return true;

    return false; // Not near support/resistance
  } catch (err) {
    log(`❌ 1H S/R error for ${symbol}: ${err.message}`);
    return false;
  }
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
  if (!clients.length) {
    await sendMessage(`⚠️ No active users.`);
    return;
  }

  await sendMessage(`📢 Executing ${direction} on *${symbol}* for all users...`);

  for (const { userId, client } of clients) {
    try {
      // Set leverage
      await client.futuresLeverage(symbol, LEVERAGE).catch(() => {});

      // Fetch USDT balance
        const balances = await client.futuresBalance();
        const usdtBal = balances.find(b => b.asset === "USDT");
        const bal = usdtBal ? parseFloat(usdtBal.balance) : 0;
        if (!bal || bal <= 0) {await sendMessage(`⚠️ User ${userId} has *NO USDT* in Futures wallet. Trade skipped.`); continue;}

      // Get mark price
      let markPrice = 0;
      try {
        const mp = await client.futuresMarkPrice(symbol);
        markPrice = mp.markPrice ? parseFloat(mp.markPrice) : parseFloat(mp[0]?.markPrice || 0);
      } catch (err) {
        log(`⚠️ markPrice fetch error for ${symbol}: ${err?.message || err}`);
      }

      if (!markPrice || markPrice <= 0) {
        // fallback to last 1m candle close
        const k = await fetchFuturesKlines(symbol, "1m", 1);
        markPrice = k && k.length ? k[0].close : 0;
      }

      if (!markPrice || markPrice <= 0) {
        log(`⚠️ markPrice invalid for ${symbol}, skipping user ${userId}`);
        continue;
      }

      // Calculate quantity
      const tradeValue = bal * TRADE_PERCENT;
      const rawQty = (tradeValue * LEVERAGE) / markPrice;

      // Get lot size step
      let lotStep = 0.001;
      try {
        const info = await client.futuresExchangeInfo();
        const s = info.symbols.find(s => s.symbol === symbol);
        if (s) lotStep = parseFloat(s.filters.find(f => f.filterType === "LOT_SIZE")?.stepSize || lotStep);
      } catch {}

      const qty = floorToStep(rawQty, lotStep);
      if (!qty || qty <= 0) continue;

      // --- PLACE ORDER ---
      try {
        if (direction === "BUY") {
          await client.futuresMarketBuy(symbol, qty);
        } else {
          await client.futuresMarketSell(symbol, qty);
        }

        // Record active position
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

        await sendMessage(`✅ *${direction} EXECUTED* on *${symbol}* for User ${userId} (qty ${qty})`);
      } catch (err) {
        log(`❌ Order failed for ${userId} on ${symbol}: ${err?.message || err}`);
      }

    } catch (err) {
      log(`❌ executeMarketOrder error for ${userId} ${symbol}: ${err?.message || err}`);
    }
  }

  // Set cooldown for the symbol
  symbolCooldowns[symbol] = Date.now();
}

// --- Monitor positions ---
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

// --- Full-auto scanning loop ---
setInterval(async()=>{
  if(BOT_PAUSED){
    log("⏸️ Bot is paused.");
    return;
  }

  if(!isSessionActive()){
    log("⏳ No active trading session.");
    return;
  }

  let openTrades = Object.values(activePositions).reduce((acc,users)=>acc+Object.keys(users).length,0);
  for(const symbol of COIN_LIST){
    if(openTrades>=MAX_TRADES) break;

    const lastTradeTime = symbolCooldowns[symbol]||0;
    if(Date.now()-lastTradeTime<SYMBOL_COOLDOWN_MS) continue;

    for(const dir of ["BUY","SELL"]){
      const volOk = await checkVolumeImbalance(symbol,dir);
      const vwap = await calculateVWAP(symbol);
      if(!volOk || !vwap) continue;

      // Directional VWAP check
      const lastCandle = (await fetchFuturesKlines(symbol,"15m",1))[0];
      if(dir==="BUY" && lastCandle.close<vwap) continue;
      if(dir==="SELL" && lastCandle.close>vwap) continue;

      const nearSR = await isNear1HSupportResistance(symbol, dir);
if (nearSR) {
  log(`⛔ 1H S/R BLOCK → ${symbol} ${dir}`);
  continue; // skip this symbol/direction, but continue scanning others
}

await executeMarketOrderForAllUsers(symbol, side);
      openTrades++;
      break; // only one direction per symbol at a time
    }
  }

}, SIGNAL_CHECK_INTERVAL_MS);

// --- Telegram commands ---
bot.onText(/\/pause/, async (msg)=>{
  BOT_PAUSED = true;
  await sendMessage("⏸️ Bot has been paused.");
});
bot.onText(/\/resume/, async (msg)=>{
  BOT_PAUSED = false;
  await sendMessage("▶️ Bot has resumed operation.");
});
bot.onText(/\/closeall/, async (msg)=>{
  for(const [symbol,users] of Object.entries(activePositions)){
    for(const [userId,pos] of Object.entries(users)){
      const client = userClients[userId]; if(!client) continue;
      try{
        if(pos.side==="BUY") await client.futuresMarketSell(symbol,pos.qty);
        else await client.futuresMarketBuy(symbol,pos.qty);
      }catch{}
    }
  }
  activePositions = {};
  await sendMessage("🛑 All positions have been closed.");
});
bot.onText(/\/close (.+)/, async (msg, match) => {
  const symbol = match[1].toUpperCase().trim();

  if (!activePositions[symbol]) {
    await sendMessage(`⚠️ No active position found for *${symbol}*`);
    return;
  }

  for (const [userId, pos] of Object.entries(activePositions[symbol])) {
    const client = userClients[userId];
    if (!client) continue;

    try {
      if (pos.side === "BUY") {
        await client.futuresMarketSell(symbol, pos.qty);
      } else {
        await client.futuresMarketBuy(symbol, pos.qty);
      }

      await sendMessage(`🛑 Closed *${symbol}* for User ${userId}`);
    } catch (err) {
      log(`❌ Failed to close ${symbol} for ${userId}: ${err?.message || err}`);
    }
  }

  delete activePositions[symbol];
  await sendMessage(`✅ *${symbol}* fully closed for all users`);
});