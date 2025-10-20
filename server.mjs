// server.mjs — webhook version (no polling, no 409)
import 'dotenv/config';
import express from 'express';
import { Bot, webhookCallback } from 'grammy';
import crypto from 'node:crypto';

const {
  BOT_TOKEN,
  ADMIN_CHAT_ID,
  WEBHOOK_URL,                  // e.g. https://tang-production.up.railway.app/webhook/tg
  TELEGRAM_SECRET_TOKEN = '',   // optional but recommended
  PORT = 3000
} = process.env;

if (!BOT_TOKEN) throw new Error('Missing BOT_TOKEN');
if (!ADMIN_CHAT_ID) throw new Error('Missing ADMIN_CHAT_ID (numeric)');
if (!WEBHOOK_URL) throw new Error('Missing WEBHOOK_URL (https://.../webhook/tg)');

// ---------------- State ----------------
const jobsByToken = new Map();        // token -> job
const tokensByAdminMsgId = new Map(); // adminMessageId -> token
const lastTokenByAdmin = new Map();   // adminChatId -> sticky token (from /deliver)

const isAdminChat = (id) => String(id) === String(ADMIN_CHAT_ID);
const mkToken = () => 'JOB-' + crypto.randomBytes(3).toString('hex').toUpperCase();
function fmtUser(ctx) {
  const u = ctx.from || {};
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || 'User';
  const at = u.username ? `@${u.username}` : `(id:${u.id})`;
  return { id: u.id, name, at };
}
function getBestImageFileId(msg) {
  if (msg?.photo?.length) return msg.photo[msg.photo.length - 1].file_id; // largest photo
  if (msg?.document && (msg.document.mime_type || '').startsWith('image/')) return msg.document.file_id;
  return null;
}
function extractTokenFromText(s) {
  if (!s) return null;
  const m = s.match(/\bJOB-[A-F0-9]{6}\b/i);
  return m ? m[0].toUpperCase() : null;
}
const listOpenTokens = () => Array.from(jobsByToken.keys());

// ---------------- Bot ----------------
const bot = new Bot(BOT_TOKEN);

// Loud visibility
bot.use(async (ctx, next) => {
  const kind = ctx.update?.message ? 'message'
             : ctx.update?.edited_message ? 'edited_message'
             : Object.keys(ctx.update || {}).join(',') || 'unknown';
  console.log('[update]', kind, {
    chat_id: ctx.chat?.id,
    from_id: ctx.from?.id,
    isAdminChat: isAdminChat(ctx.chat?.id),
    hasPhoto: !!ctx.message?.photo,
    hasDoc: !!ctx.message?.document
  });
  await next();
});

bot.catch((err) => console.error('[bot.catch]', err));

// Commands
bot.command('start', async (ctx) => {
  await ctx.reply('Send me the photo you want turned into a PFP. You’ll get a DM here once it’s ready. 😺✨');
});
bot.command('help', async (ctx) => {
  const extra = isAdminChat(ctx.chat.id) ? `

Admin:
• /id — show this chat id
• /list — show open job tokens
• /deliver <token> — set sticky token for next image
Delivery methods:
  1) Reply to job message with image
  2) Send image with token in caption (e.g. JOB-XXXXXX)
  3) /deliver JOB-XXXXXX, then send image
  4) If exactly one open job exists, just send the image (auto-delivers)` : '';
  await ctx.reply(
`How it works:
1) Send a photo here.
2) The creator will edit it manually.
3) You’ll receive your finished PFP back in this chat.` + extra);
});
bot.command('id', async (ctx) => ctx.reply(`chat_id: ${ctx.chat.id}`));
bot.command('list', async (ctx) => {
  if (!isAdminChat(ctx.chat.id)) return;
  const tokens = listOpenTokens();
  await ctx.reply(tokens.length ? `Open jobs:\n${tokens.map(t => '• ' + t).join('\n')}` : 'No open jobs 🎉');
});
bot.command('deliver', async (ctx) => {
  if (!isAdminChat(ctx.chat.id)) return;
  const token = extractTokenFromText(ctx.message.text || '');
  if (!token) return void ctx.reply('Usage: /deliver JOB-XXXXXX');
  if (!jobsByToken.has(token)) return void ctx.reply(`Unknown token ${token}. Try /list.`);
  lastTokenByAdmin.set(ctx.chat.id, token);
  await ctx.reply(`Sticky token set to ${token}. Now send the image (no need to reply/caption).`);
});

// ---------- Delivery helpers (admin first) ----------
async function deliverToUser(ctx, token, finishedFileId) {
  const job = jobsByToken.get(token);
  if (!job) {
    console.warn('[deliver] unknown token', token);
    return void ctx.reply(`Unknown job token: ${token}`);
  }
  try {
    console.log('[deliver] sending to user', { token, userChatId: job.userChatId });
    await ctx.api.sendPhoto(job.userChatId, finishedFileId, { caption: 'Your PFP is ready! 😺✨' });
    await ctx.reply(`✅ Delivered to ${job.username} (id:${job.userId}). [${token}]`);
    jobsByToken.delete(token);
    console.log('[delivered]', { token, to: job.userChatId, userId: job.userId });
  } catch (e) {
    console.error('[deliver error -> sendPhoto to user failed]', e);
    await ctx.reply('❌ Failed to deliver. Did the user start the bot? (They must have chatted with the bot at least once.)');
  }
}

