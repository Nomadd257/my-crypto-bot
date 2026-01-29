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

// --- TELEGRAM ---
const TELEGRAM_BOT_TOKEN = "8247817335:AAEKf92ex9eiDZKoan1O8uzZ3ls5uEjJsQw";
const GROUP_CHAT_ID = "-1003419090746";
const ADMIN_ID = "7476742687";
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// --- USERS FILE ---
const USERS_FILE = "./users.json";

// --- Settings ---
const TRADE_PERCENT = 0.10;
const LEVERAGE = 20;
const TP_PCT = 1.8;
const SL_PCT = 1.5;
const TRAILING_STOP_PCT = 1.5;
const SIGNAL_CHECK_INTERVAL_MS = 60 * 1000;
const SIGNAL_EXPIRY_MS = 60 * 60 * 1000;

// --- In-memory ---
let activePositions = {}; // { symbol: { userId: { side, entryPrice, qty, highest, lowest, trailingStop, openedAt } } }
let pendingSignals = {};  // { symbol: { direction, expiresAt } }
let userClients = {};     // { userId: client }

// --- Logging ---
function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

// --- Load users ---
function loadUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) return [];
    const raw = fs.readFileSync(USERS_FILE, "utf8").trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter(u => u && u.active && u.apiKey && u.apiSecret)
                   .map(u => ({ id: String(u.id), apiKey: u.apiKey, apiSecret: u.apiSecret }));
    }
    const users = [];
    for (const [key, val] of Object.entries(parsed)) {
      if (val && val.active && val.apiKey && val.apiSecret) users.push({ id: String(key), apiKey: val.apiKey, apiSecret: val.apiSecret });
    }
    return users;
  } catch (err) { log(`❌ loadUsers error: ${err?.message || err}`); return []; }
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
async function sendMessage(msg) {
  try { await bot.sendMessage(GROUP_CHAT_ID, msg, { parse_mode: "Markdown" }); } catch {}
  try { await bot.sendMessage(ADMIN_ID, msg, { parse_mode: "Markdown" }); } catch {}
}

// --- Fetch Futures Klines ---
async function fetchFuturesKlines(symbol, interval="15m", limit=50) {
  try {
    const res = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.map(c => ({ time:c[0], open:+c[1], high:+c[2], low:+c[3], close:+c[4], volume:+c[5] }));
  } catch(err) { log(`❌ fetchFuturesKlines error for ${symbol}: ${err?.message||err}`); return null; }
}

// --- EMA3 (15m) ---
function calculateEMA(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  let ema = values.slice(0, period).reduce((a,b)=>a+b,0)/period;
  const k = 2/(period+1);
  for(let i=period;i<values.length;i++){ ema = values[i]*k + ema*(1-k); }
  return ema;
}

// --- EMA3 trend ---
async function getEMA3(symbol){
  const candles = await fetchFuturesKlines(symbol,"15m",5);
  if(!candles || candles.length<3) return null;
  const closes = candles.map(c=>c.close);
  const ema3 = calculateEMA(closes,3);
  const lastClose = closes[closes.length-1];
  return { lastClose, ema3 };
}

// --- Volume Imbalance ---
async function checkVolumeImbalance(symbol){
  const candles = await fetchFuturesKlines(symbol,"15m",2); // last candle
  if(!candles || candles.length<2) return null;
  const c = candles[candles.length-1];
  const body = Math.abs(c.close - c.open);

  // Allocate volume based on candle direction and body size
  const buyVol = c.close > c.open ? c.volume : (body / (c.high - c.low || 1)) * c.volume;
  const sellVol = c.close < c.open ? c.volume : (body / (c.high - c.low || 1)) * c.volume;

  const totalVol = buyVol + sellVol;
  const buyPct = totalVol > 0 ? (buyVol / totalVol * 100).toFixed(1) : 0;
  const sellPct = totalVol > 0 ? (sellVol / totalVol * 100).toFixed(1) : 0;

  return { buyVol: buyVol.toFixed(2), sellVol: sellVol.toFixed(2), buyPct, sellPct };
}

// --- Floor quantity ---
function floorToStep(qty,step){
  const s=Number(step); if(!s||s<=0) return qty;
  const factor=Math.round(1/s); return Number((Math.floor(qty*factor)/factor).toFixed((s.toString().split(".")[1]||"").length));
}

