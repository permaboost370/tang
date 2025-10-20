// server.mjs
import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';
import { Bot, webhookCallback, InputFile } from 'grammy';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

/* ----------------------------- Global Handlers ---------------------------- */
process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));
process.on('uncaughtException',  (err)    => console.error('[uncaughtException]', err));

/* --------------------------------- ENV ----------------------------------- */
const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_SECRET_TOKEN,
  GEMINI_API_KEY,
  LOGO_CAT_URL,
  OUTPUT_SIZE = '1024',
  AI_INPUT_SIZE = '640',   // smaller image sent to AI to reduce tokens/latency
  PORT = 3000,
} = process.env;

if (!TELEGRAM_BOT_TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN');
if (!GEMINI_API_KEY) throw new Error('Missing GEMINI_API_KEY');
if (!LOGO_CAT_URL) throw new Error('Missing LOGO_CAT_URL');

const SIZE = parseInt(OUTPUT_SIZE, 10) || 1024;
const AI_IN_SIZE = parseInt(AI_INPUT_SIZE, 10) || 640;

/* ------------------------------- App Setup -------------------------------- */
const app = express();
app.use(express.json({ limit: '25mb' }));

/* ------------------------------- Utilities -------------------------------- */
async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}
async function fetchBuffer(url, timeoutMs = 30000) {
  const r = await fetchWithTimeout(url, {}, timeoutMs);
  if (!r.ok) throw new Error(`Failed to fetch ${url}: ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

let LOGO_BUF_CACHE = null;
async function getLogoBuffer() {
  if (LOGO_BUF_CACHE) return LOGO_BUF_CACHE;
  if (LOGO_CAT_URL.startsWith('file://')) {
    const rel = LOGO_CAT_URL.replace('file://', '');
    LOGO_BUF_CACHE = await fs.readFile(path.join(process.cwd(), rel));
  } else {
    LOGO_BUF_CACHE = await fetchBuffer(LOGO_CAT_URL, 20000);
  }
  return LOGO_BUF_CACHE;
}

async function tgGetFileUrl(fileId) {
  const meta = await fetchWithTimeout(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`,
    {}, 15000
  ).then(r => r.json());
  const filePath = meta?.result?.file_path;
  if (!filePath) throw new Error('Could not resolve Telegram file_path');
  return `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`;
}

// Square-crop & resize
async function normalizeToSquare(buf, size) {
  const img = sharp(buf).rotate();
  const meta = await img.metadata();
  const w = meta.width || size, h = meta.height || size;
  const side = Math.min(w, h);
  const left = Math.floor((w - side) / 2);
  const top  = Math.floor((h - side) / 2);
  return img.extract({ left, top, width: side, height: side }).resize(size, size).jpeg({ quality: 95 }).toBuffer();
}

/* ------------------------------- Fixed Prompt ------------------------------ */
const FIXED_PROMPT =
`You are editing a user’s profile photo using two inputs:
1) Main photo (first image).
2) Our plush "logo-cat" mascot (second image, transparent PNG).

Task:
- Place the logo-cat INTO the scene in a playful, tasteful way that fits the context:
  examples: peeking from the user’s shoulder, sitting on a hat, clinging to sunglasses,
  balancing on an object, or photobombing from a pocket or edge of the frame.
- Keep the mascot’s shape and colors faithful (do NOT redraw or deform it).
- Do not cover more than 15% of the face. Preserve identity.
- Match scene lighting and add a soft contact shadow so it feels grounded.
- No extra text or additional logos. Output a single square PNG.`;

