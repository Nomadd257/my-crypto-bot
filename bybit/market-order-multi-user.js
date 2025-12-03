// =====================================================
// MULTI-USER MARKET ORDER BOT - BYBIT (USDT-PERP) - ADMIN-CONTROLLED SIGNALS (Option A) - FIXED
// - Uses Bybit v5 kline endpoints (no more 404)
// - EMA / Volume / OBV checks now use v5 market kline data
// =====================================================
const config = require("../config");
const { createHmac } = require("crypto");
const { RestClientV5 } = require("bybit-api");
const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const fetch = require("node-fetch");
globalThis.fetch = fetch;

const TELEGRAM_BOT_TOKEN = config.TELEGRAM_BOT_TOKEN_BYBIT_MKT_ORDER_MULTI_USER;
const GROUP_CHAT_ID = "-1003489385113";
const PERSONAL_CHAT_ID = "7476742687"; // optional (you used as admin earlier)
const ADMIN_ID = "7476742687"; // admin Telegram ID
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// --- USERS FILE ---
const USERS_FILE = "./users_bybit.json";

// --- SETTINGS ---
const TRADE_PERCENT = 0.1;
const LEVERAGE = 20;
const TP_PCT = 3.0;
const SL_PCT = 1.5; // note: script uses absolute -SL_PCT when checking
const TRAILING_STOP_PCT = 1.5;
const SIGNAL_CHECK_INTERVAL_MS = 60 * 1000;
const MONITOR_INTERVAL_MS = 5000;
const SIGNAL_EXPIRY_MS = 60 * 60 * 1000; // 1 hour

// --- IN-MEMORY ---
let activePositions = {}; // key = `${userId}:${symbol}`
let pendingSignals = {}; // { symbol: { direction, expiresAt, intervalId } }

// --- LOGGING ---
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// --- SEND TELEGRAM MESSAGE ---
async function sendMessage(msg) {
  try {
    await bot.sendMessage(GROUP_CHAT_ID, msg, { parse_mode: "Markdown" });
  } catch (e) {
    log(`tg group send err: ${e?.message || e}`);
  }
  if (PERSONAL_CHAT_ID) {
    try {
      await bot.sendMessage(PERSONAL_CHAT_ID, msg, { parse_mode: "Markdown" });
    } catch (e) {
      log(`tg personal send err: ${e?.message || e}`);
    }
  }
}

// --- LOAD USERS ---
function loadUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) return [];
    const raw = fs.readFileSync(USERS_FILE, "utf8").trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    // support both array and map formats
    if (Array.isArray(parsed)) {
      return parsed
        .filter((u) => u && u.active && u.apiKey && u.apiSecret)
        .map((u) => ({ id: String(u.id), apiKey: u.apiKey, apiSecret: u.apiSecret }));
    }
    // object map
    const users = [];
    for (const [key, val] of Object.entries(parsed)) {
      if (val && val.active && val.apiKey && val.apiSecret)
        users.push({ id: String(key), apiKey: val.apiKey, apiSecret: val.apiSecret });
    }
    return users;
  } catch (e) {
    log(`loadUsers error: ${e?.message || e}`);
    return [];
  }
}

// --- CREATE BYBIT CLIENT MAP ---
function createBybitClientsMap() {
  const users = loadUsers();
  const map = new Map();
  for (const u of users) {
    try {
      // Do NOT pass recvWindow or unsupported options to BybitRest
      // const client = new BybitRest({ key: u.apiKey, secret: u.apiSecret, testnet: false });
      const client = new RestClientV5({
        key: u.apiKey,
        secret: u.apiSecret,
        testnet: false,
        parseAPIRateLimits: true,
        customSignMessageFn: async (message, secret) => {
          return createHmac("sha256", secret).update(message).digest("hex");
        },
      });
      map.set(String(u.id), client);
    } catch (e) {
      log(`createBybitClientsMap failed for ${u.id}: ${e?.message || e}`);
    }
  }
  return map;
}

