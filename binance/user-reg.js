// =====================================================
// DanuvieCrypto Registration Bot (Updated, Hardcoded Token + AutoTrading Group Button)
// =====================================================

import TelegramBot from "node-telegram-bot-api";
import fs from "fs";

// ===============================
// CONFIG
// ===============================

// IMPORTANT:
// Replace this with your NEW token generated
// from @BotFather.
// Do NOT use the token previously posted.
const bot = new TelegramBot("8782543055:AAFevGNqJW_L1xymbXO0ECsS6P9tGEjV7EM", {
  polling: true,
});

// ===============================
// ADMIN IDS
// ===============================

const ADMIN_IDS = [
  "7476742687", "1718404728",
];

const USERS_FILE = "users.json";

// ===============================
// ADMIN CHECK
// ===============================

function isAdmin(msg) {
  return ADMIN_IDS.includes(String(msg?.chat?.id));
}

// ===============================
// LOAD / SAVE USERS
// ===============================

function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(
      USERS_FILE,
      JSON.stringify([], null, 2)
    );
  }

  try {
    return JSON.parse(
      fs.readFileSync(USERS_FILE, "utf8")
    );
  } catch (err) {
    console.error("Error loading users.json:", err);
    return [];
  }
}

function saveUsers(data) {
  fs.writeFileSync(
    USERS_FILE,
    JSON.stringify(data, null, 2)
  );
}

function findUser(users, id) {
  return users.find(
    (u) => u.id === String(id)
  );
}

// ===============================
// CREATE / UPDATE USER PROFILE
// ===============================

function createUserFromTelegram(msg) {
  return {
    id: String(msg.chat.id),

    firstName:
      msg.from?.first_name || "",

    lastName:
      msg.from?.last_name || "",

    username:
      msg.from?.username || "",

    photoFileId: "",

    apiKey: "",
    apiSecret: "",

    active: false,
  };
}

function updateTelegramDetails(user, msg) {

  user.firstName =
    msg.from?.first_name ||
    user.firstName ||
    "";

  user.lastName =
    msg.from?.last_name ||
    user.lastName ||
    "";

  user.username =
    msg.from?.username ||
    user.username ||
    "";
}

// ===============================
// START COMMAND
// ===============================

bot.onText(/\/start/, (msg) => {

  const chatId = msg.chat.id;

  let users = loadUsers();

  let user = findUser(
    users,
    chatId
  );

  if (!user) {

    user =
      createUserFromTelegram(msg);

    users.push(user);

  } else {

    updateTelegramDetails(
      user,
      msg
    );

  }

  saveUsers(users);

  bot.sendMessage(
    chatId,

`👋 *Welcome to DanuvieCrypto Registration*

Navigate using the buttons below.`,

    {
      parse_mode: "Markdown",

      reply_markup: {

        inline_keyboard: [

          [
            {
              text: "🔑 Binance API Keys",
              callback_data: "api_menu"
            }
          ],

          [
            {
              text: "📷 Passport Photo",
              callback_data: "passport_photo"
            }
          ],

          [
            {
              text: "💳 Subscription",
              url:
                "https://t.me/DanuvieCryptopayments_bot"
            }
          ],

          [
            {
              text: "🖥 Server IP",
              callback_data: "server_ip"
            }
          ],

          [
            {
              text: "⚙ Trade Settings",
              callback_data: "trade_settings"
            }
          ],

        ],

      },

    }

  );

});

// ===============================
// HANDLE MENU OPTIONS
// ===============================

