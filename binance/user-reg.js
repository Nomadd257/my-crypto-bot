// =====================================================
// DanuvieCrypto Registration Bot (Updated, Hardcoded Token + AutoTrading Group Button)
// =====================================================

// --- Dependencies ---
// import TelegramBot from "node-telegram-bot-api";
// import fs from "fs";
const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");

// ===============================
// CONFIG
// ===============================
const bot = new TelegramBot("8517187439:AAH6ysDoUixQlTZ421Snt2p7g1HFohjIVu8", {
  polling: true,
});

const ADMIN_ID = "7476742687";
const USERS_FILE = "users.json";

// ===============================
// LOAD / SAVE USERS (ARRAY FORMAT)
// ===============================
function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, JSON.stringify([], null, 2));
  }
  return JSON.parse(fs.readFileSync(USERS_FILE));
}

function saveUsers(data) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));
}

function findUser(users, id) {
  return users.find((u) => u.id === String(id));
}

// ===============================
// START COMMAND
// ===============================
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  let users = loadUsers();

  // Ensure user exists with default structure
  let user = findUser(users, chatId);
  if (!user) {
    users.push({
      id: String(chatId),
      apiKey: "",
      apiSecret: "",
      active: false,
    });
    saveUsers(users);
  }

  bot.sendMessage(
    chatId,
    `👋 *Welcome to DanuvieCrypto Registration*

Navigate using the buttons below.`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔑 Binance API Keys", callback_data: "api_menu" }],
          [{ text: "💳 Subscription", url: "https://t.me/DanuvieCryptopayments_bot" }],
          [{ text: "🖥 Server IP", callback_data: "server_ip" }],
          [{ text: "⚙ Trade Settings", callback_data: "trade_settings" }],
        ],
      },
    }
  );
});

// ===============================
// HANDLE MENU OPTIONS
// ===============================
bot.on("callback_query", (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  let users = loadUsers();

  // Ensure user exists
  let user = findUser(users, chatId);
  if (!user) {
    user = {
      id: String(chatId),
      apiKey: "",
      apiSecret: "",
      active: false,
    };
    users.push(user);
    saveUsers(users);
  }

  // --- API MENU ---
  if (data === "api_menu") {
    bot.sendMessage(chatId, `Enter your Binance API Key and Secret using the buttons below:`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔐 Enter API Key", callback_data: "enter_api_key" }],
          [{ text: "🔏 Enter API Secret", callback_data: "enter_api_secret" }],
        ],
      },
    });
  }

  // --- API KEY ---
  if (data === "enter_api_key") {
    bot.sendMessage(chatId, "Please send your *Binance API Key* now.", {
      parse_mode: "Markdown",
    });

    bot.once("message", (msg) => {
      const uid = msg.chat.id;

      let users = loadUsers();
      let usr = findUser(users, uid);
      if (!usr) {
        usr = { id: String(uid), active: false };
        users.push(usr);
      }

      usr.apiKey = msg.text;
      saveUsers(users);

      bot.sendMessage(uid, "✅ API Key saved successfully.");
    });
  }

  // --- API SECRET ---
  if (data === "enter_api_secret") {
    bot.sendMessage(chatId, "Please send your *Binance API Secret* now.", {
      parse_mode: "Markdown",
    });

    bot.once("message", (msg) => {
      const uid = msg.chat.id;

      let users = loadUsers();
      let usr = findUser(users, uid);
      if (!usr) {
        usr = { id: String(uid), active: false };
        users.push(usr);
      }

      usr.apiSecret = msg.text;
      saveUsers(users);

      bot.sendMessage(uid, "✅ API Secret saved successfully.");
    });
  }

  // --- SERVER IP INSTRUCTIONS ---
  if (data === "server_ip") {
    const instructions = `
🖥 **Server IP Whitelisting Instructions**

To allow the bot to trade securely on your Binance account, follow these steps:

1. Log in to your Binance account  
2. Go to **API Management**  
3. Select your trading API key  
4. Under **API Restrictions**, enable:

✔ Spot Trading  
✔ Futures Trading  
✔ Margin Trading  

❗ *Do NOT enable withdrawals.*

5. Scroll to **IP Access Restrictions**  
6. Select *Restrict access to trusted IPs only*  
7. Add this IP:

🔒 **159.69.22.110**

Once saved, your account will synchronize with our trading system.
`;

    bot.sendMessage(chatId, instructions, { parse_mode: "Markdown" });
  }

  // --- TRADE SETTINGS MENU ---
  if (data === "trade_settings") {
    const settings = `
⚙ **TRADE SETTINGS INSTRUCTIONS**

Make changes to the following:

1️⃣ **Position Mode**  
➡ Change to *One Way Mode*

2️⃣ **Asset Mode**  
➡ Change to *Single Asset Mode*

3️⃣ **Margin Mode**  
➡ Change to *Isolated*

These settings ensure your account is properly configured for automated trading.
`;
    bot.sendMessage(chatId, settings, { parse_mode: "Markdown" });
  }
});

// ===============================
// ADMIN COMMANDS
// ===============================
// /activate 123456789
// /deactivate 123456789
bot.onText(/\/(activate|deactivate) (.+)/, (msg, match) => {
  if (String(msg.chat.id) !== ADMIN_ID) return;

  const action = match[1];
  const targetId = match[2].trim();

  let users = loadUsers();
  let user = findUser(users, targetId);

  if (!user) {
    return bot.sendMessage(msg.chat.id, "❌ User not found.");
  }

  if (action === "activate") {
    user.active = true;
    saveUsers(users);

    bot.sendMessage(msg.chat.id, "✅ User Activated");
    bot.sendMessage(targetId, "🟢 *Your account has been activated.*\nAutomated trading has commenced.", {
      parse_mode: "Markdown",
    });
  }

  if (action === "deactivate") {
    user.active = false;
    saveUsers(users);

    bot.sendMessage(msg.chat.id, "🛑 User Deactivated");
    bot.sendMessage(targetId, "🔴 *Your account has been deactivated.*\nAutomated trading is now paused.", {
      parse_mode: "Markdown",
    });
  }
});

// ===============================
console.log("Binance Registration Bot Running...");
