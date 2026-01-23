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

// --- Momentum validation ---  
const MOMENTUM_MIN_MOVE_PCT = 0.3;          // +0.3%  
const MOMENTUM_TIME_MS = 15 * 60 * 1000;    // 1 × 15m candle  

// --- VWAP zone awareness ---  
const VWAP_BAND_PCT = 0.5;          // VWAP upper/lower band %  
const VWAP_MOMENTUM_CONFIRM_PCT = 0.5; // Strong momentum confirmation  

// --- Higher timeframe VWAP bias ---  
const VWAP_BIAS_PCT = 0.2; // 0.2% buffer to avoid noise  

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

// --- 30m VWAP bias ---  
async function getVWAPBias(symbol) {  
  const vwap15 = await calculateVWAP(symbol, "15m", 20);   // still using 15m for fast VWAP
  const vwap30 = await calculateVWAP(symbol, "30m", 20);   // new higher timeframe VWAP
  if (!vwap15 || !vwap30) return null;  

  const diffPct = ((vwap15 - vwap30) / vwap30) * 100;      // % difference
  if (diffPct > VWAP_BIAS_PCT) return "BULLISH";  
  if (diffPct < -VWAP_BIAS_PCT) return "BEARISH";  
  return "NEUTRAL";  
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
          side:direction, entryPrice:markPrice, qty, openedAt:Date.now(), trailingStop:null, highest:markPrice, lowest:markPrice, momentumChecked:false  
        };  
        await sendMessage(`✅ *${direction} EXECUTED* on *${symbol}* for User ${userId} (qty ${qty})`);  
      } catch(err){ log(`❌ Order failed for ${userId} on ${symbol}: ${err?.message||err}`); }  

    } catch(err){ log(`❌ executeMarketOrder error for ${userId} ${symbol}: ${err?.message||err}`); }  
  }  

  symbolCooldowns[symbol] = Date.now();  
}  

