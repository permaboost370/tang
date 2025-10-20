// server.mjs
import 'dotenv/config';
import { Bot, InputFile } from 'grammy';
import express from 'express';
import fetch from 'node-fetch';

/* ----------------------------- ENV ----------------------------- */
const { BOT_TOKEN, ADMIN_CHAT_ID, PORT = 3000 } = process.env;
if (!BOT_TOKEN) throw new Error('Missing BOT_TOKEN');
if (!ADMIN_CHAT_ID) throw new Error('Missing ADMIN_CHAT_ID');

/* ------------------------- State (memory) ----------------------- */
// Map adminMessageId -> job { userId, username, userChatId, userMsgId, fileId, caption }
const jobs = new Map();

/* ----------------------------- Bot ------------------------------ */
const bot = new Bot(BOT_TOKEN);

function isAdminChatId(id) {
  return String(id) === String(ADMIN_CHAT_ID);
}

function fmtUser(ctx) {
  const u = ctx.from || {};
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || 'User';
  const at = u.username ? `@${u.username}` : `(id:${u.id})`;
  return { id: u.id, name, at };
}

bot.command('start', async (ctx) => {
  await ctx.reply('Send me the photo you want turned into a PFP. You’ll get a DM here once it’s ready. 😺✨');
});

bot.command('help', async (ctx) => {
  await ctx.reply(
    `How it works:
1) Send a photo here.
2) The creator will edit it manually.
3) You’ll receive your finished PFP back in this chat.

Admin-only: /id shows this chat id.`
  );
});

bot.command('id', async (ctx) => {
  await ctx.reply(`chat_id: ${ctx.chat.id}`);
});

/* -------------------------- Helpers ---------------------------- */
async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

async function tgGetFileUrl(token, fileId) {
  const meta = await fetchWithTimeout(
    `https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`,
    {}, 15000
  ).then(r => r.json());
  const filePath = meta?.result?.file_path;
  if (!filePath) throw new Error('Could not resolve Telegram file_path');
  return `https://api.telegram.org/file/bot${token}/${filePath}`;
}

// Given a message, extract the **best image file_id** (photo or image document)
function getBestImageFileId(msg) {
  // 1) Photo (Telegram provides multiple sizes; take the largest)
  if (msg.photo && msg.photo.length) {
    const p = msg.photo[msg.photo.length - 1]; // largest
    if (p?.file_id) return p.file_id;
  }
  // 2) Document that is an image
  if (msg.document) {
    const mime = msg.document.mime_type || '';
    if (mime.startsWith('image/')) {
      return msg.document.file_id;
    }
  }
  return null;
}

/* ---------------------- User sends a photo ---------------------- */
bot.on('message:photo', async (ctx) => {
  const chatId = ctx.chat.id;
  if (isAdminChatId(chatId)) {
    // In admin chat, the photo is handled in admin handler below
    return;
  }

  const { id: userId, name, at } = fmtUser(ctx);
  const fileId = getBestImageFileId(ctx.message);
  if (!fileId) {
    await ctx.reply('Hmm, I couldn’t read that. Please send a photo (not a file).');
    return;
  }

  await ctx.reply('Got it! Your PFP will be sent here soon. 😺');

  // Send to admin with instructions (not forward, so reply works reliably)
  const caption = `New PFP request:
From: ${name} ${at}
user_id: ${userId}

👉 Reply to this message with the finished image (as photo or image file) to deliver it back to the user.`;
  const adminMsg = await ctx.api.sendPhoto(ADMIN_CHAT_ID, fileId, { caption });

  jobs.set(adminMsg.message_id, {
    userId,
    username: at,
    userChatId: chatId,
    userMsgId: ctx.message.message_id,
    fileId,
    captionFromUser: ctx.message.caption || ''
  });

  console.log('[job created]', {
    adminMessageId: adminMsg.message_id,
    userChatId: chatId,
    userId,
    username: at
  });
});

// ALSO accept when the user sends as document (some clients send PNG/JPG as file)
bot.on('message:document', async (ctx) => {
  const chatId = ctx.chat.id;
  if (isAdminChatId(chatId)) return; // handle in admin section

  const { id: userId, name, at } = fmtUser(ctx);
  const fileId = getBestImageFileId(ctx.message);
  if (!fileId) {
    await ctx.reply('Please send an image (JPG/PNG).');
    return;
  }

  await ctx.reply('Got it! Your PFP will be sent here soon. 😺');

  const caption = `New PFP request:
From: ${name} ${at}
user_id: ${userId}

👉 Reply to this message with the finished image (as photo or image file) to deliver it back to the user.`;
  const adminMsg = await ctx.api.sendDocument(ADMIN_CHAT_ID, fileId, { caption });

  jobs.set(adminMsg.message_id, {
    userId,
    username: at,
    userChatId: chatId,
    userMsgId: ctx.message.message_id,
    fileId,
    captionFromUser: ctx.message.caption || ''
  });

  console.log('[job created:document]', {
    adminMessageId: adminMsg.message_id,
    userChatId: chatId,
    userId,
    username: at
  });
});

/* ---------------- Admin replies to deliver result ---------------- */
async function handleAdminReplyDelivery(ctx) {
  if (!isAdminChatId(ctx.chat.id)) return;

  const reply = ctx.message.reply_to_message;
  if (!reply) {
    await ctx.reply('Reply to the job message I sent you. Your reply must include the finished image.');
    return;
  }

  const job = jobs.get(reply.message_id);
  if (!job) {
    await ctx.reply('I can’t find this job. Make sure you are replying to the exact job message I sent.');
    console.warn('[unknown job reply]', { replyTo: reply.message_id });
    return;
  }

  const finishedFileId = getBestImageFileId(ctx.message);
  if (!finishedFileId) {
    await ctx.reply('Please attach the finished image as a photo or image file in your reply.');
    return;
  }

  try {
    await ctx.api.sendPhoto(job.userChatId, finishedFileId, {
      caption: `Your PFP is ready! 😺✨`,
    });
    await ctx.reply(`✅ Delivered to ${job.username} (id:${job.userId}).`);
    jobs.delete(reply.message_id);
    console.log('[delivered]', { to: job.userChatId, userId: job.userId });
  } catch (e) {
    console.error('[deliver error]', e);
    await ctx.reply('❌ Failed to deliver to the user. They must have started the bot and not blocked it.');
  }
}

// Accept photo or document from admin
bot.on('message:photo', handleAdminReplyDelivery);
bot.on('message:document', handleAdminReplyDelivery);

/* ---------------------- Start polling + health ------------------ */
bot.start();
console.log('Bot started with long polling.');

const app = express();
app.get('/', (_, res) => res.send('OK'));
app.listen(PORT, () => console.log('Health server on :' + PORT));
