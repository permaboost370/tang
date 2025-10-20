// server.mjs
import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';
import { Bot, webhookCallback, InputFile } from 'grammy';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';

const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_SECRET_TOKEN,
  GEMINI_API_KEY,
  LOGO_CAT_URL,
  OUTPUT_SIZE = '1024',
  PORT = 3000,
} = process.env;

if (!TELEGRAM_BOT_TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN');
if (!GEMINI_API_KEY) throw new Error('Missing GEMINI_API_KEY');
if (!LOGO_CAT_URL) throw new Error('Missing LOGO_CAT_URL');

const SIZE = parseInt(OUTPUT_SIZE, 10) || 1024;

const app = express();
app.use(express.json({ limit: '25mb' }));

/* --------------------------------- Helpers -------------------------------- */

async function fetchBuffer(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to fetch ${url}: ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// Support both remote URL and local file (LOGO_CAT_URL=file://assets/logo-cat.png)
async function getLogoBuffer() {
  const url = LOGO_CAT_URL;
  if (url.startsWith('file://')) {
    const rel = url.replace('file://', '');
    const full = path.join(process.cwd(), rel);
    return await fs.readFile(full);
  }
  return await fetchBuffer(url);
}

async function tgGetFileUrl(fileId) {
  const meta = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`
  ).then(r => r.json());
  const filePath = meta?.result?.file_path;
  if (!filePath) throw new Error('Could not resolve Telegram file_path');
  return `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`;
}

// Square-crop & resize for stable AI results
async function normalizeToSquare(buf, size = SIZE) {
  const img = sharp(buf).rotate(); // auto-orient
  const meta = await img.metadata();
  const w = meta.width || size;
  const h = meta.height || size;
  const side = Math.min(w, h);
  const left = Math.floor((w - side) / 2);
  const top = Math.floor((h - side) / 2);
  return await img
    .extract({ left, top, width: side, height: side })
    .resize(size, size)
    .jpeg({ quality: 95 })
    .toBuffer();
}

/* ------------------------------- Fixed Prompt ------------------------------ */
// Safer, single prompt (users don't type prompts)
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
// Requests explicit PNG response; logs first KB of non-image replies; tries a backup model.
async function aiInsertLogoCat({ userJpegBuf, logoPngBuf, prompt, size = SIZE }) {
  const userB64 = userJpegBuf.toString('base64');
  const logoB64 = logoPngBuf.toString('base64');

  const modelCandidates = [
    'gemini-2.5-flash-image',
    'gemini-2.0-flash', // backup that often accepts image parts too
  ];

  for (const model of modelCandidates) {
    const body = {
      model,
      generationConfig: {
        output_mime_type: 'image/png',
      },
      contents: [{
        role: 'user',
        parts: [
          { text: prompt },
          { inline_data: { mime_type: 'image/jpeg', data: userB64 } }, // main photo
          { inline_data: { mime_type: 'image/png',  data: logoB64 } }, // logo-cat
        ],
      }],
    };

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const json = await resp.json();

    const imgPart = json?.candidates?.[0]?.content?.parts?.find(
      p => p?.inline_data?.mime_type?.startsWith('image/')
    );

    if (!imgPart?.inline_data?.data) {
      console.warn('[Gemini response - no image from]', model, JSON.stringify(json).slice(0, 1200));
      continue; // try the next model
    }

    const aiBuf = Buffer.from(imgPart.inline_data.data, 'base64');
    return await sharp(aiBuf)
      .resize(size, size, { fit: 'cover' })
      .png({ compressionLevel: 9 })
      .toBuffer();
  }

  return null; // signal fallback
}

/* --------------------------- Smarter Fallback Stamp ------------------------ */
function pickAnchor(W, H, stickerW, stickerH, pad) {
  const anchors = [
    { name: 'bottom-right', left: W - stickerW - pad, top: H - stickerH - pad },
    { name: 'bottom-left',  left: pad,                top: H - stickerH - pad },
    { name: 'top-right',    left: W - stickerW - pad, top: pad },
    { name: 'top-left',     left: pad,                top: pad },
  ];
  return anchors[Math.floor(Math.random() * anchors.length)];
}

async function fallbackOverlay(userJpegOrPng, logoPng, size = SIZE) {
  const base = await sharp(userJpegOrPng).resize(size, size).png().toBuffer();
  const W = size, H = size;

  // Reasonable random scale (18–24% of width)
  const stickerW = Math.round(W * (0.18 + Math.random() * 0.06));
  const logo = await sharp(logoPng).resize({ width: stickerW }).png().toBuffer();
  const { width: lw = stickerW, height: lh = stickerW } = await sharp(logo).metadata();

  const pad = Math.round(W * 0.035);
  const anchor = pickAnchor(W, H, lw, lh, pad);

  // Small rotation for personality
  const rotateDeg = (Math.random() * 10 - 5); // -5..+5 degrees
  const rotated = await sharp(logo)
    .rotate(rotateDeg, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const metaR = await sharp(rotated).metadata();

  // Soft contact shadow shaped like the sticker
  const shadow = await sharp({
    create: {
      width: metaR.width || lw,
      height: metaR.height || lh,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: rotated, blend: 'dest-in' }])
    .blur(6)
    .png()
    .toBuffer();

  return await sharp(base)
    .composite([
      { input: shadow,  left: anchor.left + 6, top: anchor.top + 6, opacity: 0.35, blend: 'over' },
      { input: rotated, left: anchor.left,     top: anchor.top,     blend: 'over' },
    ])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/* --------------------------------- Bot ------------------------------------ */

const bot = new Bot(TELEGRAM_BOT_TOKEN);

bot.command('start', ctx =>
  ctx.reply('Send me your PFP as a photo. I’ll add our logo-cat in a funny way and send it back!'),
);

bot.on('message:photo', async (ctx) => {
  try {
    await ctx.api.sendChatAction(ctx.chat.id, 'upload_photo');

    const photos = ctx.message.photo;
    const fileId = photos?.[photos.length - 1]?.file_id;
    if (!fileId) return ctx.reply('Could not read that image.');

    // 1) Download user photo
    const fileUrl = await tgGetFileUrl(fileId);
    const original = await fetchBuffer(fileUrl);

    // 2) Normalize + load logo
    const userNorm = await normalizeToSquare(original, SIZE);
    const logoBuf  = await getLogoBuffer();

    // 3) Try AI
    const aiOut = await aiInsertLogoCat({
      userJpegBuf: userNorm,
      logoPngBuf : logoBuf,
      prompt     : FIXED_PROMPT,
      size       : SIZE,
    });

    // 4) Fallback (guaranteed result)
    const finalOut = aiOut || await fallbackOverlay(userNorm, logoBuf, SIZE);

    await ctx.replyWithPhoto(new InputFile(finalOut, 'pfp.png'), {
      caption: aiOut ? 'Your logo-cat PFP 😺✨' : 'AI was shy — here’s a sticker version 😺✨',
    });
  } catch (err) {
    console.error(err);
    await ctx.reply('Sorry, I couldn’t process that image. Try another photo.');
  }
});

/* ------------------------------- Webhook/HTTP ------------------------------ */

const handler = webhookCallback(bot, 'express', {
  secretToken: TELEGRAM_SECRET_TOKEN || undefined,
});

app.post('/webhook/tg', (req, res) => {
  if (TELEGRAM_SECRET_TOKEN && req.get('x-telegram-bot-api-secret-token') !== TELEGRAM_SECRET_TOKEN) {
    return res.status(401).send('Unauthorized');
  }
  return handler(req, res);
});

app.get('/', (_, res) => res.send('OK'));

app.listen(PORT, () => console.log('Bot listening on :' + PORT));