// --- FETCH BYBIT KLINES ---
// Try modern linear kline endpoint first (v5/public/linear/kline), fallback to legacy v2 if 404
async function fetchBybitKlines(symbol, interval = "15m", limit = 200) {
  // map interval to numeric if using v5: Bybit v5 uses '1','3','5','15','30','60','240','D' etc
  const intervalMapV5 = {
    "1m": "1",
    "3m": "3",
    "5m": "5",
    "15m": "15",
    "30m": "30",
    "1h": "60",
    "4h": "240",
    "1d": "D",
  };
  const v5Interval = intervalMapV5[interval] || "15";
  const urlV5 = `https://api.bybit.com/public/linear/kline?symbol=${symbol}&interval=${v5Interval}&limit=${limit}`;
  try {
    let res = await fetch(urlV5);
    if (res.ok) {
      const json = await res.json();
      if (json && Array.isArray(json.result?.list)) {
        // v5 linear returns result.list with arrays [open_time,open,high,low,close,volume...]
        return json.result.list.map((c) => ({
          time: Number(c[0]) * 1000,
          open: Number(c[1]),
          high: Number(c[2]),
          low: Number(c[3]),
          close: Number(c[4]),
          volume: Number(c[5]),
        }));
      }
      // some deployments return result as array of objects
      if (json && Array.isArray(json.result)) {
        return json.result.map((c) => ({
          time: (c.open_time ? Number(c.open_time) : Number(c.start_at)) * 1000,
          open: Number(c.open),
          high: Number(c.high),
          low: Number(c.low),
          close: Number(c.close),
          volume: Number(c.volume),
        }));
      }
    } else {
      // if 404 or other, fallthrough to legacy
      log(`fetchBybitKlines v5 returned HTTP ${res.status} for ${symbol} ${interval}`);
    }
  } catch (e) {
    log(`fetchBybitKlines v5 error: ${e?.message || e}`);
  }

  // Legacy v2 endpoint fallback
  const intervalMapV2 = {
    "1m": "1",
    "3m": "3",
    "5m": "5",
    "15m": "15",
    "30m": "30",
    "1h": "60",
    "4h": "240",
    "1d": "D",
  };
  const v2Interval = intervalMapV2[interval] || "15";
  const urlV2 = `https://api.bybit.com/v2/public/kline/list?symbol=${symbol}&interval=${v2Interval}&limit=${limit}`;
  try {
    const res2 = await fetch(urlV2);
    if (!res2.ok) throw new Error(`HTTP ${res2.status}`);
    const json2 = await res2.json();
    if (!json2 || !json2.result) return null;
    return json2.result.map((c) => ({
      time: Number(c.open_time) * 1000,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number(c.volume),
    }));
  } catch (e) {
    log(`fetchBybitKlines v2 error for ${symbol}: ${e?.message || e}`);
    return null;
  }
}

// --- EMA CALCULATION ---
function calculateEMA(values, period) {
  if (!values || values.length < period) return null;
  let sma = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let ema = sma;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) ema = values[i] * k + ema * (1 - k);
  return ema;
}

// --- GET EMA TREND (1H) ---
async function getEMATrend(symbol, period = 10) {
  const klines = await fetchBybitKlines(symbol, "1h", 200);
  if (!klines || !klines.length) return null;
  const closes = klines.map((k) => k.close);
  const ema = calculateEMA(closes, period);
  if (ema === null) return null;
  const last = closes[closes.length - 1];
  if (last > ema) return "bullish";
  if (last < ema) return "bearish";
  return "neutral";
}

// --- VOLUME CHECK (15m) ---
async function checkVolume15m(symbol) {
  const candles = await fetchBybitKlines(symbol, "15m", 50);
  if (!candles || candles.length < 22) return false;
  const last = candles[candles.length - 2];
  const prev20 = candles.slice(candles.length - 22, candles.length - 2);
  const avg = prev20.reduce((s, c) => s + c.volume, 0) / prev20.length;
  return last.volume >= avg;
}

