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

const notificationTasks = new Map();
let lastNotification = null;

async function sendToGAS(payload) {
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`📤 發送 GAS 請求（第 ${attempt} 次）：${JSON.stringify(payload)}`);
      const response = await axios.post(gasWebhookUrl, payload);
      console.log(`✅ GAS 回應，狀態碼：${response.status}, 數據：${JSON.stringify(response.data)}`);
      return response.data;
    } catch (err) {
      console.error(`❌ GAS 請求失敗（第 ${attempt} 次）：${err.message}`);
      if (attempt < maxRetries) {
        console.log(`⏳ 等待 5 秒後重試`);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }
  console.error("❌ 經過 3 次重試仍失敗");
  return null;
}

async function sendNotification(channel, message, taskDetails = null) {
  try {
    const embed = {
      title: "待辦事項通知",
      description: message,
      color: 0x00ff00,
      timestamp: new Date().toISOString()
    };
    const sentMessage = await channel.send({ embeds: [embed] });
    console.log(`✅ 發送通知，訊息 ID：${sentMessage.id}`);
    if (taskDetails) {
      notificationTasks.set(sentMessage.id, taskDetails);
      lastNotification = { messageId: sentMessage.id, task: taskDetails };
      console.log(`✅ 儲存任務到 notificationTasks：${JSON.stringify(taskDetails)}`);
    }
    return sentMessage.id;
  } catch (err) {
    console.error(`❌ 發送通知失敗：${err.message}`);
    return null;
  }
}

client.once("ready", () => {
  console.log(`🤖 Bot 上線：${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot || message.channelId !== "1371833091378909295") {
    console.log(`⏩ 忽略訊息：Bot=${message.author.bot}, 頻道ID=${message.channelId}`);
    return;
  }

  const content = message.content || "";
  const displayName = message.member?.displayName || message.author.displayName || message.author.username;
  console.log(`📨 收到訊息：${content}（顯示名稱：${displayName}）`);

  if (content.toLowerCase() === "ok") {
    console.log(`✅ 檢測到 OK 回覆`);
    let task = null;
    if (message.reference && message.reference.messageId) {
      task = notificationTasks.get(message.reference.messageId);
      console.log(`ℹ️ 檢查引用訊息 ID：${message.reference.messageId}, 任務：${JSON.stringify(task)}`);
    } else if (lastNotification) {
      task = lastNotification.task;
      console.log(`ℹ️ 無引用，使用最近通知：${JSON.stringify(task)}`);
    }

    if (task) {
      console.log(`✅ 找到 OK 回覆的任務：${JSON.stringify(task)}`);
      const response = await sendToGAS({
        type: "complete",
        date: task.date,
        time: task.time,
        content: task.content,
        username: displayName
      });
      console.log(`✅ 完成請求回應：${JSON.stringify(response)}`);
    } else {
      console.log(`❌ 未找到匹配的任務`);
    }
    return;
  }

  if (!content.toLowerCase().startsWith(prefix.toLowerCase())) {
    console.log("⏩ 忽略：不是 AA 開頭的訊息");
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
    console.log(`✅ 前綴符合，V=${repeatReminder}, 提前提醒=${reminderOffset} 分鐘`);
  }

  taskContent = content.slice(prefixLength).trim();
  // 處理 Discord 提及和純文字 @名稱
  let cleanedContent = taskContent;
  let executor = null;
  const mentionMatch = taskContent.match(/<@!?(\d+)>/);
  if (mentionMatch) {
    const userId = mentionMatch[1];
    try {
      const user = await message.guild.members.fetch(userId);
      executor = user.displayName || user.user.username;
      console.log(`✅ 提取提及的使用者顯示名稱：${executor}`);
      cleanedContent = taskContent.replace(/<@!?\d+>/g, "").trim();
    } catch (err) {
      console.error(`❌ 無法獲取使用者 ${userId} 的顯示名稱：${err.message}`);
      cleanedContent = taskContent.replace(/<@!?\d+>/g, "").trim();
    }
  } else {
    const atMatch = taskContent.match(/@([^\s<@>]+)/);
    if (atMatch) {
      executor = atMatch[1].trim();
      console.log(`✅ 提取純文字執行者：${executor}`);
      cleanedContent = taskContent.replace(/@[^\s<@>]+/, "").trim();
    }
  }

  console.log(`✅ 清理後內容：${cleanedContent}, 執行者：${executor || "未指定"}`);
  const response = await sendToGAS({
    type: "task",
    content: cleanedContent,
    username: displayName,
    executor: executor || displayName, // 若無執行者，使用發送者顯示名稱
    repeatReminder,
    reminderOffset,
    originalContent: content
  });

  if (response && response.status === "OK" && response.taskDetails) {
    console.log(`✅ 收到 GAS 任務詳情：${JSON.stringify(response.taskDetails)}`);
    await sendNotification(message.channel, response.message, response.taskDetails);
  } else {
    console.log(`❌ GAS 回應無效或任務寫入失敗：${JSON.stringify(response)}`);
    await sendNotification(message.channel, `⚠️ 任務新增失敗：${taskContent}\n請檢查試算表或輸入格式。`);
  }
});

client.on("messageReactionAdd", async (reaction, user) => {
  if (user.bot || reaction.message.channelId !== "1371833091378909295") {
    console.log(`⏩ 忽略反應：Bot=${user.bot}, 頻道ID=${reaction.message.channelId}`);
    return;
  }
  if (reaction.emoji.name !== "👍") {
    console.log(`⏩ 忽略非 👍 反應：${reaction.emoji.name}`);
    return;
  }

  const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
  if (message.author.id !== client.user.id) {
    console.log(`⏩ 忽略非 Bot 訊息：作者=${message.author.id}`);
    return;
  }

  console.log(`✅ 檢測到 👍 反應，訊息 ID：${message.id}`);
  const task = notificationTasks.get(message.id);
  if (task) {
    console.log(`✅ 找到反應的任務：${JSON.stringify(task)}`);
    const response = await sendToGAS({
      type: "complete",
      date: task.date,
      time: task.time,
      content: task.content,
      username: user.displayName || user.username
    });
    console.log(`✅ 完成請求回應：${JSON.stringify(response)}`);
  } else {
    console.log(`❌ 未找到匹配的任務，訊息 ID：${message.id}`);
  }
});

const app = express();
app.get("/", (req, res) => res.send("🤖 Bot is alive!"));
app.listen(3000, () => console.log("🌐 KeepAlive server running on port 3000"));

client.login(botToken);