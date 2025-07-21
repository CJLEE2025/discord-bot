const { Client, GatewayIntentBits } = require("discord.js");
const express = require("express");
const axios = require("axios");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions
  ],
});

const prefix = "AA";
const gasWebhookUrl = process.env.GAS_WEBHOOK_URL;
const botToken = process.env.DISCORD_BOT_TOKEN;
const DEBUG_ENABLED = process.env.DEBUG_ENABLED !== "false";

function log(...args) {
  if (DEBUG_ENABLED) {
    console.log(...args);
  }
}

const notificationTasks = new Map();
let lastNotification = null;
const sentMessages = new Set(); // 儲存已發送的通知訊息內容

console.log("🚀 開始執行 index.js");

async function sendToGAS(payload) {
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      log(`📤 發送 GAS 請求（第 ${attempt} 次）：${JSON.stringify(payload)}`);
      const response = await axios.post(gasWebhookUrl, payload);
      log(`✅ GAS 回應，狀態碼：${response.status}, 數據：${JSON.stringify(response.data)}`);
      return response.data;
    } catch (err) {
      console.error(`❌ GAS 請求失敗（第 ${attempt} 次）：${err.message}`);
      if (attempt < maxRetries) {
        log(`⏳ 等待 5 秒後重試`);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }
  console.error("❌ 經過 3 次重試仍失敗");
  return null;
}

async function sendNotification(channel, message, taskDetails = null) {
  // 檢查是否已發送相同訊息
  const messageKey = `${message}:${taskDetails?.date}:${taskDetails?.time}`;
  if (sentMessages.has(messageKey)) {
    log(`⏩ 忽略重複通知：${messageKey}`);
    return null;
  }
  try {
    const embed = {
      title: "待辦事項通知",
      description: message,
      color: 0x00ff00,
      timestamp: new Date().toISOString()
    };
    const sentMessage = await channel.send({ embeds: [embed] });
    log(`✅ 發送通知，訊息 ID：${sentMessage.id}`);
    sentMessages.add(messageKey); // 記錄已發送訊息
    if (taskDetails) {
      notificationTasks.set(sentMessage.id, taskDetails);
      lastNotification = { messageId: sentMessage.id, task: taskDetails };
      log(`✅ 儲存任務到 notificationTasks：${JSON.stringify(taskDetails)}`);
    }
    return sentMessage.id;
  } catch (err) {
    console.error(`❌ 發送通知失敗：${err.message}`);
    return null;
  }
}