// --- OBV CHECK (15m) ---
async function checkOBV15m(symbol, direction) {
  const candles = await fetchBybitKlines(symbol, "15m", 60);
  if (!candles || candles.length < 4) return false;
  const closed = candles.slice(0, -1);
  let obv = 0;
  const series = [0];
  for (let i = 1; i < closed.length; i++) {
    const diff = closed[i].close - closed[i - 1].close;
    obv += diff > 0 ? closed[i].volume : diff < 0 ? -closed[i].volume : 0;
    series.push(obv);
  }
  const last = series[series.length - 1];
  const prev = series[series.length - 2];
  return direction === "long" ? last > prev : last < prev;
}

// --- CHECK DERIVATIVES (USDⓈ-M) WALLET BALANCE FOR USER ---
// Returns float available balance, or 0 if none or unknown
async function getDerivativesUSDTBalance(client) {
  try {
    // BybitRest client.getWalletBalance often returns object with .result.USDT.available_balance
    const bal = (await client.getWalletBalance?.({ coin: "USDT" })) || (await client.getWalletBalance?.());
    if (!bal) return 0;
    // Try common shapes
    if (
      bal.result &&
      bal.result.USDT &&
      (bal.result.USDT.available_balance || bal.result.USDT.available_balance === 0)
    ) {
      return parseFloat(bal.result.USDT.available_balance || 0);
    }
    // some libs return .result with array or map
    if (bal.USDT && (bal.USDT.available_balance || bal.USDT.available_balance === 0)) {
      return parseFloat(bal.USDT.available_balance || 0);
    }
    // fallback: look for nested values
    if (bal.result && typeof bal.result === "object") {
      for (const v of Object.values(bal.result)) {
        if (v && v.available_balance && v.coin === "USDT") return parseFloat(v.available_balance || 0);
      }
    }
    // If returned as array
    if (Array.isArray(bal)) {
      const f = bal.find((x) => x.coin === "USDT");
      if (f && (f.available_balance || f.available_balance === 0)) return parseFloat(f.available_balance || 0);
    }
    return 0;
  } catch (e) {
    log(`getDerivativesUSDTBalance error: ${e?.message || e}`);
    return 0;
  }
}

