import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';
import { Bot, webhookCallback, InputFile } from 'grammy';
import sharp from 'sharp';

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

// ---------- helpers ----------
async function fetchBuffer(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to fetch ${url}: ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

async function tgGetFileUrl(fileId) {
  const meta = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`).then(r => r.json());
  const path = meta?.result?.file_path;
  if (!path) throw new Error('Could not resolve Telegram file_path');
  return `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${path}`;
}

// Square-crop & resize for stable AI results
async function normalizeToSquare(buf, size = SIZE) {
  const img = sharp(buf).rotate();
  const meta = await img.metadata();
  const w = meta.width || size, h = meta.height || size;
  const side = Math.min(w, h);
  const left = Math.floor((w - side) / 2);
  const top  = Math.floor((h - side) / 2);
  return await img.extract({ left, top, width: side, height: side }).resize(size, size).jpeg({ quality: 95 }).toBuffer();
}

// Fixed prompt (no user prompting)
const FIXED_PROMPT =
`You are editing a user’s profile photo using two inputs:
1) Main photo (first image).
2) Our brand mascot "logo-cat" (second image, transparent PNG).

Task:
- Place the logo-cat INTO the scene in a fun, tasteful way that fits context:
  examples: peeking from the user’s shoulder, sitting on a hat, clinging to sunglasses,
  balancing on an object, or photobombing from a pocket.
- Keep logo-cat’s design/colors faithful. Do NOT redraw or deform it.
- Do not cover more than 15% of the face. Preserve identity.
- Match scene lighting; add soft shadow/contact shadow so it feels grounded.
- No additional text or logos. Output a single square PNG.`;

// Call Gemini 2.5 Flash Image (img2img)
async function aiInsertLogoCat({ userJpegBuf, logoPngBuf, prompt, size = SIZE }) {
  const userB64 = userJpegBuf.toString('base64');
  const logoB64 = logoPngBuf.toString('base64');

  const body = {
    model: 'gemini-2.5-flash-image',
    contents: [{
      role: 'user',
      parts: [
        { text: prompt },
        { inline_data: { mime_type: 'image/jpeg', data: userB64 } },
        { inline_data: { mime_type: 'image/png',  data: logoB64 } }
      ]
    }]
  };

  const resp = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=' + GEMINI_API_KEY,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
  const json = await resp.json();

  const imgPart = json?.candidates?.[0]?.content?.parts?.find(p => p?.inline_data?.mime_type?.startsWith('image/'));
  if (!imgPart?.inline_data?.data) return null; // allow fallback
  const aiBuf = Buffer.from(imgPart.inline_data.data, 'base64');
  return await sharp(aiBuf).resize(size, size, { fit: 'cover' }).png({ compressionLevel: 9 }).toBuffer();
}

// Fallback: sticker overlay bottom-right with soft shadow
async function fallbackOverlay(userJpegOrPng, logoPng, size = SIZE) {
  const base = await sharp(userJpegOrPng).resize(size, size).png().toBuffer();
  const W = size;
  const stickerW = Math.round(W * 0.22);
  const logo = await sharp(logoPng).resize({ width: stickerW }).png().toBuffer();
  const meta = await sharp(logo).metadata();
  const pad = Math.round(W * 0.03);
  const left = W - (meta.width || stickerW) - pad;
  const top  = W - (meta.height || stickerW) - pad;

  const shadow = await sharp({
    create: { width: meta.width || stickerW, height: meta.height || stickerW, channels: 4, background: { r:0,g:0,b:0,alpha:0 } }
  }).png().toBuffer();
  const blurred = await sharp(shadow).composite([{ input: logo, blend: 'dest-in' }]).blur(5).toBuffer();

  return await sharp(base)
    .composite([
      { input: blurred, left: left + 6, top: top + 6, blend: 'over', opacity: 0.35 },
      { input: logo, left, top, blend: 'over' }
    ])
    .png({ compressionLevel: 9 }).toBuffer();
}

// ---------- bot ----------
const bot = new Bot(TELEGRAM_BOT_TOKEN);

bot.command('start', ctx => ctx.reply('Send me your PFP as a photo. I’ll add our logo-cat in a funny way and send it back!'));

bot.on('message:photo', async (ctx) => {
  try {
    await ctx.api.sendChatAction(ctx.chat.id, 'upload_photo');
    const photos = ctx.message.photo;
    const fileId = photos?.[photos.length - 1]?.file_id;
    if (!fileId) return ctx.reply('Could not read that image.');

    // 1) get user photo
    const fileUrl = await tgGetFileUrl(fileId);
    const original = await fetchBuffer(fileUrl);

    // 2) normalize + fetch logo
    const userNorm = await normalizeToSquare(original, SIZE);
    const logoBuf  = await fetchBuffer(LOGO_CAT_URL);

    // 3) AI attempt
    const aiOut = await aiInsertLogoCat({ userJpegBuf: userNorm, logoPngBuf: logoBuf, prompt: FIXED_PROMPT, size: SIZE });

    // 4) Fallback (guaranteed)
    const finalOut = aiOut || await fallbackOverlay(userNorm, logoBuf, SIZE);

    await ctx.replyWithPhoto(new InputFile(finalOut, 'pfp.png'), {
      caption: aiOut ? 'Your logo-cat PFP 😺✨' : 'AI was shy — here’s a sticker version 😺✨'
    });
  } catch (err) {
    console.error(err);
    await ctx.reply('Sorry, I couldn’t process that image. Try another photo.');
  }
});

// ---------- webhook ----------
const handler = webhookCallback(bot, 'express', {
  secretToken: TELEGRAM_SECRET_TOKEN || undefined,
});

app.post('/webhook/tg', (req, res) => {
  if (TELEGRAM_SECRET_TOKEN && req.get('x-telegram-bot-api-secret-token') !== TELEGRAM_SECRET_TOKEN) {
    return res.status(401).send('Unauthorized');
  }
  return handler(req, res);
});

// health check
app.get('/', (_, res) => res.send('OK'));
app.listen(PORT, () => console.log('Bot listening on :' + PORT));