async function handleAdminMedia(ctx) {
  if (!isAdminChat(ctx.chat.id)) return;

  const msg = ctx.message;
  const fileId = getBestImageFileId(msg);
  if (!fileId) return; // ignore non-image

  // 1) Reply mapping
  const reply = msg.reply_to_message;
  if (reply) {
    const token = tokensByAdminMsgId.get(reply.message_id);
    if (token) return void deliverToUser(ctx, token, fileId);
  }
  // 2) Token in caption/text
  const fromCaption = extractTokenFromText(msg.caption || msg.text || '');
  if (fromCaption) return void deliverToUser(ctx, fromCaption, fileId);
  // 3) Sticky token (/deliver)
  const sticky = lastTokenByAdmin.get(ctx.chat.id);
  if (sticky && jobsByToken.has(sticky)) {
    lastTokenByAdmin.delete(ctx.chat.id);
    return void deliverToUser(ctx, sticky, fileId);
  }
  // 4) If exactly one open job, auto-deliver
  const open = listOpenTokens();
  if (open.length === 1) return void deliverToUser(ctx, open[0], fileId);

  console.warn('[admin media without token/reply]');
  await ctx.reply('I couldn’t match this image to a job.\nReply to the job, include JOB-XXXXXX in caption, or /list then /deliver JOB-XXXXXX.');
}
bot.on('message:photo', handleAdminMedia);
bot.on('message:document', handleAdminMedia);

bot.on('message:text', async (ctx) => {
  if (!isAdminChat(ctx.chat.id)) return;
  const token = extractTokenFromText(ctx.message.text);
  if (token) {
    if (!jobsByToken.has(token)) return void ctx.reply(`Unknown token ${token}. Try /list.`);
    lastTokenByAdmin.set(ctx.chat.id, token);
    await ctx.reply(`Got token ${token}. Now send the finished image (no need to reply).`);
  }
});

// ---------- User handlers (second) ----------
async function handleIncomingFromUser(ctx) {
  if (isAdminChat(ctx.chat.id)) return;

  console.log('[user] incoming image in user chat', { chat: ctx.chat.id });
  const { id: userId, name, at } = fmtUser(ctx);
  const fileId = getBestImageFileId(ctx.message);
  if (!fileId) {
    console.warn('[user] no image found in message');
    return void ctx.reply('Please send a JPG/PNG as a photo or image file.');
  }

  await ctx.reply('Got it! Your PFP will be sent here soon. 😺');

  const token = mkToken();
  const caption = `New PFP request:
From: ${name} ${at}
user_id: ${userId}
token: ${token}

👉 Deliver by:
• Reply to this message with the finished image
• OR include ${token} in the caption
• OR /deliver ${token} then send the image`;

  try {
    console.log('[user] sending job to admin', { ADMIN_CHAT_ID, token });
    const adminMsg = await ctx.api.sendPhoto(ADMIN_CHAT_ID, fileId, { caption });
    jobsByToken.set(token, { token, userId, username: at, userChatId: ctx.chat.id, userMsgId: ctx.message.message_id, originalFileId: fileId });
    tokensByAdminMsgId.set(adminMsg.message_id, token);
    console.log('[job created]', { token, adminMessageId: adminMsg.message_id, userChatId: ctx.chat.id, userId, username: at });
  } catch (e) {
    console.error('[admin send error] Failed to DM admin chat. Check ADMIN_CHAT_ID & that the admin started the bot.', e);
    await ctx.reply('Sorry, I could not notify the creator. Please try again later.');
  }
}
bot.on('message:photo', handleIncomingFromUser);
bot.on('message:document', async (ctx) => {
  const mime = ctx.message.document?.mime_type || '';
  if (!mime.startsWith('image/')) return;
  await handleIncomingFromUser(ctx);
});

// ---------------- Express webhook ----------------
const app = express();
app.use(express.json({ limit: '25mb' }));

// Optional header auth
app.post('/webhook/tg', (req, res, next) => {
  if (TELEGRAM_SECRET_TOKEN) {
    const h = req.get('x-telegram-bot-api-secret-token');
    if (h !== TELEGRAM_SECRET_TOKEN) {
      console.warn('[webhook] wrong secret header');
      return res.status(401).send('Unauthorized');
    }
  }
  next();
});

// grammY express adapter
app.post('/webhook/tg', webhookCallback(bot, 'express', { webhookReply: false }));

app.get('/', (_, res) => res.send('OK'));
app.listen(PORT, async () => {
  console.log('HTTP server on :' + PORT);
  // Ensure webhook is set for this URL
  try {
    // Clear polling just in case, then set webhook
    await bot.api.deleteWebhook({ drop_pending_updates: false });
    await bot.api.setWebhook(WEBHOOK_URL, TELEGRAM_SECRET_TOKEN ? {
      secret_token: TELEGRAM_SECRET_TOKEN
    } : {});
    console.log('[webhook] set to', WEBHOOK_URL, TELEGRAM_SECRET_TOKEN ? '(with secret)' : '');
    // Startup ping to admin
    await bot.api.sendMessage(ADMIN_CHAT_ID, '👋 Bot online via webhook. You will receive job messages here.');
  } catch (e) {
    console.error('[webhook setup error]', e);
  }
});