// --- Execute Market Orders ---
async function executeMarketOrderForAllUsers(symbol, direction){
  const clients = createBinanceClients();
  if(!clients.length){ await sendMessage(`⚠️ No active users.`); return; }

  // EMA3 filter
  const emaData = await getEMA3(symbol);
  if(!emaData){ await sendMessage(`⚠️ EMA3 unavailable for ${symbol}`); return; }
  if(direction==="BULLISH" && emaData.lastClose<emaData.ema3){ await sendMessage(`⏳ Close below EMA3 for ${symbol}. Skipping.`); return; }
  if(direction==="BEARISH" && emaData.lastClose>emaData.ema3){ await sendMessage(`⏳ Close above EMA3 for ${symbol}. Skipping.`); return; }

  for(const {userId, client} of clients){
    try{
      await client.futuresLeverage(symbol, LEVERAGE).catch(()=>{});

      const balances = await client.futuresBalance();
      const usdtBal = balances.find(b=>b.asset==="USDT");
      const bal = usdtBal ? parseFloat(usdtBal.balance) : 0;
      if(!bal || bal<=0){ await sendMessage(`⚠️ User ${userId} has NO USDT. Skipping.`); continue; }

      let markPrice=0;
      try{ const mp = await client.futuresMarkPrice(symbol); markPrice=parseFloat(mp.markPrice||mp[0]?.markPrice||0); } catch{}
      if(!markPrice || markPrice<=0){
        const k = await fetchFuturesKlines(symbol,"1m",1); markPrice=k&&k.length?k[0].close:0;
      }
      if(!markPrice || markPrice<=0){ log(`⚠️ markPrice invalid for ${symbol}, user ${userId}`); continue; }

      const tradeValue = bal*TRADE_PERCENT;
      const rawQty = (tradeValue*LEVERAGE)/markPrice;
      let lotStep=0.001;
      try{ 
        const info=await client.futuresExchangeInfo(); 
        const s=info.symbols.find(s=>s.symbol===symbol); 
        if(s) lotStep=parseFloat(s.filters.find(f=>f.filterType==="LOT_SIZE")?.stepSize||lotStep); 
      } catch{}
      const qty=floorToStep(rawQty,lotStep);
      if(!qty || qty<=0) continue;

      const side = direction==="BULLISH"?"BUY":"SELL";

      // --- Volume Imbalance scan immediately before trade ---
      const imbalance = await checkVolumeImbalance(symbol);

      if(side==="BUY") await client.futuresMarketBuy(symbol, qty);
      else await client.futuresMarketSell(symbol, qty);

      await sendMessage(`✅ *${side} EXECUTED* on *${symbol}* for User ${userId} (qty ${qty})`);

      // --- Volume Imbalance report ---
      if(imbalance) await sendMessage(`📊 Volume Imbalance for *${symbol}*:\nBuy Vol: ${imbalance.buyVol} (${imbalance.buyPct}%)\nSell Vol: ${imbalance.sellVol} (${imbalance.sellPct}%)`);

      if(!activePositions[symbol]) activePositions[symbol]={};
      activePositions[symbol][userId] = {
  side,
  qty,
  entryPrice: markPrice,
  highest: markPrice,
  lowest: markPrice,
  trailingStop: null,
  momentumChecked: false,
  entryTime: Date.now()
};

    }catch(err){ log(`❌ executeMarketOrder user ${userId} ${symbol}: ${err?.message||err}`); }
  }
}