// --- EXECUTE MARKET ORDER FOR ALL USERS (Derivatives wallet only) ---
async function executeMarketOrderForAllUsers(symbol, direction) {
  const clientsMap = createBybitClientsMap();
  if (!clientsMap.size) {
    await sendMessage(`⚠️ No active users for ${symbol}`);
    return;
  }

  for (const [userId, client] of clientsMap.entries()) {
    try {
      // 1) Ensure leverage set (best-effort)
      try {
        await client.setLeverage?.({ symbol, buy_leverage: LEVERAGE, sell_leverage: LEVERAGE });
      } catch (e) {
        /* non-fatal */
      }

      // 2) Check derivatives USDT wallet (Option A requirement)
      const derivBal = await getDerivativesUSDTBalance(client);
      if (!derivBal || derivBal <= 0) {
        // message to admin and user (optionally to group) instructing transfer
        await sendMessage(
          `⚠️ Skipping user ${userId}: no USDT in Derivatives wallet (USDⓈ-M). Please transfer funds to Derivatives wallet (Assets → Transfer → select USDT → To: Derivatives (USDⓈ-M)).`
        );
        continue;
      }

      // 3) Get mark price (try client, fallback to public kline)
      let markPrice = null;
      try {
        const mp = await client.getMarkPrice?.({ symbol });
        if (mp && mp.result && Array.isArray(mp.result) && mp.result[0] && mp.result[0].mark_price)
          markPrice = parseFloat(mp.result[0].mark_price);
        else if (mp && mp.mark_price) markPrice = parseFloat(mp.mark_price);
      } catch (e) {
        /* ignore */
      }
      if (!markPrice) {
        const k = await fetchBybitKlines(symbol, "1m", 1);
        if (k && k.length) markPrice = k[k.length - 1].close;
      }
      if (!markPrice) {
        await sendMessage(`⚠️ Could not determine market price for ${symbol} for user ${userId}. Skipping.`);
        continue;
      }

      // 4) Calculate quantity (use derivative available balance)
      const tradeValue = derivBal * TRADE_PERCENT;
      const rawQty = (tradeValue * LEVERAGE) / markPrice;
      const qty = Number(rawQty.toFixed(3));
      if (!qty || qty <= 0) {
        await sendMessage(`⚠️ Computed qty <= 0 for user ${userId} on ${symbol}. Skipping.`);
        continue;
      }

      // 5) Place market order (best-effort across different SDK shapes)
      const side = direction === "BULLISH" ? "Buy" : "Sell";
      let placed = false;
      try {
        await client.placeActiveOrder?.({
          symbol,
          side: side.toUpperCase(),
          order_type: "Market",
          qty,
          time_in_force: "ImmediateOrCancel",
          reduce_only: false,
        });
        placed = true;
      } catch (e) {
        /* ignore & try fallbacks */
      }

      if (!placed) {
        try {
          await client.submitOrder?.({ symbol, side: side.toUpperCase(), order_type: "Market", qty });
          placed = true;
        } catch (e) {
          /* ignore */
        }
      }
      if (!placed) {
        try {
          await client.order?.create?.({
            symbol,
            side: side.toUpperCase(),
            orderType: "Market",
            qty,
            timeInForce: "ImmediateOrCancel",
          });
          placed = true;
        } catch (e) {
          /* ignore */
        }
      }

      if (!placed) {
        await sendMessage(`❌ Unable to place order for user ${userId} on ${symbol}.`);
        continue;
      }

      await sendMessage(`✅ *${side.toUpperCase()} EXECUTED* on *${symbol}* for user ${userId} (qty ${qty})`);
      activePositions[`${userId}:${symbol}`] = {
        userId,
        symbol,
        side: side === "Buy" ? "BUY" : "SELL",
        entryPrice: markPrice,
        qty,
        openedAt: Date.now(),
        trailingStop: null,
        highest: markPrice,
        lowest: markPrice,
      };
    } catch (err) {
      log(`executeMarketOrderForAllUsers error for user ${userId}: ${err?.message || err}`);
      await sendMessage(`❌ Error executing order for user ${userId} on ${symbol}: ${err?.message || err}`);
    }
  }
}

// --- CLOSE USER POSITION HELPER ---
async function closeUserPositionByMarket(client, userId, symbol, qty, side) {
  let closed = false;
  try {
    await client.placeActiveOrder?.({
      symbol,
      side: side.toUpperCase(),
      order_type: "Market",
      qty,
      time_in_force: "ImmediateOrCancel",
      reduce_only: true,
    });
    closed = true;
  } catch (e) {
    /* fallback */
  }
  if (!closed) {
    try {
      await client.submitOrder?.({ symbol, side: side.toUpperCase(), order_type: "Market", qty, reduce_only: true });
      closed = true;
    } catch (e) {}
  }
  if (!closed) {
    try {
      await client.order?.create?.({
        symbol,
        side: side.toUpperCase(),
        orderType: "Market",
        qty,
        timeInForce: "ImmediateOrCancel",
        reduceOnly: true,
      });
      closed = true;
    } catch (e) {}
  }
  if (closed) await sendMessage(`🔒 Position closed for user ${userId} on *${symbol}* (${side} ${qty})`);
  else await sendMessage(`⚠️ Failed to auto-close position for user ${userId} on *${symbol}*`);
}

