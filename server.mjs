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

const FIXED_PROMPT =
`Blend and harmonize the mascot placed in this photo:
- Keep the plush "logo-cat" mascot intact (no redraw, no recolor).
- Match scene lighting and add/adjust a soft contact shadow so it feels grounded.
- Clean edges and integrate slightly with surroundings for a natural look.
- No extra text or logos. Photoreal output. Square PNG.`;

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
  const resp = await fetchWithTimeout(url, {}, timeoutMs);
  if (!resp.ok) throw new Error(`Failed to fetch buffer: ${resp.status} ${resp.statusText}`);
  return Buffer.from(await resp.arrayBuffer());
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
  return await img.extract({ left, top, width: side, height: side }).resize(size, size).png().toBuffer();
}

// Load logo PNG (from remote) with simple cache
let _logoCache = null;
async function getLogoBuffer() {
  if (_logoCache) return _logoCache;
  _logoCache = await fetchBuffer(LOGO_CAT_URL, 15000);
  return _logoCache;
}

// Deterministic-ish placement
function pickCornerRotation(width, height) {
  const corners = [
    { name: 'tl', left: 0,        top: 0,         anchor: 'nw' },
    { name: 'tr', left: width,    top: 0,         anchor: 'ne' },
    { name: 'bl', left: 0,        top: height,    anchor: 'sw' },
    { name: 'br', left: width,    top: height,    anchor: 'se' },
  ];
  const idx = Math.floor(Math.random() * corners.length);
  const rot = (Math.random() * 14) - 7; // -7..+7 deg
  return { ...corners[idx], rotation: rot };
}

async function placeMascotDraft(baseBuf, logoBuf, size) {
  // scale mascot to ~28% of width
  const scale = Math.max(0.22, Math.min(0.32, 0.28 + (Math.random() - 0.5) * 0.06));
  const base = sharp(baseBuf).png();

  const { width, height } = await base.metadata();
  const logoW = Math.floor((width || size) * scale);

  const logoResized = await sharp(logoBuf).resize({ width: logoW }).png().toBuffer();
  const lrMeta = await sharp(logoResized).metadata();
  const lrW = lrMeta.width || logoW;
  const lrH = lrMeta.height || logoW;

  const corner = pickCornerRotation(width || size, height || size);

  const margin = Math.floor((width || size) * 0.05);
  let left = margin, top = margin;
  if (corner.name === 'tr') left = (width || size) - lrW - margin;
  if (corner.name === 'br') { left = (width || size) - lrW - margin; top = (height || size) - lrH - margin; }
  if (corner.name === 'bl') top = (height || size) - lrH - margin;

  const rotated = await sharp(logoResized)
    .rotate(corner.rotation, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  const rotMeta = await sharp(rotated).metadata();
  const rw = rotMeta.width || lrW;
  const rh = rotMeta.height || lrH;

  // Soft shadow
  const shadow = await sharp(rotated)
    .linear(1, 0)
    .modulate({ brightness: 0.2 })
    .blur(4)
    .png()
    .toBuffer();

  const composited = await sharp(baseBuf)
    .composite([
      { input: shadow, left, top },
      { input: rotated, left, top },
    ])
    .png()
    .toBuffer();

  // Mask: solid except a transparent hole around mascot (+ padding)
  const padPx = Math.floor(Math.max(rw, rh) * 0.06);
  const rect = { left, top, w: rw, h: rh };

  const mask = await sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 1 } // keep region
    }
  }).png().toBuffer();

  const hole = await sharp({
    create: {
      width: Math.max(1, rect.w + padPx * 2),
      height: Math.max(1, rect.h + padPx * 2),
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 } // editable region
    }
  }).png().toBuffer();

  const leftHole = Math.max(0, rect.left - padPx);
  const topHole  = Math.max(0, rect.top  - padPx);

  const finalMask = await sharp(mask)
    .composite([{ input: hole, left: leftHole, top: topHole }])
    .png()
    .toBuffer();

  return { composited, mask: finalMask };
}

/* --------------------------- OpenAI Images Edit --------------------------- */
async function openaiBlendMascotHTTP({ draftPngBuf, maskPngBuf, prompt, size }) {
  if (!USE_OPENAI) return null;

  const form = new FormData();
  form.append('model', 'gpt-image-1');
  form.append('prompt', prompt);
  form.append('size', `${size}x${size}`);
  form.append('n', '1');
  // form.append('response_format', 'b64_json'); // removed: no longer accepted
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
    }, 30000);

    if (!resp.ok) {
      const text = await resp.text();
      console.warn('[OpenAI edits non-OK]', resp.status, text.slice(0, 1200));
      return null;
    }

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

bot.on('message:photo', async (ctx) => {
  try {
    const waitMsg = await ctx.reply('Working on your PFP…');

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

    // 2) Local draft + mask (AI size)
    const { composited: draftFull, mask } = await placeMascotDraft(userNormAI, logoBuf, AI_IN_SIZE);

    // 3) Try OpenAI blend (two short attempts), else fallback
    let finalOut = null;
    if (USE_OPENAI) {
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

    // 4) Fallback: high-res local sticker composite
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
// Correct grammY signature: adapter name 'express' + options object
const handler = webhookCallback(
  bot,
  'express',
  {
    secretToken: TELEGRAM_SECRET_TOKEN || undefined,
    webhookReply: false,
    timeoutMilliseconds: 10000
  }
);

// Mount middleware directly; grammY handles secret token check internally
app.post('/webhook/tg', handler);

app.get('/', (_, res) => res.send('OK'));
app.listen(PORT, () => console.log('Bot listening on :' + PORT));