client.once("ready", () => {
  log(`🤖 Bot 上線：${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot || message.channelId !== "1371833091378909295") {
    log(`⏩ 忽略訊息：Bot=${message.author.bot}, 頻道ID=${message.channelId}`);
    return;
  }

  const content = message.content || "";
  const displayName = message.member?.displayName || message.author.displayName || message.author.username;
  log(`📨 收到訊息：${content}（顯示名稱：${displayName}）`);

  // 處理 OK 回覆
  if (content.toLowerCase() === "ok") {
    log(`✅ 檢測到 OK 回覆`);
    let task = null;
    if (message.reference && message.reference.messageId) {
      const original = await message.channel.messages.fetch(message.reference.messageId);
      const text = original.content || original.embeds?.[0]?.description || "";
      const matched = text.match(/事項[：:]\s*「([^」]+)」(?:\s*\（備註：[^\)]+\))?.*預定於\s*(\d{4}\/\d{1,2}\/\d{1,2})\s*(\d{2}:\d{2})(:\d{2})?/);
      if (matched) {
        const [, taskContent, date, time] = matched;
        task = { content: taskContent.trim(), date, time: time.slice(0, 5) };
        log(`✅ 從提醒格式中擷取任務：${JSON.stringify(task)}`);
      }
    } else if (lastNotification) {
      task = lastNotification.task;
      log(`ℹ️ 無引用，使用最近通知：${JSON.stringify(task)}`);
    }

    if (task) {
      const response = await sendToGAS({
        type: "complete",
        date: task.date,
        time: task.time,
        content: task.content,
        username: displayName
      });
      log(`✅ 完成請求回應：${JSON.stringify(response)}`);
      if (response && response.status !== "OK") {
        await message.channel.send(`⚠️ 無法刪除任務：${task.content} (${task.date} ${task.time})，請檢查試算表。`);
      }
    } else {
      log(`❌ 未找到匹配的任務`);
    }
    return;
  }

  if (!content.toLowerCase().startsWith(prefix.toLowerCase())) {
    log("⏩ 忽略：不是 AA 開頭的訊息");
    return;
  }

  let taskContent = content;
  let repeatReminder = false;
  let reminderOffset = 0;
  let prefixLength = prefix.length;

  const prefixMatch = content.toLowerCase().match(/^aa(v)?(\d+)?/i);
  if (prefixMatch) {
    if (prefixMatch[1]) repeatReminder = true;
    if (prefixMatch[2]) reminderOffset = parseInt(prefixMatch[2], 10);
    prefixLength = prefixMatch[0].length;
    log(`✅ 前綴符合，V=${repeatReminder}, 提前提醒=${reminderOffset} 分鐘`);
  }

  taskContent = content.slice(prefixLength).trim();
  let cleanedContent = taskContent;
  let executor = null;

  const mentionMatch = taskContent.match(/<@!?(\d+)>/);
  if (mentionMatch) {
    const userId = mentionMatch[1];
    try {
      const user = await message.guild.members.fetch(userId);
      executor = user.displayName || user.user.username;
      log(`✅ 提取提及的使用者顯示名稱：${executor}`);
      cleanedContent = taskContent.replace(/<@!?\d+>/g, "").trim();
    } catch (err) {
      console.error(`❌ 無法獲取使用者 ${userId} 的顯示名稱：${err.message}`);
      cleanedContent = taskContent.replace(/<@!?\d+>/g, "").trim();
    }
  } else {
    const atMatch = taskContent.match(/@([^\s<@>]+)/);
    if (atMatch) {
      executor = atMatch[1].trim();
      log(`✅ 提取純文字執行者：${executor}`);
      cleanedContent = taskContent.replace(/@[^\s<@>]+/, "").trim();
    }
  }

  executor = executor || "值班人員";
  log(`✅ 清理後內容：${cleanedContent}, 執行者：${executor}`);
  const response = await sendToGAS({
    type: "task",
    content: cleanedContent,
    username: displayName,
    executor: executor,
    repeatReminder,
    reminderOffset,
    originalContent: content
  });

  if (response && response.status === "OK" && response.taskDetails) {
    log(`✅ 收到 GAS 任務詳情：${JSON.stringify(response.taskDetails)}`);
    await sendNotification(message.channel, response.message, response.taskDetails);
  } else {
    log(`❌ GAS 回應無效或任務寫入失敗：${JSON.stringify(response)}`);
    await sendNotification(message.channel, `⚠️ 任務新增失敗：${taskContent}\n請檢查試算表或輸入格式。`);
  }
});

client.on("messageReactionAdd", async (reaction, user) => {
  if (user.bot || reaction.message.channelId !== "1371833091378909295") {
    log(`⏩ 忽略反應：Bot=${user.bot}, 頻道ID=${reaction.message.channelId}`);
    return;
  }
  if (reaction.emoji.name !== "👍") {
    log(`⏩ 忽略非 👍 反應：${reaction.emoji.name}`);
    return;
  }

  const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
  log(`✅ 檢測到 👍 反應，訊息 ID：${message.id}`);
  log(`🔍 完整訊息內容：${JSON.stringify(message.embeds?.[0] || message.content)}`);

  let task = notificationTasks.get(message.id);
  if (!task) {
    const text = message.content || message.embeds?.[0]?.description || "";
    log(`🔍 嘗試解析訊息內容：${text}`);
    const matched = text.match(/事項[：:]\s*「([^」]+)」(?:\s*\（備註：[^\)]+\))?.*預定於\s*(\d{4}\/\d{1,2}\/\d{1,2})\s*(\d{2}:\d{2})(:\d{2})?/);
    if (matched) {
      const [, taskContent, date, time] = matched;
      task = { content: taskContent.trim(), date, time: time.slice(0, 5) };
      log(`✅ 從提醒格式中擷取任務：${JSON.stringify(task)}`);
    } else {
      log(`⚠️ 訊息格式無法解析：${text}`);
    }
  }

  if (task) {
    const response = await sendToGAS({
      type: "complete",
      date: task.date,
      time: task.time,
      content: task.content,
      username: user.displayName || user.username
    });
    log(`✅ 完成請求回應：${JSON.stringify(response)}`);
    if (response && response.status !== "OK") {
      await message.channel.send(`⚠️ 無法刪除任務：${task.content} (${task.date} ${task.time})，請檢查試算表。`);
    }
  } else {
    log(`❌ 未找到匹配的任務，訊息 ID：${message.id}`);
    await message.channel.send(`⚠️ 無法識別任務，請確認訊息格式是否正確。`);
  }
});

client.on("error", (err) => {
  console.error(`❌ Discord 客戶端錯誤：${err.message}`);
});

client.login(botToken).catch((err) => {
  console.error(`❌ Discord 連線失敗：${err.message}`);
});

const app = express();
app.get("/", (req, res) => res.send("🤖 Bot is alive!"));
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => log(`🌐 KeepAlive server running on port ${PORT}`));