// --- Monitor Positions & Trailing Stops ---
async function monitorPositions(){
  const clients = createBinanceClients();
  for(const symbol of Object.keys(activePositions)){
    for(const userId of Object.keys(activePositions[symbol])){
      const pos = activePositions[symbol][userId];
      const client = userClients[userId];
      if(!client){ delete activePositions[symbol][userId]; continue; }

      try{
        const positions = await client.futuresPositionRisk();
        const p = Array.isArray(positions)?positions.find(x=>x.symbol===symbol):null;
        const amt = p?parseFloat(p.positionAmt||0):0;
        if(!p || amt===0){ delete activePositions[symbol][userId]; continue; }

        let markPrice=0;
        try{ 
          const mp = await client.futuresMarkPrice(symbol); 
          markPrice = parseFloat(mp.markPrice || mp[0]?.markPrice || 0); 
        } catch{}
        if(!markPrice || markPrice<=0){ 
          const k = await fetchFuturesKlines(symbol,"1m",1); 
          markPrice = k && k.length ? k[0].close : 0; 
        }
        if(!markPrice || markPrice<=0) continue;

// ================================
// MOMENTUM VALIDATION (0.5% in 30 mins)
// ================================
if (!pos.momentumChecked) {
  const elapsed = Date.now() - pos.entryTime;
  const momentumWindow = 30 * 60 * 1000; // 30 mins
  const momentumPct = 0.5 / 100;

  let momentumHit = false;

  if (pos.side === "BUY") {
    if (markPrice >= pos.entryPrice * (1 + momentumPct)) {
      momentumHit = true;
    }
  } else {
    if (markPrice <= pos.entryPrice * (1 - momentumPct)) {
      momentumHit = true;
    }
  }

  // ✅ Momentum achieved → allow trade to continue
  if (momentumHit) {
    pos.momentumChecked = true;
  }

  // ❌ Momentum FAILED after 30 mins → close trade
  if (!momentumHit && elapsed >= momentumWindow) {
    const closeSide = pos.side === "BUY" ? "SELL" : "BUY";

    if (closeSide === "SELL") {
      await client.futuresMarketSell(symbol, pos.qty);
    } else {
      await client.futuresMarketBuy(symbol, pos.qty);
    }

    await sendMessage(
      `⏱️ *Momentum Fail Close*\n` +
      `Symbol: ${symbol}\n` +
      `Side: ${pos.side}\n` +
      `Required: 0.5%\n` +
      `Time: 30 mins\n` +
      `Result: ❌ Not achieved`
    );

    delete activePositions[symbol][userId];
    continue;
  }
}

        // --- Trailing Stop ---
        if(pos.side === "BUY"){
          pos.highest = Math.max(pos.highest, markPrice);
          const trail = pos.highest * (1 - TRAILING_STOP_PCT / 100);
          if(!pos.trailingStop || trail > pos.trailingStop) pos.trailingStop = trail;
          if(markPrice <= pos.trailingStop){
            await client.futuresMarketSell(symbol, Math.abs(amt));
            await sendMessage(`🔒 Trailing Stop Hit: *${symbol}* (User ${userId})`);
            delete activePositions[symbol][userId];
            continue;
          }
        } else {
          pos.lowest = Math.min(pos.lowest, markPrice);
          const trail = pos.lowest * (1 + TRAILING_STOP_PCT / 100);
          if(!pos.trailingStop || trail < pos.trailingStop) pos.trailingStop = trail;
          if(markPrice >= pos.trailingStop){
            await client.futuresMarketBuy(symbol, Math.abs(amt));
            await sendMessage(`🔒 Trailing Stop Hit: *${symbol}* (User ${userId})`);
            delete activePositions[symbol][userId];
            continue;
          }
        }

        // --- Take Profit / Stop Loss ---
        const move = pos.side === "BUY" ? ((markPrice - pos.entryPrice) / pos.entryPrice) * 100
                                        : ((pos.entryPrice - markPrice) / pos.entryPrice) * 100;

        if(move >= TP_PCT){
          if(pos.side === "BUY") await client.futuresMarketSell(symbol, Math.abs(amt));
          else await client.futuresMarketBuy(symbol, Math.abs(amt));
          await sendMessage(`🎯 TAKE PROFIT Hit for User ${userId} on *${symbol}* (+${move.toFixed(2)}%)`);
          delete activePositions[symbol][userId];
          continue;
        }

        if(move <= SL_PCT){
          if(pos.side === "BUY") await client.futuresMarketSell(symbol, Math.abs(amt));
          else await client.futuresMarketBuy(symbol, Math.abs(amt));
          await sendMessage(`🔻 STOP LOSS Hit for User ${userId} on *${symbol}* (${move.toFixed(2)}%)`);
          delete activePositions[symbol][userId];
          continue;
        }

      }catch(err){ 
        log(`monitorPositions error for ${userId} ${symbol}: ${err?.message||err}`); 
      }
    }
  }
}
setInterval(monitorPositions, 5000);

