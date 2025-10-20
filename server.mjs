import 'dotenv/config';
import { Bot, InputFile } from 'grammy';
import express from 'express';
import fetch from 'node-fetch';
import crypto from 'node:crypto';

const { BOT_TOKEN, ADMIN_CHAT_ID, PORT = 3000 } = process.env;
if (!BOT_TOKEN) throw new Error('Missing BOT_TOKEN');
if (!ADMIN_CHAT_ID) throw new Error('Missing ADMIN_CHAT_ID (numeric)');

// In-memory store
// token -> job
// adminMessageId -> token (so reply lookup still works)
const jobsByToken = new Map();
const tokensByAdminMsgId = new Map();

// Utils
function isAdminChat(id) {
  return String(id) === String(ADMIN_CHAT_ID);
}
function mkToken() {
  // Short friendly token
  return 'JOB-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}
function fmtUser(ctx) {
  const u = ctx.from || {};
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || 'User';
  const at = u.username ? `@${u.username}` : `(id:${u.id})`;
  return { id: u.id, name, at };
}
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
  if (!filePath) throw new Error('Could not resolve file_path');
  return `https://api.telegram.org/file/bot${token}/${filePath}`;
}
function getBestImageFileId(msg) {
  if (msg.photo?.length) return msg.photo[msg.photo.length - 1].file_id;
  if (msg.document && (msg.document.mime_type || '').startsWith('image/')) {
    return msg.document.file_id;
  }
  return null;
}

// Bot
const bot = new Bot(BOT_TOKEN);

// Ultra-verbose logging so we see *everything*
bot.use(async (ctx, next) => {
  try {
    const kind = ctx.update?.message ? 'message'
               : ctx.update?.edited_message ? 'edited_message'
               : Object.keys(ctx.update || {}).join(',') || 'unknown';
    console.log('[update]', kind, {
      chat_id: ctx.chat?.id,
      from_id: ctx.from?.id,
      isAdminChat: isAdminChat(ctx.chat?.id)
    });
  } catch {}
  await next();
});

bot.catch((err) => {
  console.error('[bot.catch]', err);
});

bot.command('start', async (ctx) => {
  await ctx.reply('Send me the photo you want turned into a PFP. You’ll get a DM here once it’s ready. 😺✨');
});

bot.command('help', async (ctx) => {
  await ctx.reply(
`How it works:
1) Send a photo here.
2) The creator will edit it manually.
3) You’ll receive your finished PFP back in this chat.

Admin:
• /id — show this chat id
• Just reply to the job message with the finished image
• Or send the image with the job token in the caption (e.g. "JOB-XXXXXX")`);
});

bot.command('id', async (ctx) => {
  await ctx.reply(`chat_id: ${ctx.chat.id}`);
});

// User sends image → create job and DM admin
async function handleIncomingFromUser(ctx) {
  if (isAdminChat(ctx.chat.id)) return; // skip admin chat here

  const { id: userId, name, at } = fmtUser(ctx);
  const fileId = getBestImageFileId(ctx.message);
  if (!fileId) {
    await ctx.reply('Please send a JPG/PNG as a photo or image file.');
    return;
  }

  await ctx.reply('Got it! Your PFP will be sent here soon. 😺');

  const token = mkToken();
  const caption = `New PFP request:
From: ${name} ${at}
user_id: ${userId}
token: ${token}

👉 Reply to this message with the finished image (photo or image file), OR send a new message that includes this token in the caption/text.`;

  // Send to admin; not forwarding, so reply-to works reliably
  const adminMsg = await ctx.api.sendPhoto(ADMIN_CHAT_ID, fileId, { caption });

  jobsByToken.set(token, {
    token,
    userId,
    username: at,
    userChatId: ctx.chat.id,
    userMsgId: ctx.message.message_id,
    originalFileId: fileId
  });
  tokensByAdminMsgId.set(adminMsg.message_id, token);

  console.log('[job created]', { token, adminMessageId: adminMsg.message_id, userChatId: ctx.chat.id, userId, username: at });
}

// User image handlers
bot.on('message:photo', handleIncomingFromUser);
bot.on('message:document', async (ctx) => {
  const mime = ctx.message.document?.mime_type || '';
  if (!mime.startsWith('image/')) return;
  await handleIncomingFromUser(ctx);
});

// Admin delivery helpers
function extractTokenFromText(s) {
  if (!s) return null;
  const m = s.match(/\bJOB-[A-F0-9]{6}\b/i);
  return m ? m[0].toUpperCase() : null;
}

async function deliverToUser(ctx, token, finishedFileId) {
  const job = jobsByToken.get(token);
  if (!job) {
    await ctx.reply(`Unknown job token: ${token}`);
    console.warn('[unknown token]', token);
    return;
  }
  try {
    await ctx.api.sendPhoto(job.userChatId, finishedFileId, {
      caption: `Your PFP is ready! 😺✨`
    });
    await ctx.reply(`✅ Delivered to ${job.username} (id:${job.userId}). [${token}]`);
    jobsByToken.delete(token);
    console.log('[delivered]', { token, to: job.userChatId, userId: job.userId });
  } catch (e) {
    console.error('[deliver error]', e);
    await ctx.reply('❌ Failed to deliver. User may have blocked the bot or never pressed Start.');
  }
}

async function handleAdminMedia(ctx) {
  if (!isAdminChat(ctx.chat.id)) return;

  const fileId = getBestImageFileId(ctx.message);
  if (!fileId) return; // not an image

  // Prefer reply mapping:
  const reply = ctx.message.reply_to_message;
  if (reply) {
    const token = tokensByAdminMsgId.get(reply.message_id);
    if (token) {
      await deliverToUser(ctx, token, fileId);
      return;
    }
  }

  // Else try token in caption or text
  const token = extractTokenFromText(ctx.message.caption || ctx.message.text || '');
  if (token) {
    await deliverToUser(ctx, token, fileId);
    return;
  }

  await ctx.reply('I couldn’t find a job. Please reply to the job message I sent, or include the job token (e.g. JOB-XXXXXX) in your caption.');
  console.warn('[admin media without token/reply]');
}

// Accept photo or image document from admin
bot.on('message:photo', handleAdminMedia);
bot.on('message:document', handleAdminMedia);

// Also accept text replies containing a token (so you can send token first, media next)
bot.on('message:text', async (ctx) => {
  if (!isAdminChat(ctx.chat.id)) return;
  const token = extractTokenFromText(ctx.message.text);
  if (token) {
    await ctx.reply(`Got token ${token}. Now reply with the finished image or send it in a new message with the token in caption.`);
  }
});

// Start polling
bot.start();
console.log('Bot started (polling). ADMIN_CHAT_ID:', ADMIN_CHAT_ID);

// Send a startup ping to admin so you confirm the right chat
(async () => {
  try {
    await bot.api.sendMessage(ADMIN_CHAT_ID, '👋 Bot online. Send /id here; reply to job messages or include their JOB-XXXXXX token in captions to deliver.');
    console.log('[startup ping] sent');
  } catch (e) {
    console.error('[startup ping failed] Check ADMIN_CHAT_ID (must be numeric and this chat must include the bot).', e);
  }
})();

// Health endpoint for Railway
const app = express();
app.get('/', (_, res) => res.send('OK'));
app.listen(PORT, () => console.log('Health server on :' + PORT));
