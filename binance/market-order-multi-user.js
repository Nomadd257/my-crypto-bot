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
let BOT_PAUSED = false;
let symbolCooldowns = {};      // { symbol: timestamp }

// --- STC cycle trackers ---
let currentCycle = {};        // { symbol: "BULL" | "BEAR" }

let MANUAL_CYCLE = null; // "BULL" | "BEAR" | null

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

// --- Average True Range (ATR) ---
const ATR_PERIOD = 14; // standard ATR period

function calculateATR(candles, period = ATR_PERIOD) {
  if (!candles || candles.length < period + 1) return null;

  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trs.push(tr);
  }

  const recentTRs = trs.slice(-period);
  const atr = recentTRs.reduce((sum, val) => sum + val, 0) / period;
  return atr;
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

// --- Manual cycle per symbol ---
let MANUAL_CYCLE_BY_SYMBOL = {}; // e.g., { BTCUSDT: "BULL", ETHUSDT: "BEAR" }

let symbolActive = {};
COIN_LIST.forEach(s => symbolActive[s] = true); // By default, all symbols active

// --- Full-auto STC scanning loop (1H bias + 5M confirmed entries + ATR notifications) ---

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
      const closes1H = closedCandles1H.map(c => c.close);

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

      // =====================================================
      // 4-STATE ATR STRUCTURE CLASSIFICATION
      // =====================================================

      // -------- NEAR DAILY LOW --------
      if (distToLow / atr <= 0.2) {

        if (!symbolCooldownsATR[symbol] || now - symbolCooldownsATR[symbol] > atrMsgCooldown) {

          if (atrContracting) {
            await sendMessage(
              `🟢 *Bullish Flip*\n\n${symbol} near ATR LOW (${currPrice.toFixed(4)}) — ATR contracting. Watch for bullish flip`
            );
            bullishFlip.push(symbol);
          }

          if (atrExpanding) {
            await sendMessage(
              `🔴 *Bearish Continuation*\n\n${symbol} near ATR LOW (${currPrice.toFixed(4)}) — ATR expanding. Watch for bearish continuation`
            );
            bearishContinuation.push(symbol);
          }

          symbolCooldownsATR[symbol] = now;
        }
      }

      // -------- NEAR DAILY HIGH --------
      if (distToHigh / atr <= 0.2) {

        if (!symbolCooldownsATR[symbol] || now - symbolCooldownsATR[symbol] > atrMsgCooldown) {

          if (atrContracting) {
            await sendMessage(
              `🔴 *Bearish Flip*\n\n${symbol} near ATR HIGH (${currPrice.toFixed(4)}) — ATR contracting. Watch for bearish flip!`
            );
            bearishFlip.push(symbol);
          }

          if (atrExpanding) {
            await sendMessage(
              `🟢 *Bullish Continuation*\n\n${symbol} near ATR HIGH (${currPrice.toFixed(4)}) — ATR expanding. Watch for bullish continuation`
            );
            bullishContinuation.push(symbol);
          }

          symbolCooldownsATR[symbol] = now;
        }
      }

      // =====================================================
      // Skip trading if paused/inactive
      // =====================================================
      if (!isActive || BOT_PAUSED) continue;

      if (symbolCooldowns[symbol] && now - symbolCooldowns[symbol] < COOLDOWN_MS) continue;

      // =====================================================
      // 1H STC CYCLE LOCK
      // =====================================================
      if (!currentCycle[symbol]) {

        if (MANUAL_CYCLE_BY_SYMBOL[symbol]) {
          currentCycle[symbol] = MANUAL_CYCLE_BY_SYMBOL[symbol];
        } else if (MANUAL_CYCLE) {
          currentCycle[symbol] = MANUAL_CYCLE;
        } else {

          const stcSeries1H = [];

          for (let i = 0; i < closes1H.length; i++) {
            const slice = closes1H.slice(0, i + 1);
            const val = calculateSTC(slice, { cycle: 4, fast: 10, slow: 20 });
            if (val !== null) stcSeries1H.push(val);
          }

          if (stcSeries1H.length < 2) continue;

          const prev1H = stcSeries1H[stcSeries1H.length - 2];
          const curr1H = stcSeries1H[stcSeries1H.length - 1];

          let cycle = null;
          if (curr1H > prev1H) cycle = "BULL";
          if (curr1H < prev1H) cycle = "BEAR";
          if (!cycle) continue;

          currentCycle[symbol] = cycle;

          await sendMessage(`🔁 1H STC Cycle Locked for *${symbol}*: *${cycle}*`);
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
      const closes5 = closedCandles5.map(c => c.close);

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

        const buyVol = closedCandles5.reduce(
          (sum, c) => sum + (c.close > c.open ? c.volume : 0), 0
        );

        const sellVol = closedCandles5.reduce(
          (sum, c) => sum + (c.close < c.open ? c.volume : 0), 0
        );

        const totalVol = buyVol + sellVol;

        const buyPct = totalVol ? ((buyVol / totalVol) * 100).toFixed(1) : 0;
        const sellPct = totalVol ? ((sellVol / totalVol) * 100).toFixed(1) : 0;

        await sendMessage(
          `📊 Volume Imbalance Report: *${symbol}*\n` +
          `Buy: ${buyVol.toFixed(2)} (${buyPct}%)\n` +
          `Sell: ${sellVol.toFixed(2)} (${sellPct}%)`
        );

        symbolCooldowns[symbol] = now;
      }

    } catch (err) {
      log(`❌ STC scan error ${symbol}: ${err?.message || err}`);
    }
  }

  // =====================================================
  // 4-STATE SUMMARY
  // =====================================================

  const newBullishFlip = bullishFlip.filter(s => !prevBullishFlip.includes(s));
  const newBearishFlip = bearishFlip.filter(s => !prevBearishFlip.includes(s));
  const newBullishCont = bullishContinuation.filter(s => !prevBullishContinuation.includes(s));
  const newBearishCont = bearishContinuation.filter(s => !prevBearishContinuation.includes(s));

  if (newBullishFlip.length || newBearishFlip.length || newBullishCont.length || newBearishCont.length) {

    let summaryMsg = `⚡ *Ready to deploy bot*\n\n`;

    if (newBullishFlip.length)
      summaryMsg += `🟢 Bullish Flip (Low + Contracting):\n${newBullishFlip.join(", ")}\n\n`;

    if (newBearishFlip.length)
      summaryMsg += `🔴 Bearish Flip (High + Contracting):\n${newBearishFlip.join(", ")}\n\n`;

    if (newBullishCont.length)
      summaryMsg += `🟢 Bullish Continuation (High + Expanding):\n${newBullishCont.join(", ")}\n\n`;

    if (newBearishCont.length)
      summaryMsg += `🔴 Bearish Continuation (Low + Expanding):\n${newBearishCont.join(", ")}`;

    await sendMessage(summaryMsg);

    prevBullishFlip = bullishFlip;
    prevBearishFlip = bearishFlip;
    prevBullishContinuation = bullishContinuation;
    prevBearishContinuation = bearishContinuation;
  }

}, SIGNAL_CHECK_INTERVAL_MS);


