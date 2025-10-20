// server.mjs
import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';
import { Bot, webhookCallback, InputFile } from 'grammy';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import FormData from 'form-data';

/* ----------------------------- Global Handlers ---------------------------- */
process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));
process.on('uncaughtException',  (err)    => console.error('[uncaughtException]', err));

/* --------------------------------- ENV ----------------------------------- */
const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_SECRET_TOKEN,
  LOGO_CAT_URL,
  OPENAI_API_KEY,
  PROVIDER = '',
  OUTPUT_SIZE = '1024',
  AI_INPUT_SIZE = '640',   // smaller canvas for fast placement/blending
  PORT = 3000,
} = process.env;

if (!TELEGRAM_BOT_TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN');
if (!LOGO_CAT_URL) throw new Error('Missing LOGO_CAT_URL');

const SIZE = parseInt(OUTPUT_SIZE, 10) || 1024;
const AI_IN_SIZE = parseInt(AI_INPUT_SIZE, 10) || 640;

const USE_OPENAI = (PROVIDER || '').toUpperCase() === 'OPENAI' && !!OPENAI_API_KEY;

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
`Blend and harmonize the mascot placed in this photo:
- Keep the plush "logo-cat" mascot intact (no redraw, no recolor).
- Match scene lighting and add/adjust a soft contact shadow so it feels grounded.
- Clean edges and integrate slightly with surroundings for a natural look.
- No extra text or logos. Photoreal output. Square PNG.`;

/* --------------------- Sticker Placement (deterministic) ------------------- */
function pickAnchor(W, H, stickerW, stickerH, pad) {
  const anchors = [
    { left: W - stickerW - pad, top: H - stickerH - pad }, // bottom-right
    { left: pad,                top: H - stickerH - pad }, // bottom-left
    { left: W - stickerW - pad, top: pad },                // top-right
    { left: pad,                top: pad }                 // top-left
  ];
  return anchors[Math.floor(Math.random() * anchors.length)];
}

/**
 * Returns { composited, rect }
 * - composited: Buffer PNG with mascot placed
 * - rect: { left, top, w, h } — placement rect (used to generate mask)
 */
async function placeMascotDraft(userBuf, logoBuf, size) {
  const base = await sharp(userBuf).resize(size, size).png().toBuffer();
  const W = size, H = size;

  const stickerW = Math.round(W * (0.20 + Math.random() * 0.05)); // 20–25% width
  const logo = await sharp(logoBuf).resize({ width: stickerW }).png().toBuffer();
  const { width: lw = stickerW, height: lh = stickerW } = await sharp(logo).metadata();

  const pad = Math.round(W * 0.035);
  const anchor = pickAnchor(W, H, lw, lh, pad);
  const rotateDeg = (Math.random() * 10 - 5);

  const rotated = await sharp(logo)
    .rotate(rotateDeg, { background: { r:0, g:0, b:0, alpha:0 } })
    .png()
    .toBuffer();
  const metaR = await sharp(rotated).metadata();
  const rect = { left: anchor.left, top: anchor.top, w: metaR.width || lw, h: metaR.height || lh };

  const shadow = await sharp({
    create: { width: rect.w, height: rect.h, channels: 4, background: { r:0,g:0,b:0,alpha:0 } }
  })
  .composite([{ input: rotated, blend: 'dest-in' }])
  .blur(6)
  .png()
  .toBuffer();

  const composited = await sharp(base)
    .composite([
      { input: shadow,  left: rect.left + 6, top: rect.top + 6, opacity: 0.35, blend: 'over' },
      { input: rotated, left: rect.left,     top: rect.top,     blend: 'over' }
    ])
    .png({ compressionLevel: 9 })
    .toBuffer();

  return { composited, rect };
}

/* ------------------------- Mask for OpenAI Image Edits --------------------- */
// Mask: transparent = editable area, opaque = keep. Must match base dimensions.
async function makeRectMask(width, height, rect, padPx = 16) {
  const mask = await sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } // keep
  }).png().toBuffer();

  const hole = await sharp({
    create: {
      width: Math.max(1, rect.w + padPx * 2),
      height: Math.max(1, rect.h + padPx * 2),
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 } // editable region
    }
  }).png().toBuffer();

  const left = Math.max(0, rect.left - padPx);
  const top  = Math.max(0, rect.top  - padPx);

  return sharp(mask)
    .composite([{ input: hole, left, top }])
    .png()
    .toBuffer();
}

