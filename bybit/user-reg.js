const fs = require("fs");
const TelegramBot = require("node-telegram-bot-api");

// ===============================
// CONFIG
// ===============================
const bot = new TelegramBot("8331572835:AAHO-f3CW8tVXlzZu3zMzRcsiIOtDh5lYbg", {
  polling: true,
});

const USERS_FILE = "users_bybit.json";
const ADMIN_ID = "7476742687";

// ===============================
// ENSURE JSON FILE EXISTS
// ===============================
if (!fs.existsSync(USERS_FILE)) {
  fs.writeFileSync(USERS_FILE, JSON.stringify({}, null, 2));
}

// ===============================
// LOAD / SAVE FUNCTIONS
// ===============================
function loadUsers() {
  return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// ===============================
// /start COMMAND
// ===============================
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;

  let users = loadUsers();

  // Create the user entry if missing
  if (!users[chatId]) {
    users[chatId] = {
      active: false,
      apiKey: "",
      apiSecret: "",
    };
    saveUsers(users);
  }

  bot.sendMessage(chatId, `👋 Welcome to *DanuvieCrypto Bybit Registration*.\n\nUse the buttons below to continue.`, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔑 Bybit API Keys", callback_data: "api_keys" }],
        [{ text: "💳 Subscription", url: "https://t.me/DanuvieCryptopayments_bot" }],
        [{ text: "🌐 Server IP Setup", callback_data: "server_ip" }],
        [{ text: "⚙️ Trade Settings", callback_data: "trade_settings" }],
      ],
    },
  });
});

// ===============================
// CALLBACK MENU HANDLERS
// ===============================
const awaitingKey = new Set();
const awaitingSecret = new Set();

bot.on("callback_query", (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  let users = loadUsers();

  // Ensure user exists
  if (!users[chatId]) {
    users[chatId] = { active: false, apiKey: "", apiSecret: "" };
    saveUsers(users);
  }

  // --- API KEYS MENU ---
  if (data === "api_keys") {
    bot.sendMessage(chatId, `Please enter your *Bybit API Key* and *API Secret* using the buttons below.`, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "📘 Enter API Key", callback_data: "enter_api_key" }],
          [{ text: "📙 Enter API Secret", callback_data: "enter_api_secret" }],
        ],
      },
    });
  }

  // --- ENTER API KEY ---
  if (data === "enter_api_key") {
    bot.sendMessage(chatId, "Send your *Bybit API Key*:", {
      parse_mode: "Markdown",
    });
    awaitingKey.add(chatId);
  }

  // --- ENTER API SECRET ---
  if (data === "enter_api_secret") {
    bot.sendMessage(chatId, "Send your *Bybit API Secret*:", {
      parse_mode: "Markdown",
    });
    awaitingSecret.add(chatId);
  }

  // --- SERVER IP MENU ---
  if (data === "server_ip") {
    bot.sendMessage(
      chatId,
      `🔧 *Bybit API Settings Required*\n\nGo to your Bybit account → API Management → Edit API settings.\n\nEnable:\n1️⃣ Allow Spot Trading\n2️⃣ Allow Futures Trading\n3️⃣ Allow Contract Trading\n\n🚫 *Do NOT enable withdrawals.*\n\nThen whitelist the following server IP:\n\n📌 *159.69.22.110*\n\nYour trading bot will synchronize automatically.`,
      { parse_mode: "Markdown" }
    );
  }

  // --- TRADE SETTINGS MENU ---
  if (data === "trade_settings") {
    bot.sendMessage(
      chatId,
      `⚙️ *Bybit Trade Settings Required*\n\nUpdate the following:\n\n` +
        `📌 **Position Mode:** One-Way Mode\n` +
        `📌 **Asset Mode:** Single Asset Mode\n` +
        `📌 **Margin Mode:** Isolated\n\n` +
        `Your bot will trade correctly once these are updated.`,
      { parse_mode: "Markdown" }
    );
  }
});

// ===============================
// API KEY & SECRET INPUT LOGIC
// ===============================
bot.on("message", (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text || text.startsWith("/")) return;

  let users = loadUsers();

  // Ensure user object exists
  if (!users[chatId]) {
    users[chatId] = { active: false, apiKey: "", apiSecret: "" };
  }

  // --- API KEY SAVING ---
  if (awaitingKey.has(chatId)) {
    awaitingKey.delete(chatId);

    users[chatId].apiKey = text;
    saveUsers(users);

    bot.sendMessage(chatId, "✅ *Bybit API Key saved.*", { parse_mode: "Markdown" });
    return;
  }

  // --- API SECRET SAVING ---
  if (awaitingSecret.has(chatId)) {
    awaitingSecret.delete(chatId);

    users[chatId].apiSecret = text;
    saveUsers(users);

    bot.sendMessage(chatId, "✅ *Bybit API Secret saved.*", { parse_mode: "Markdown" });
    return;
  }
});

// ===============================
// 🔐 ADMIN ACTIVATION COMMANDS
// /activate 12345678
// /deactivate 12345678
// ===============================
bot.onText(/\/activate (.+)/, (msg, match) => {
  if (String(msg.chat.id) !== ADMIN_ID) return;

  const targetId = match[1];
  let users = loadUsers();

  if (!users[targetId]) return bot.sendMessage(ADMIN_ID, "⚠️ User not found.");

  users[targetId].active = true;
  saveUsers(users);

  bot.sendMessage(targetId, "🟢 *Your Bybit trading account has been activated.*\nAutomated trading has started.", {
    parse_mode: "Markdown",
  });
  bot.sendMessage(ADMIN_ID, "✅ User activated.");
});

bot.onText(/\/deactivate (.+)/, (msg, match) => {
  if (String(msg.chat.id) !== ADMIN_ID) return;

  const targetId = match[1];
  let users = loadUsers();

  if (!users[targetId]) return bot.sendMessage(ADMIN_ID, "⚠️ User not found.");

  users[targetId].active = false;
  saveUsers(users);

  bot.sendMessage(targetId, "🔴 *Your Bybit trading account has been deactivated.*\nAutomated trading paused.", {
    parse_mode: "Markdown",
  });
  bot.sendMessage(ADMIN_ID, "🛑 User deactivated.");
});

// ===============================
console.log("✅ Bybit Registration Bot Running...");