bot.on("callback_query", (query) => {

  const chatId =
    query.message.chat.id;

  const data =
    query.data;

  let users =
    loadUsers();

  let user =
    findUser(
      users,
      chatId
    );

  // Ensure user exists

  if (!user) {

    user =
      createUserFromTelegram(
        query.message
      );

    users.push(user);

  }

  // Update Telegram information

  if (query.from) {

    user.firstName =
      query.from.first_name ||
      user.firstName ||
      "";

    user.lastName =
      query.from.last_name ||
      user.lastName ||
      "";

    user.username =
      query.from.username ||
      user.username ||
      "";

  }

  saveUsers(users);

  // =============================
  // API MENU
  // =============================

  if (data === "api_menu") {

    bot.sendMessage(
      chatId,

`🔐 *Binance API Setup*

Use the buttons below to enter your API credentials.

⚠️ Never enable withdrawals on your Binance API key.`,

      {
        parse_mode: "Markdown",

        reply_markup: {

          inline_keyboard: [

            [
              {
                text:
                  "🔐 Enter API Key",
                callback_data:
                  "enter_api_key"
              }
            ],

            [
              {
                text:
                  "🔏 Enter API Secret",
                callback_data:
                  "enter_api_secret"
              }
            ],

          ],

        },

      }

    );

  }

  // =============================
  // PASSPORT PHOTO
  // =============================

  if (data === "passport_photo") {

    bot.sendMessage(
      chatId,

`📷 *Passport Photograph*

Please upload your passport photograph as a photo.

The bot will store Telegram's photo reference rather than keeping the image file on your server.

Please send the photograph now.`,

      {
        parse_mode: "Markdown",
      }
    );

  }

  // =============================
  // API KEY
  // =============================

  if (data === "enter_api_key") {

    bot.sendMessage(
      chatId,
      "Please send your *Binance API Key* now.",
      {
        parse_mode: "Markdown",
      }
    );

    bot.once(
      "message",
      (msg) => {

        const uid =
          msg.chat.id;

        if (!msg.text) {

          return bot.sendMessage(
            uid,
            "❌ Please send the API Key as text."
          );

        }

        let users =
          loadUsers();

        let usr =
          findUser(
            users,
            uid
          );

        if (!usr) {

          usr =
            createUserFromTelegram(
              msg
            );

          users.push(usr);

        }

        usr.apiKey =
          msg.text.trim();

        updateTelegramDetails(
          usr,
          msg
        );

        saveUsers(users);

        bot.sendMessage(
          uid,
          "✅ API Key saved successfully."
        );

      }
    );

  }

  // =============================
  // API SECRET
  // =============================

  if (data === "enter_api_secret") {

    bot.sendMessage(
      chatId,
      "Please send your *Binance API Secret* now.",
      {
        parse_mode: "Markdown",
      }
    );

    bot.once(
      "message",
      (msg) => {

        const uid =
          msg.chat.id;

        if (!msg.text) {

          return bot.sendMessage(
            uid,
            "❌ Please send the API Secret as text."
          );

        }

        let users =
          loadUsers();

        let usr =
          findUser(
            users,
            uid
          );

        if (!usr) {

          usr =
            createUserFromTelegram(
              msg
            );

          users.push(usr);

        }

        usr.apiSecret =
          msg.text.trim();

        updateTelegramDetails(
          usr,
          msg
        );

        saveUsers(users);

        bot.sendMessage(
          uid,
          "✅ API Secret saved successfully."
        );

      }
    );

  }

  // =============================
  // SERVER IP
  // =============================

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

    bot.sendMessage(
      chatId,
      instructions,
      {
        parse_mode: "Markdown",
      }
    );

  }

  // =============================
  // TRADE SETTINGS
  // =============================

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

    bot.sendMessage(
      chatId,
      settings,
      {
        parse_mode: "Markdown",
      }
    );

  }

  // Answer callback

  bot.answerCallbackQuery(
    query.id
  );

});

// ===============================
// PASSPORT PHOTO HANDLER
// ===============================

bot.on("photo", (msg) => {

  const chatId =
    msg.chat.id;

  let users =
    loadUsers();

  let user =
    findUser(
      users,
      chatId
    );

  if (!user) {

    user =
      createUserFromTelegram(
        msg
      );

    users.push(user);

  }

  updateTelegramDetails(
    user,
    msg
  );

  // Telegram provides several
  // resolutions of the uploaded photo.
  // The final element is normally
  // the largest available version.

  const photos =
    msg.photo;

  if (
    !photos ||
    photos.length === 0
  ) {

    return bot.sendMessage(
      chatId,
      "❌ Photo could not be processed. Please try again."
    );

  }

  const largestPhoto =
    photos[
      photos.length - 1
    ];

  user.photoFileId =
    largestPhoto.file_id;

  saveUsers(users);

  bot.sendMessage(
    chatId,

`✅ *Passport photograph saved successfully.*

Your photo has been linked to your registration.`,

    {
      parse_mode: "Markdown",
    }
  );

});

// ===============================
// ADMIN COMMANDS
// ===============================

// /users
//
// Displays all registered users
// with:
//
// • Full name
// • Username
// • Chat ID
// • Passport photograph
// • Account status
//
// IMPORTANT:
// API Key and API Secret are NEVER
// displayed in this command.
// ===============================