// --- MONITOR POSITIONS ---
async function monitorPositions() {
  const clientsMap = createBybitClientsMap();
  for (const k of Object.keys(activePositions)) {
    const pos = activePositions[k];
    const client = clientsMap.get(String(pos.userId));
    if (!client) continue;

    // get mark price
    let markPrice = null;
    try {
      const mp = await client.getMarkPrice?.({ symbol: pos.symbol });
      markPrice = parseFloat(mp?.result?.[0]?.mark_price);
    } catch (e) {
      /* ignore */
    }
    if (!markPrice) {
      const kline = await fetchBybitKlines(pos.symbol, "1m", 1);
      if (kline && kline.length) markPrice = kline[0].close;
    }
    if (!markPrice) continue;

    // trailing stop
    if (pos.side === "BUY") {
      pos.highest = Math.max(pos.highest, markPrice);
      const trail = pos.highest * (1 - TRAILING_STOP_PCT / 100);
      if (!pos.trailingStop || trail > pos.trailingStop) pos.trailingStop = trail;
      if (markPrice <= pos.trailingStop) {
        await closeUserPositionByMarket(client, pos.userId, pos.symbol, pos.qty, "Sell");
        delete activePositions[k];
        continue;
      }
    } else {
      pos.lowest = Math.min(pos.lowest, markPrice);
      const trail = pos.lowest * (1 + TRAILING_STOP_PCT / 100);
      if (!pos.trailingStop || trail < pos.trailingStop) pos.trailingStop = trail;
      if (markPrice >= pos.trailingStop) {
        await closeUserPositionByMarket(client, pos.userId, pos.symbol, pos.qty, "Buy");
        delete activePositions[k];
        continue;
      }
    }

    const move =
      pos.side === "BUY"
        ? ((markPrice - pos.entryPrice) / pos.entryPrice) * 100
        : ((pos.entryPrice - markPrice) / pos.entryPrice) * 100;

    if (move >= TP_PCT) {
      await closeUserPositionByMarket(client, pos.userId, pos.symbol, pos.qty, pos.side === "BUY" ? "Sell" : "Buy");
      delete activePositions[k];
      continue;
    }
    if (move <= -SL_PCT) {
      await closeUserPositionByMarket(client, pos.userId, pos.symbol, pos.qty, pos.side === "BUY" ? "Sell" : "Buy");
      delete activePositions[k];
      continue;
    }
  }
}
setInterval(monitorPositions, MONITOR_INTERVAL_MS);

// --- SIGNAL PARSING HELPERS ---
// Accept both:
// - "CONFIRMED CHANGE IN DIRECTION ON ADAUSDT ... NOW BULLISH"
// - "🔁 Confirmed Change in Direction on ADAUSDT (30m): Now BULLISH 🟢"
function parseSignalText(text) {
  // normalize
  const t = text.toUpperCase();

  // look for "CONFIRMED CHANGE IN DIRECTION" presence OR the emoji form (we accept either)
  if (!t.includes("CONFIRMED CHANGE IN DIRECTION") && !t.includes("CONFIRMED CHANGE IN DIRECTION")) {
    return null;
  }

  // Try flexible regex: between "ON" and "NOW"
  const rx = /ON\s+([A-Z0-9]+USDT)[^A-Z0-9]{0,20}.*NOW[:\s]+(BULLISH|BEARISH)/i;
  const m = text.match(rx);
  if (m && m[1] && m[2]) {
    return { symbol: m[1].toUpperCase(), direction: m[2].toUpperCase() };
  }

  // fallback: try other pattern with "Now BULLISH" after colon
  const rx2 = /([A-Z0-9]+USDT)[\s\S]{0,40}NOW[:\s]+(BULLISH|BEARISH)/i;
  const m2 = text.match(rx2);
  if (m2 && m2[1] && m2[2]) {
    return { symbol: m2[1].toUpperCase(), direction: m2[2].toUpperCase() };
  }

  // Last resort: find first token ending with USDT and then "BULLISH"/"BEARISH" anywhere
  const sym = text.match(/([A-Z0-9]+USDT)/i);
  const dir = text.match(/\b(BULLISH|BEARISH)\b/i);
  if (sym && dir) {
    return { symbol: sym[1].toUpperCase(), direction: dir[1].toUpperCase() };
  }

  return null;
}

