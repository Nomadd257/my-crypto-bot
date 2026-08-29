const TelegramBot = require("node-telegram-bot-api");

// ===== CONFIG =====
const BOT_TOKEN = "8656741808:AAEJuPvouct_yPaEQqZdFhLa7BmTPuG8LS4";
const GROUP_CHAT_ID = "-1002708995403"; // Correct supergroup ID

// ===== INIT BOT =====
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ===== START COMMAND =====
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `👋 Welcome! Please make payment to one of the following accounts:

🏦 Account Name: *Uvietesivwi Daniel*
💳 Opay: 8186268414
💳 Monie Point: 8146649325
💳 PalmPay: 9015435052

💡 Once payment is confirmed, your account will be activated for full access to the bot’s signals within 24 hours. ✅

📌 Subscription Plans:

Manual Trading

1️⃣ Monthly ($20)
2️⃣ 6 Months ($110)
3️⃣ 1 Year ($200)

Automated Trading 

1️⃣ Monthly ($40)
2️⃣ 6 Months ($220)
3️⃣ 1 Year ($400)

⚠️ Please upload your receipt and *include your subscription plan and your exchange in the caption*.  

Example: "Monthly – Binance"`,
    { parse_mode: "Markdown" }
  );
});

// ===== HELPER: FORWARD RECEIPT TO GROUP =====
function forwardReceiptToGroup(user, fileId, type, captionText) {
  let userMention = user.username ? `@${user.username}` : `[${user.first_name || "User"}](tg://user?id=${user.id})`;

  const caption = `📩 *New Receipt Uploaded*\n👤 User: ${userMention}\n🆔 User ID: ${user.id}\n\n📝 Caption: *${captionText}*`;

  const opts = {
    caption,
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Verify", callback_data: `verify_${user.id}` },
          { text: "❌ Reject", callback_data: `reject_${user.id}` },
        ],
      ],
    },
  };

  if (type === "photo") {
    bot.sendPhoto(GROUP_CHAT_ID, fileId, opts).catch((err) => console.error("Error sending photo:", err));
  } else {
    bot.sendDocument(GROUP_CHAT_ID, fileId, {}, opts).catch((err) => console.error("Error sending document:", err));
  }
}

// ===== HANDLE PHOTO RECEIPTS =====
bot.on("photo", (msg) => {
  const caption = msg.caption ? msg.caption.trim() : null;
  if (!caption) {
    bot.sendMessage(
      msg.chat.id,
      "⚠️ Please re-upload your receipt and *include your subscription plan and exchange in the caption* (e.g., Monthly – Binance).",
      { parse_mode: "Markdown" }
    );
    return;
  }
  const fileId = msg.photo[msg.photo.length - 1].file_id;
  forwardReceiptToGroup(msg.from, fileId, "photo", caption);
  bot.sendMessage(msg.chat.id, "✅ Receipt uploaded successfully.\nYour payment is under review.");
});

// ===== HANDLE DOCUMENT RECEIPTS =====
bot.on("document", (msg) => {
  const caption = msg.caption ? msg.caption.trim() : null;
  if (!caption) {
    bot.sendMessage(
      msg.chat.id,
      "⚠️ Please re-upload your receipt and *include your subscription plan and exchange in the caption* (e.g., Monthly – Binance).",
      { parse_mode: "Markdown" }
    );
    return;
  }
  const fileId = msg.document.file_id;
  forwardReceiptToGroup(msg.from, fileId, "document", caption);
  bot.sendMessage(msg.chat.id, "✅ Receipt uploaded successfully.\nYour payment is under review.");
});

// ===== ADMIN VERIFICATION HANDLER =====
bot.on("callback_query", async (query) => {
  const data = query.data;
  const adminId = query.from.id;
  const adminUsername = query.from.username || query.from.first_name || adminId;

  // Check admin rights
  let admins;
  try {
    admins = await bot.getChatAdministrators(GROUP_CHAT_ID);
  } catch (err) {
    console.error("Error fetching admins:", err);
    return;
  }
  const isAdmin = admins.some((a) => a.user.id === adminId);
  if (!isAdmin) {
    await bot.answerCallbackQuery(query.id, {
      text: "❌ Only admins can verify.",
      show_alert: true,
    });
    return;
  }

  // ===== REJECT FLOW =====
  if (data.startsWith("reject_")) {
    const userId = data.split("_")[1];
    const messageId = query.message.message_id;

    // Edit inline buttons -> show "Processed"
    await bot.editMessageReplyMarkup(
      {
        inline_keyboard: [[{ text: `❌ Rejected by @${adminUsername}`, callback_data: "disabled" }]],
      },
      { chat_id: GROUP_CHAT_ID, message_id: messageId }
    );

    await bot.sendMessage(GROUP_CHAT_ID, `❌ Payment Rejected for User ID: ${userId}\n👮 Action by: @${adminUsername}`);
    await bot.sendMessage(userId, "⚠️ Your payment receipt was rejected. Please contact support.");
    await bot.answerCallbackQuery(query.id);
    return;
  }

  // ===== VERIFY FLOW (Show plan activation buttons) =====
  if (data.startsWith("verify_")) {
    const userId = data.split("_")[1];
    const messageId = query.message.message_id;

    // Edit verify/reject -> show "Verified"
    await bot.editMessageReplyMarkup(
      {
        inline_keyboard: [[{ text: `✅ Verified by @${adminUsername}`, callback_data: "disabled" }]],
      },
      { chat_id: GROUP_CHAT_ID, message_id: messageId }
    );

    await bot.sendMessage(
      GROUP_CHAT_ID,
      `✅ Receipt verified for User ID: ${userId}\n👮 Verified by: @${adminUsername}\n\n📌 Now select a subscription plan to activate:`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "📅 Monthly", callback_data: `activate_${userId}_Monthly` },
              { text: "📅 6 Months", callback_data: `activate_${userId}_6M` },
              { text: "📅 1 Year", callback_data: `activate_${userId}_1Y` },
            ],
          ],
        },
      }
    );
    await bot.answerCallbackQuery(query.id);
  }

  // ===== PLAN ACTIVATION FLOW =====
  if (data.startsWith("activate_")) {
    const [_, userId, planCode] = data.split("_");
    const messageId = query.message.message_id;

    let days = 0;
    if (planCode === "Monthly") days = 30;
    if (planCode === "6M") days = 180;
    if (planCode === "1Y") days = 365;

    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + days);
    const expiryString = expiryDate.toLocaleDateString();

    // Edit plan buttons -> show processed
    await bot.editMessageReplyMarkup(
      {
        inline_keyboard: [
          [
            {
              text: `🔒 Activated: ${planCode} (by @${adminUsername})`,
              callback_data: "disabled",
            },
          ],
        ],
      },
      { chat_id: GROUP_CHAT_ID, message_id: messageId }
    );

    // Messages
    await bot.sendMessage(
      GROUP_CHAT_ID,
      `🎉 Subscription Activated!\n👤 User ID: ${userId}\n📌 Plan: ${planCode}\n📅 Expiry: ${expiryString}\n👮 Activated by: @${adminUsername}`
    );
    await bot.sendMessage(
      userId,
      `🎉 Your subscription has been activated!\n📌 Plan: ${planCode}\n📅 Expiry: ${expiryString}\n✅ You now have full access to signals.`
    );

    await bot.answerCallbackQuery(query.id);
  }
});