// --- Monitor positions ---
async function monitorPositions() {
  for (const [symbol, users] of Object.entries(activePositions)) {
    for (const [userId, pos] of Object.entries(users)) {
      const client = userClients[userId];
      if (!client) {
        delete activePositions[symbol][userId];
        continue;
      }

      try {
        // --- Fetch position ---
        const positions = await client.futuresPositionRisk();
        const p = Array.isArray(positions)
          ? positions.find(x => x.symbol === symbol)
          : null;

        const amt = p ? parseFloat(p.positionAmt || 0) : 0;
        if (!p || amt === 0) {
          delete activePositions[symbol][userId];
          continue;
        }

        // --- Mark price (safe) ---
        let mark = 0;
        try {
          const mp = await client.futuresMarkPrice(symbol);
          mark = mp?.markPrice ? parseFloat(mp.markPrice) : 0;
        } catch {}
        if (!mark || mark <= 0) continue;

        // =====================================================
        // 1️⃣ Momentum + VWAP early validation (ONE-TIME CHECK)
        // =====================================================
        if (!pos.momentumChecked && Date.now() - pos.openedAt >= MOMENTUM_TIME_MS) {
          const movePct =
            pos.side === "BUY"
              ? ((mark - pos.entryPrice) / pos.entryPrice) * 100
              : ((pos.entryPrice - mark) / pos.entryPrice) * 100;

          let vwapOk = true;
          try {
            const vwap = await calculateVWAP(symbol, "15m", 20);
            if (vwap) {
              vwapOk = pos.side === "BUY" ? mark > vwap : mark < vwap;
            }
          } catch {}

          pos.momentumChecked = true;

          if (movePct < MOMENTUM_MIN_MOVE_PCT && !vwapOk) {
            if (pos.side === "BUY") {
              await client.futuresMarketSell(symbol, Math.abs(amt));
            } else {
              await client.futuresMarketBuy(symbol, Math.abs(amt));
            }

            await sendMessage(
              `⚠️ Momentum + VWAP Exit: *${symbol}* (${movePct.toFixed(2)}%) User ${userId}`
            );

            delete activePositions[symbol][userId];
            continue;
          }
        }

        // ===============================
        // 2️⃣ Trailing stop (ALWAYS RUNS)
        // ===============================
        if (pos.side === "BUY") {
          pos.highest = Math.max(pos.highest, mark);
          const trail = pos.highest * (1 - TRAILING_STOP_PCT / 100);
          if (!pos.trailingStop || trail > pos.trailingStop) {
            pos.trailingStop = trail;
          }
          if (mark <= pos.trailingStop) {
            await client.futuresMarketSell(symbol, Math.abs(amt));
            await sendMessage(`🔒 Trailing Stop Hit: *${symbol}* (User ${userId})`);
            delete activePositions[symbol][userId];
            continue;
          }
        } else {
          pos.lowest = Math.min(pos.lowest, mark);
          const trail = pos.lowest * (1 + TRAILING_STOP_PCT / 100);
          if (!pos.trailingStop || trail < pos.trailingStop) {
            pos.trailingStop = trail;
          }
          if (mark >= pos.trailingStop) {
            await client.futuresMarketBuy(symbol, Math.abs(amt));
            await sendMessage(`🔒 Trailing Stop Hit: *${symbol}* (User ${userId})`);
            delete activePositions[symbol][userId];
            continue;
          }
        }

        // ======================
        // 3️⃣ TP / SL (CRITICAL)
        // ======================
        const move =
          pos.side === "BUY"
            ? ((mark - pos.entryPrice) / pos.entryPrice) * 100
            : ((pos.entryPrice - mark) / pos.entryPrice) * 100;

        // TAKE PROFIT
        if (move >= TP_PCT) {
          if (pos.side === "BUY") {
            await client.futuresMarketSell(symbol, Math.abs(amt));
          } else {
            await client.futuresMarketBuy(symbol, Math.abs(amt));
          }

          await sendMessage(`🎯 TAKE PROFIT: *${symbol}* User ${userId}`);
          delete activePositions[symbol][userId];
          continue;
        }

        // STOP LOSS
        if (move <= -SL_PCT) {
          if (pos.side === "BUY") {
            await client.futuresMarketSell(symbol, Math.abs(amt));
          } else {
            await client.futuresMarketBuy(symbol, Math.abs(amt));
          }

          await sendMessage(`🔻 STOP LOSS: *${symbol}* User ${userId}`);
          delete activePositions[symbol][userId];
          continue;
        }

      } catch (err) {
        log(`❌ monitorPositions error ${userId} ${symbol}: ${err?.message || err}`);
      }
    }
  }
}

setInterval(monitorPositions, MONITOR_INTERVAL_MS);

// --- Full-auto scanning loop (NO No-Trade Zone, fast VWAP entries) ---
setInterval(async () => {
  if (BOT_PAUSED) return;
  if (!isSessionActive()) return;

  let openTrades = Object.keys(activePositions).length;

  for (const symbol of COIN_LIST) {
    if (openTrades >= MAX_TRADES) break;

    const lastTradeTime = symbolCooldowns[symbol] || 0;
    if (Date.now() - lastTradeTime < SYMBOL_COOLDOWN_MS) continue;

    for (const dir of ["BUY", "SELL"]) {
      try {
        // --- Fetch last closed 15m candle ---
        const candle = (await fetchFuturesKlines(symbol, "15m", 1))?.[0];
        if (!candle) continue;

        const price = candle.close;

        // --- Entry VWAP (15m) ---
        const vwap15 = await calculateVWAP(symbol, "15m", 20);
        if (!vwap15) continue;

        // --- Bias VWAP (30m) ---
        const bias = await getVWAPBias(symbol);
        if (!bias) continue;
        if (dir === "BUY" && bias !== "BULLISH") continue;
        if (dir === "SELL" && bias !== "BEARISH") continue;

        // --- PURE VWAP CROSS CONFIRMATION ---
        if (dir === "BUY" && price <= vwap15) continue;
        if (dir === "SELL" && price >= vwap15) continue;

        // --- Execute trade ---
        await executeMarketOrderForAllUsers(symbol, dir);
        openTrades++;
        break;

      } catch (err) {
        log(`❌ scanLoop error ${symbol} ${dir}: ${err?.message || err}`);
      }
    }
  }
}, SIGNAL_CHECK_INTERVAL_MS);