/* --------------------------- OpenAI Images: /edits ------------------------- */
/**
 * Calls OpenAI Images Edit API via multipart (no SDK helper needed).
 * Base = draft image with mascot; Mask = rect around mascot; Prompt = blend instructions.
 */
async function openaiBlendMascotHTTP({ draftPngBuf, maskPngBuf, prompt, size }) {
  if (!USE_OPENAI) return null;

  // Build multipart
  const form = new FormData();
  form.append('model', 'gpt-image-1');
  form.append('prompt', prompt);
  form.append('size', `${size}x${size}`);
  form.append('n', '1');
  form.append('response_format', 'b64_json');
  form.append('image', draftPngBuf, { filename: 'base.png', contentType: 'image/png' });
  form.append('mask',  maskPngBuf,  { filename: 'mask.png', contentType: 'image/png' });

  try {
    const resp = await fetchWithTimeout('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        ...form.getHeaders()
      },
      body: form
    }, 25000);

    const json = await resp.json();
    const b64 = json?.data?.[0]?.b64_json;
    if (!b64) {
      console.warn('[OpenAI edits response]', JSON.stringify(json).slice(0, 1200));
      return null;
    }
    const out = Buffer.from(b64, 'base64');
    return await sharp(out).resize(size, size).png().toBuffer();
  } catch (e) {
    console.warn('[OpenAI edits error]', e?.response?.data || e?.message || e);
    return null;
  }
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

    // 1) Download + normalize
    const fileUrl = await tgGetFileUrl(fileId);
    const original = await fetchBuffer(fileUrl, 20000);

    const [userNormAI, userNormOut, logoBuf] = await Promise.all([
      normalizeToSquare(original, AI_IN_SIZE),
      normalizeToSquare(original, SIZE),
      getLogoBuffer()
    ]);

    // 2) Deterministic, fast placement (always succeeds)
    const { composited: draftSmall, rect } = await placeMascotDraft(userNormAI, logoBuf, AI_IN_SIZE);

    // 3) If OpenAI enabled, upscale draft, build mask and ask it to blend
    let finalOut = null;
    if (USE_OPENAI) {
      const draftFull = await sharp(draftSmall).resize(SIZE, SIZE).png().toBuffer();

      // scale rect from AI_IN_SIZE to SIZE
      const scale = SIZE / AI_IN_SIZE;
      const rectFull = {
        left: Math.round(rect.left * scale),
        top : Math.round(rect.top  * scale),
        w   : Math.round(rect.w    * scale),
        h   : Math.round(rect.h    * scale),
      };
      const mask = await makeRectMask(SIZE, SIZE, rectFull, 18);

      // try up to ~20s total (two attempts)
      const tryOnce = () => openaiBlendMascotHTTP({
        draftPngBuf: draftFull, maskPngBuf: mask, prompt: FIXED_PROMPT, size: SIZE
      });
      const ai1 = await Promise.race([ tryOnce(), sleep(12000).then(() => null) ]);
      finalOut = ai1;
      if (!finalOut) {
        await sleep(1000);
        const ai2 = await Promise.race([ tryOnce(), sleep(8000).then(() => null) ]);
        finalOut = ai2;
      }
    }

    // 4) If OpenAI blending didn’t return, fall back to high-res sticker comp
    if (!finalOut) {
      const { composited } = await placeMascotDraft(userNormOut, logoBuf, SIZE);
      finalOut = composited;
    }

    await ctx.replyWithPhoto(new InputFile(finalOut, 'pfp.png'), {
      caption: USE_OPENAI ? 'Here’s your Tang PFP' : 'Here’s your logo-cat 😺✨'
    });

    try { await ctx.api.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch {}
    console.log('[webhook] done { openai:', USE_OPENAI, ' }');
  } catch (err) {
    console.error(err);
    try { await ctx.reply('Sorry, something went wrong. Try another photo.'); } catch {}
  }
});

/* ------------------------------- Webhook/HTTP ------------------------------ */
// Decouple replies from webhook = instant 200 OK
const handler = webhookCallback(bot, 'express', {
  secretToken: TELEGRAM_SECRET_TOKEN || undefined,
  webhookReply: false,
  timeoutMilliseconds: 1500
});

app.post('/webhook/tg', (req, res) => {
  if (TELEGRAM_SECRET_TOKEN && req.get('x-telegram-bot-api-secret-token') !== TELEGRAM_SECRET_TOKEN) {
    return res.status(401).send('Unauthorized');
  }
  return handler(req, res);
});

app.get('/', (_, res) => res.send('OK'));
app.listen(PORT, () => console.log('Bot listening on :' + PORT));