// --- TELEGRAM HANDLER (CID + /close / /closeall) ---
bot.on("message", async msg => {
  try{
    if(!msg.text) return;
    const chatId = msg.chat.id;
    const text = msg.text.trim();
    log(`Received message from ${msg.from.username||msg.from.id}: ${text}`);

    // --- /closeall ---
    if(String(msg.from.id)===String(ADMIN_ID) && text.toLowerCase()==="/closeall"){
      bot.sendMessage(chatId, `📢 *Manual Close-All Triggered*`, { parse_mode:"Markdown" });
      const clients = createBinanceClients();
      for(const sym of Object.keys(activePositions)){
        for(const userId of Object.keys(activePositions[sym])){
          const pos = activePositions[sym][userId];
          const client = userClients[userId];
          if(!client) continue;
          const closeSide = pos.side==="BUY"?"SELL":"BUY";
          try{
            if(closeSide==="BUY") await client.futuresMarketBuy(sym,pos.qty);
            else await client.futuresMarketSell(sym,pos.qty);
            delete activePositions[sym][userId];
            await sendMessage(`🔴 *MANUAL CLOSE:* User ${userId}\nSymbol: ${sym}\nQty: ${pos.qty}\nAction: ${closeSide}`);
          }catch(err){ await sendMessage(`❌ Failed to close User ${userId} on ${sym}: ${err?.message||err}`); }
        }
      }
      return bot.sendMessage(chatId,"✅ Manual Close-All Completed.",{ parse_mode:"Markdown" });
    }

    // --- /close SYMBOL ---
    if(String(msg.from.id)===String(ADMIN_ID) && text.toLowerCase().startsWith("/close ")){
      const parts = text.split(" ");
      const symbolArg = parts[1]?parts[1].toUpperCase():null;
      if(!symbolArg) return bot.sendMessage(chatId,"❌ Usage:\n/close BTCUSDT",{parse_mode:"Markdown"});
      bot.sendMessage(chatId, `📢 *Manual Close Triggered:* ${symbolArg}`, { parse_mode:"Markdown" });
      const clients = createBinanceClients();
      if(!activePositions[symbolArg]) return bot.sendMessage(chatId, `⚠️ No active position found for *${symbolArg}*`, { parse_mode:"Markdown" });
      for(const userId of Object.keys(activePositions[symbolArg])){
        const pos = activePositions[symbolArg][userId];
        const client = userClients[userId];
        if(!client) continue;
        const closeSide = pos.side==="BUY"?"SELL":"BUY";
        try{
          if(closeSide==="BUY") await client.futuresMarketBuy(symbolArg,pos.qty);
          else await client.futuresMarketSell(symbolArg,pos.qty);
          delete activePositions[symbolArg][userId];
          await sendMessage(`🔴 *MANUAL CLOSE:* User ${userId}\nSymbol: ${symbolArg}\nQty: ${pos.qty}\nAction: ${closeSide}`);
        }catch(err){ await sendMessage(`❌ Failed to close User ${userId} on ${symbolArg}: ${err?.message||err}`); }
      }
      return bot.sendMessage(chatId, `✅ *${symbolArg}* fully closed for all users`, { parse_mode:"Markdown" });
    }

    // --- CID SIGNALS ---
    if(!text.toUpperCase().includes("CONFIRMED CHANGE IN DIRECTION")) return;

    const match = text.match(/ON\s+([A-Z]+USDT).*NOW\s+(BULLISH|BEARISH)/i);
    if(!match) return;
    const symbol = match[1].toUpperCase();
    const direction = match[2].toUpperCase();
    if(pendingSignals[symbol]) return;

    pendingSignals[symbol]={ direction, expiresAt: Date.now()+SIGNAL_EXPIRY_MS };
    await sendMessage(`📢 CID Signal for *${symbol}* (${direction})\n⏱ Expires in ${Math.round(SIGNAL_EXPIRY_MS/60000)} minutes\nChecking EMA3 + Imbalance...`);

    const timer = setInterval(async ()=>{
      const sig = pendingSignals[symbol];
      if(!sig){ clearInterval(timer); return; }
      if(Date.now()>sig.expiresAt){ clearInterval(timer); delete pendingSignals[symbol]; await sendMessage(`⌛ CID signal expired for *${symbol}*`); return; }

      // EMA3 check for last closed candle
      const emaData = await getEMA3(symbol);
      if(!emaData){ await sendMessage(`⚠️ EMA3 unavailable for ${symbol}`); return; }
      const emaCheck = (direction==="BULLISH" && emaData.lastClose>emaData.ema3) || (direction==="BEARISH" && emaData.lastClose<emaData.ema3);
      if(!emaCheck){ await sendMessage(`⏳ Last candle close not valid for EMA3 on ${symbol}`); return; }

      clearInterval(timer);
      delete pendingSignals[symbol];
      await sendMessage(`✅ EMA3 validated for *${symbol}* — Executing Market Orders...`);
      await executeMarketOrderForAllUsers(symbol,direction);

}, SIGNAL_CHECK_INTERVAL_MS);

  } catch (err) {
    log(`❌ bot.on message error: ${err?.message || err}`);
  }
});
