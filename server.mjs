// server.mjs
import 'dotenv/config';
import { Bot, InputFile } from 'grammy';
import express from 'express'; // optional "health check" server
import fetch from 'node-fetch';

// ---- ENV ----
const { BOT_TOKEN, ADMIN_CHAT_ID } = process.env;
if (!BOT_TOKEN) throw new Error('Missing BOT_TOKEN');
if (!ADMIN_CHAT_ID) throw new Error('Missing ADMIN_CHAT_ID (your personal Telegram chat id)');

// ---- Minimal persistence (in-memory + optional JSON snapshot) ----
// Map adminMessageId -> job { userId, username, userChatId, userMsgId, fileId, caption }
const jobs = new Map();

// Optional: save/load to a JSON file on start/stop (commented for simplicity)
// const PERSIST_PATH = '/tmp/tang-jobs.json';

// ---- Init bot ----
const bot = new Bot(BOT_TOKEN);

// Helpers
function fmtUser(ctx) {
  const u = ctx.from || {};
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || 'User';
  const at = u.username ? `@${u.username}` : `(id:${u.id})`;
  return { id: u.id, name, at };
}

function isAdmin(chatId) {
  return String(chatId) === String(ADMIN_CHAT_ID);
}

// Commands
bot.command('start', async (ctx) => {
  await ctx.reply('Send me the photo you want turned into a PFP. You’ll get a DM here once it’s ready. 😺✨');
});

bot.command('help', async (ctx) => {
  await ctx.reply(
    `How it works:
1) Send a photo here.
2) I’ll notify the creator.
3) You’ll receive your finished PFP in this chat.

Admin-only: /id shows this chat id.`
  );
});

bot.command('id', async (ctx) => {
  await ctx.reply(`chat_id: ${ctx.chat.id}`);
});

// User sends a photo (non-admin chats)
bot.on('message:photo', async (ctx) => {
  const chatId = ctx.chat.id;
  if (isAdmin(chatId)) {
    // In admin chat, photos are handled below (as "deliver to user")
    return;
  }

  const { id: userId, name, at } = fmtUser(ctx);
  const photos = ctx.message.photo;
  const fileId = photos?.[photos.length - 1]?.file_id;
  if (!fileId) {
    await ctx.reply('Hmm, I couldn’t read that. Please send a photo (not a file).');
    return;
  }

  // Acknowledge to user
  await ctx.reply('Got it! Your PFP will be sent here soon. 😺');

  // Forward to admin with user info and job instructions
  const caption = `New PFP request:\nFrom: ${name} ${at}\nuser_id: ${userId}\n\n👉 Reply to this message with the finished image to deliver it back to the user.`;
  const fwd = await ctx.api.sendPhoto(ADMIN_CHAT_ID, fileId, { caption });

  // Record the job using the admin message id as the key
  jobs.set(fwd.message_id, {
    userId,
    username: at,
    userChatId: chatId,
    userMsgId: ctx.message.message_id,
    fileId,
    captionFromUser: ctx.message.caption || '',
  });
});

// Admin replies with the finished photo → bot sends it to the original user
bot.on('message:photo', async (ctx) => {
  if (!isAdmin(ctx.chat.id)) return; // only handle admin chat here

  const reply = ctx.message.reply_to_message;
  if (!reply) return; // must be a reply to the bot's job message

  const job = jobs.get(reply.message_id);
  if (!job) return; // not a known job message

  const finishedPhotos = ctx.message.photo;
  const finishedFileId = finishedPhotos?.[finishedPhotos.length - 1]?.file_id;
  if (!finishedFileId) {
    await ctx.reply('I need a photo as a reply to the job message to deliver it.');
    return;
  }

  // Send to the original user
  await ctx.api.sendPhoto(job.userChatId, finishedFileId, {
    caption: `Your PFP is ready! 😺✨`,
  });

  // Optional: notify admin
  await ctx.reply(`✅ Delivered to ${job.username} (id:${job.userId}).`);

  // Cleanup the job
  jobs.delete(reply.message_id);
});

// Admin can also send a text reply to communicate with the user via the bot (optional)
bot.on('message:text', async (ctx) => {
  if (!isAdmin(ctx.chat.id)) return;

  const reply = ctx.message.reply_to_message;
  if (!reply) return;

  const job = jobs.get(reply.message_id);
  if (!job) return;

  await bot.api.sendMessage(job.userChatId, `Message from the creator:\n${ctx.message.text}`);
});

// ---- Start long polling (no webhook timeouts) ----
bot.start();
console.log('Bot started with long polling.');

// ---- Optional tiny HTTP server for Railway health checks ----
const app = express();
app.get('/', (_, res) => res.send('OK'));
const port = process.env.PORT || 3000;
app.listen(port, () => console.log('Health server on :' + port));