/* ------------------------------ AI Integration ----------------------------- */
async function callGeminiImage({ userJpegBuf, logoPngBuf, prompt, size }) {
  const body = {
    model: 'gemini-2.5-flash-image',
    contents: [{
      role: 'user',
      parts: [
        { text: prompt },
        { inline_data: { mime_type: 'image/jpeg', data: userJpegBuf.toString('base64') } },
        { inline_data: { mime_type: 'image/png',  data: logoPngBuf.toString('base64') } }
      ]
    }]
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${GEMINI_API_KEY}`;
  const resp = await fetchWithTimeout(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }, 25000);

  const json = await resp.json();

  // Quota/rate limit
  if (json?.error?.status === 'RESOURCE_EXHAUSTED' || json?.error?.code === 429) {
    console.warn('[Gemini quota]', json?.error?.message || json?.error);
    return null;
  }

  // No image
  const imgPart = json?.candidates?.[0]?.content?.parts?.find(p => p?.inline_data?.mime_type?.startsWith('image/'));
  if (!imgPart?.inline_data?.data) {
    console.warn('[Gemini response - no image]', JSON.stringify(json).slice(0, 1200));
    return null;
  }

  const aiBuf = Buffer.from(imgPart.inline_data.data, 'base64');
  return sharp(aiBuf).resize(size, size, { fit: 'cover' }).png({ compressionLevel: 9 }).toBuffer();
}

// Try AI up to 25s, with a quick retry if we get a non-image finish reason
async function aiInsertLogoCat({ userJpegBuf, logoPngBuf, prompt, size }) {
  // attempt 1 (up to 12s)
  const t1 = await Promise.race([
    callGeminiImage({ userJpegBuf, logoPngBuf, prompt, size }),
    sleep(12000).then(() => null)
  ]);
  if (t1) return t1;

  // brief backoff then attempt 2 (up to 12s)
  await sleep(1200);
  const t2 = await Promise.race([
    callGeminiImage({ userJpegBuf, logoPngBuf, prompt, size }),
    sleep(12000).then(() => null)
  ]);
  return t2; // may be null; caller will fallback
}

/* --------------------------- Smarter Fallback Stamp ------------------------ */
function pickAnchor(W, H, stickerW, stickerH, pad) {
  const anchors = [
    { left: W - stickerW - pad, top: H - stickerH - pad },
    { left: pad,                top: H - stickerH - pad },
    { left: W - stickerW - pad, top: pad },
    { left: pad,                top: pad }
  ];
  return anchors[Math.floor(Math.random() * anchors.length)];
}
async function fallbackOverlay(userJpegOrPng, logoPng, size) {
  const base = await sharp(userJpegOrPng).resize(size, size).png().toBuffer();
  const W = size, H = size;

  const stickerW = Math.round(W * (0.18 + Math.random() * 0.06));
  const logo = await sharp(logoPng).resize({ width: stickerW }).png().toBuffer();
  const { width: lw = stickerW, height: lh = stickerW } = await sharp(logo).metadata();

  const pad = Math.round(W * 0.035);
  const anchor = pickAnchor(W, H, lw, lh, pad);

  const rotateDeg = (Math.random() * 10 - 5);
  const rotated = await sharp(logo).rotate(rotateDeg, { background: { r:0,g:0,b:0,alpha:0 } }).png().toBuffer();
  const metaR = await sharp(rotated).metadata();

  const shadow = await sharp({
    create: { width: metaR.width || lw, height: metaR.height || lh, channels: 4, background: { r:0,g:0,b:0,alpha:0 } }
  }).composite([{ input: rotated, blend: 'dest-in' }]).blur(6).png().toBuffer();

  return sharp(base)
    .composite([
      { input: shadow,  left: anchor.left + 6, top: anchor.top + 6, opacity: 0.35, blend: 'over' },
      { input: rotated, left: anchor.left,     top: anchor.top,     blend: 'over' }
    ])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/* --------------------------------- Bot ------------------------------------ */
const bot = new Bot(TELEGRAM_BOT_TOKEN);

bot.command('start', (ctx) =>
  ctx.reply('Send me your photo and I’ll sneak our logo-cat into it 😺')
);

bot.on('message:photo', async (ctx) => {
  console.log('[webhook] start', { chat: ctx.chat?.id, msg: ctx.message?.message_id });
  try {
    const waitMsg = await ctx.reply('Logo-cat is getting into character… 🐱✨');

    const photos = ctx.message.photo;
    const fileId = photos?.[photos.length - 1]?.file_id;
    if (!fileId) {
      await ctx.api.editMessageText(ctx.chat.id, waitMsg.message_id, 'Could not read that image. Try sending as a photo (not file).');
      return;
    }

    const fileUrl = await tgGetFileUrl(fileId);
    const original = await fetchBuffer(fileUrl, 20000);

    const [userNormAI, userNormOut, logoBuf] = await Promise.all([
      normalizeToSquare(original, AI_IN_SIZE),
      normalizeToSquare(original, SIZE),
      getLogoBuffer()
    ]);

    // Try AI up to ~25s total (2 attempts). Webhook already returned 200, so no timeout.
    let aiOut = await aiInsertLogoCat({
      userJpegBuf: userNormAI,
      logoPngBuf : logoBuf,
      prompt     : FIXED_PROMPT,
      size       : SIZE
    });

    const finalOut = aiOut || await fallbackOverlay(userNormOut, logoBuf, SIZE);

    await ctx.replyWithPhoto(new InputFile(finalOut, 'pfp.png'), {
      caption: aiOut ? 'Here’s your AI-placed logo-cat 😺✨' : 'AI was shy — here’s a quick sticker version 😺✨'
    });

    // clean up the waiting message
    try { await ctx.api.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch {}
    console.log('[webhook] done { ai:', !!aiOut, '}');
  } catch (err) {
    console.error(err);
    try { await ctx.reply('Sorry, something went wrong. Try another photo.'); } catch {}
  }
});

/* ------------------------------- Webhook/HTTP ------------------------------ */
// Decouple replies from webhook so HTTP returns instantly
const handler = webhookCallback(bot, 'express', {
  secretToken: TELEGRAM_SECRET_TOKEN || undefined,
  webhookReply: false,
  timeoutMilliseconds: 1500 // return 200 quickly
});

app.post('/webhook/tg', (req, res) => {
  if (TELEGRAM_SECRET_TOKEN && req.get('x-telegram-bot-api-secret-token') !== TELEGRAM_SECRET_TOKEN) {
    return res.status(401).send('Unauthorized');
  }
  return handler(req, res);
});

app.get('/', (_, res) => res.send('OK'));
app.listen(PORT, () => console.log('Bot listening on :' + PORT));