// --- TELEGRAM LISTENER (SINGLE) ---
bot.on("message", async (msg) => {
  try {
    if (!msg.text) return;
    const chatId = msg.chat.id.toString();
    const userIdTelegram = msg.from?.id?.toString();
    // accept messages from group or personal/admin chat
    if (chatId !== GROUP_CHAT_ID && chatId !== PERSONAL_CHAT_ID) return;

    const text = msg.text.trim();

    // --- MANUAL CLOSE ALL ---
    if (text.toLowerCase().startsWith("/closeall")) {
      if (userIdTelegram !== ADMIN_ID) return;
      const parts = text.split(" ");
      const symbolArg = parts[1] ? parts[1].toUpperCase() : "ALL";
      const clientsMap = createBybitClientsMap();
      const keys = Object.keys(activePositions);
      if (!keys.length) {
        await sendMessage("⚠️ No active positions to close.");
        return;
      }
      await sendMessage(`⚠️ Closing positions for all users (${symbolArg})...`);
      for (const k of keys) {
        const pos = activePositions[k];
        if (symbolArg !== "ALL" && pos.symbol !== symbolArg) continue;
        const client = clientsMap.get(String(pos.userId));
        if (!client) continue;
        const sideToClose = pos.side === "BUY" ? "Sell" : "Buy";
        await closeUserPositionByMarket(client, pos.userId, pos.symbol, pos.qty, sideToClose);
        delete activePositions[k];
      }
      await sendMessage("✅ Manual close-all completed.");
      return;
    }

    // --- CID SIGNALS ---
    // Use parseSignalText to accept new format
    const parsed = parseSignalText(text);
    if (!parsed) return;

    const symbol = parsed.symbol;
    const direction = parsed.direction; // BULLISH | BEARISH

    if (pendingSignals[symbol]) return;

    pendingSignals[symbol] = { direction, expiresAt: Date.now() + SIGNAL_EXPIRY_MS };
    await sendMessage(
      `📢 CID signal received for *${symbol}* (${direction}) — *expires in 1 hr* — checking EMA/Volume/OBV...`
    );

    const intervalId = setInterval(async () => {
      const sig = pendingSignals[symbol];
      if (!sig) {
        clearInterval(intervalId);
        return;
      }
      if (Date.now() > sig.expiresAt) {
        clearInterval(intervalId);
        delete pendingSignals[symbol];
        await sendMessage(`⌛ CID signal expired for *${symbol}*`);
        return;
      }

      const trend = await getEMATrend(symbol, 10);
      const emaOk =
        direction === "BULLISH" ? trend === "bullish" : trend === "BEARISH" ? trend === "bearish" : trend === "bearish";
      const volOk = await checkVolume15m(symbol);
      const obvOk = await checkOBV15m(symbol, direction === "BULLISH" ? "long" : "short");

      if (!emaOk) await sendMessage(`⏳ EMA (1H) check not passed yet for *${symbol}* (trend: ${trend})`);
      if (!volOk) await sendMessage(`⏳ Volume (15m) check not passed yet for *${symbol}*`);
      if (!obvOk) await sendMessage(`⏳ OBV (15m) check not passed yet for *${symbol}*`);

      if (emaOk && volOk && obvOk) {
        clearInterval(intervalId);
        delete pendingSignals[symbol];
        await sendMessage(`✅ All checks passed for *${symbol}*. Executing orders...`);
        await executeMarketOrderForAllUsers(symbol, direction);
      }
    }, SIGNAL_CHECK_INTERVAL_MS);

    pendingSignals[symbol].intervalId = intervalId;
  } catch (err) {
    log(`bot.on message error: ${err?.message || err}`);
  }
});

// --- STARTUP LOG ---
log("Bybit multi-user market bot (Derivatives-only) started.");