bot.onText(/\/users$/, async (msg) => {

  if (!isAdmin(msg)) {
    return;
  }

  const adminChatId =
    msg.chat.id;

  const users =
    loadUsers();

  if (!users.length) {

    return bot.sendMessage(
      adminChatId,
      "👥 No registered users found."
    );

  }

  await bot.sendMessage(
    adminChatId,
    `👥 *REGISTERED USERS*\n\nTotal Users: ${users.length}`,
    {
      parse_mode: "Markdown"
    }
  );

  // =================================
  // SEND EACH USER
  // =================================

  for (
    let i = 0;
    i < users.length;
    i++
  ) {

    const user =
      users[i];

    const fullName =
      [
        user.firstName,
        user.lastName
      ]
        .filter(Boolean)
        .join(" ") ||
      "Name not provided";

    const username =
      user.username
        ? `@${user.username}`
        : "No username";

    const status =
      user.active
        ? "🟢 ACTIVE"
        : "🔴 INACTIVE";

    // =================================
    // USER INFORMATION
    // =================================

    const caption =

`👤 *USER ${i + 1}*

Name: ${fullName}
Username: ${username}
🆔 Chat ID: \`${user.id}\`

Account: ${status}

🔐 API Credentials: ${
      user.apiKey &&
      user.apiSecret
        ? "CONNECTED"
        : "NOT COMPLETE"
    }`;

    // =================================
    // SEND PHOTO IF AVAILABLE
    // =================================

    if (
      user.photoFileId
    ) {

      try {

        await bot.sendPhoto(
          adminChatId,
          user.photoFileId,
          {
            caption,
            parse_mode: "Markdown"
          }
        );

      }

      catch (err) {

        console.error(
          `Could not send photo for ${user.id}:`,
          err.message
        );

        await bot.sendMessage(
          adminChatId,
          `${caption}

📷 Passport Photo: Unable to display`,
          {
            parse_mode: "Markdown"
          }
        );

      }

    }

    // =================================
    // NO PHOTO
    // =================================

    else {

      await bot.sendMessage(
        adminChatId,

`${caption}

📷 Passport Photo: Not uploaded`,

        {
          parse_mode: "Markdown"
        }
      );

    }

    // =================================
    // SEPARATOR
    // =================================

    if (
      i < users.length - 1
    ) {

      await bot.sendMessage(
        adminChatId,
        "━━━━━━━━━━━━━━━━━━━━"
      );

    }

  }

});

// ===============================
// ACTIVATE / DEACTIVATE USERS
// ===============================
//
// /activate 123456789
// /deactivate 123456789
// ===============================

bot.onText(
  /\/(activate|deactivate) (.+)/,
  (msg, match) => {

    if (!isAdmin(msg)) {
      return;
    }

    const action =
      match[1];

    const targetId =
      match[2].trim();

    let users =
      loadUsers();

    let user =
      findUser(
        users,
        targetId
      );

    if (!user) {

      return bot.sendMessage(
        msg.chat.id,
        "❌ User not found."
      );

    }

    // =================================
    // ACTIVATE
    // =================================

    if (
      action === "activate"
    ) {

      user.active =
        true;

      saveUsers(users);

      bot.sendMessage(
        msg.chat.id,
        "✅ User Activated"
      );

      bot.sendMessage(
        targetId,

`🟢 *Your account has been activated.*

Automated trading has commenced.`,

        {
          parse_mode: "Markdown"
        }
      );

    }

    // =================================
    // DEACTIVATE
    // =================================

    if (
      action === "deactivate"
    ) {

      user.active =
        false;

      saveUsers(users);

      bot.sendMessage(
        msg.chat.id,
        "🛑 User Deactivated"
      );

      bot.sendMessage(
        targetId,

`🔴 *Your account has been deactivated.*

Automated trading is now paused.`,

        {
          parse_mode: "Markdown"
        }
      );

    }

  }
);

// ===============================
// ADMIN HELP
// ===============================

bot.onText(
  /\/adminhelp$/,
  (msg) => {

    if (!isAdmin(msg)) {
      return;
    }

    const help = `

🛠 *ADMIN COMMANDS*

/users
View all registered users.

/activate CHAT_ID
Activate a user's account.

/deactivate CHAT_ID
Deactivate a user's account.

/adminhelp
Display this menu.

⚠️ API credentials are never displayed by /users.
`;

    bot.sendMessage(
      msg.chat.id,
      help,
      {
        parse_mode: "Markdown"
      }
    );

  }
);

// ===============================
// BOT STARTUP
// ===============================

console.log(
  "Binance Registration Bot Running..."
);