// --- Telegram commands ---

// Pause bot completely
bot.onText(/\/pause/, async () => {
  BOT_PAUSED = true;
  currentCycle = {};
  MANUAL_CYCLE = null;
  await sendMessage("⏸️ Bot paused. Cycles cleared.");
});

// Resume bot after pause
bot.onText(/\/resume/, async () => {
  BOT_PAUSED = false;
  await sendMessage("▶️ Bot resumed.");
});

// Close all positions for all users
bot.onText(/\/closeall/, async () => {
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
bot.onText(/\/setbull$/, async () => {
  MANUAL_CYCLE = "BULL";
  currentCycle = {};
  await sendMessage("🟢 MANUAL MODE: All symbols set to *BULLISH* cycle");
});

bot.onText(/\/setbear$/, async () => {
  MANUAL_CYCLE = "BEAR";
  currentCycle = {};
  await sendMessage("🔴 MANUAL MODE: All symbols set to *BEARISH* cycle");
});

bot.onText(/\/setauto$/, async () => {
  MANUAL_CYCLE = null;
  currentCycle = {};
  await sendMessage("🤖 AUTO MODE: 1H STC detection re-enabled");
});

// --- Per-symbol BULL/BEAR commands ---
bot.onText(/\/setbull (\w+)/, async (msg, match) => {
  const symbol = match[1].toUpperCase();
  currentCycle[symbol] = "BULL";
  await sendMessage(`🟢 MANUAL MODE: *${symbol}* set to *BULLISH* cycle`);
});

bot.onText(/\/setbear (\w+)/, async (msg, match) => {
  const symbol = match[1].toUpperCase();
  currentCycle[symbol] = "BEAR";
  await sendMessage(`🔴 MANUAL MODE: *${symbol}* set to *BEARISH* cycle`);
});

// --- Per-symbol ACTIVATE/DEACTIVATE commands ---

// Deactivate a symbol (stop scanning/trading)
bot.onText(/\/deactivate (\w+)/, async (msg, match) => {
  const symbol = match[1].toUpperCase();
  if (!(symbol in symbolActive)) {
    await sendMessage(`⚠️ Symbol *${symbol}* not recognized.`);
    return;
  }
  symbolActive[symbol] = false;
  await sendMessage(`🚫 *${symbol}* deactivated. No trades will be placed for this symbol.`);
});

// Activate a symbol (resume scanning/trading)
bot.onText(/\/activate (\w+)/, async (msg, match) => {
  const symbol = match[1].toUpperCase();
  if (!(symbol in symbolActive)) {
    await sendMessage(`⚠️ Symbol *${symbol}* not recognized.`);
    return;
  }
  symbolActive[symbol] = true;
  await sendMessage(`✅ *${symbol}* activated. Trading resumed for this symbol.`);
});

// Deactivate all symbols (stop scanning/trading for all coins)
bot.onText(/\/deactivateall/, async () => {
  COIN_LIST.forEach(symbol => {
    symbolActive[symbol] = false;
  });
  await sendMessage("🚫 All symbols deactivated. No trades will be placed for any symbol.");
});
