'use strict';

/**
 * Recepción Autopilot — Core Mensajería (Node/Express)
 *
 * ✅ WhatsApp via Twilio        -> /twilio/webhook (firma X-Twilio-Signature)  [RECOMENDADO]
 * ✅ WhatsApp Cloud API (Meta)  -> /webhook (firma X-Hub-Signature-256)        [OPCIONAL]
 */

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

app.use(helmet());
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 240,
  standardHeaders: true,
  legacyHeaders: false
}));

const {
  PORT = '3000',

  // Twilio
  TWILIO_AUTH_TOKEN,

  // Meta (opcional)
  META_VERIFY_TOKEN,
  META_APP_SECRET,
  WA_ACCESS_TOKEN,
  WA_PHONE_NUMBER_ID
} = process.env;

const STARTED_AT = Date.now();

function timingSafeEq(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function log(level, msg, extra) {
  const base = { ts: new Date().toISOString(), level, msg };
  if (extra) Object.assign(base, extra);
  console.log(JSON.stringify(base));
}

app.get('/health', (_req, res) => {
  res.status(200).json({
    ok: true,
    uptime_s: Math.floor((Date.now() - STARTED_AT) / 1000)
  });
});

// ========================================================
// 1) TWILIO WhatsApp Webhook  (/twilio/webhook)
//    - Recibe x-www-form-urlencoded
//    - Valida X-Twilio-Signature (HMAC-SHA1 base64)
//    - Responde TwiML (2-vías inmediato)
// ========================================================

function publicUrl(req) {
  // Twilio valida con URL exacta (proto+host+path+query). En Render usamos x-forwarded-*.
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https')
    .toString().split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.get('host') || '')
    .toString().split(',')[0].trim();
  return `${proto}://${host}${req.originalUrl}`;
}

function buildTwilioSignature(url, params, authToken) {
  const keys = Object.keys(params || {}).sort();
  let data = url;
  for (const k of keys) data += k + (params[k] ?? '');
  return crypto.createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

function validateTwilioRequest(req) {
  const sig = (req.header('x-twilio-signature') || '').trim();
  if (!sig) return false;
  if (!TWILIO_AUTH_TOKEN) return false;

  const url = publicUrl(req);
  const expected = buildTwilioSignature(url, req.body || {}, TWILIO_AUTH_TOKEN);
  return timingSafeEq(expected, sig);
}

function twimlMessage(text) {
  const escaped = String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Message>${escaped}</Message></Response>`;
}

app.post('/twilio/webhook',
  express.urlencoded({ extended: false }),
  (req, res) => {
    const ok = validateTwilioRequest(req);

    if (!ok) {
      log('warn', 'twilio_invalid_signature', { has_sig: !!req.header('x-twilio-signature') });
      return res.status(401).send('invalid_signature');
    }

    const from = req.body.From || '';
    const body = (req.body.Body || '').toString();
    const msgSid = req.body.MessageSid || '';

    log('info', 'twilio_inbound', {
      msgSid,
      from,
      body_preview: body.slice(0, 140)
    });

    const normalized = body.trim().toLowerCase();

    let reply =
      'Perfecto. Decime qué querés hacer:\n' +
      '1) Sacar turno\n' +
      '2) Reprogramar\n' +
      '3) Cancelar\n' +
      '4) Hablar con recepción';

    if (normalized === '1' || normalized.includes('turno')) {
      reply = 'Genial. ¿Para qué servicio? (Ej: Consulta / Control / Eco / Holter)';
    } else if (normalized === '2' || normalized.includes('repro')) {
      reply = 'Listo. Pasame la fecha/hora del turno actual y te doy opciones nuevas.';
    } else if (normalized === '3' || normalized.includes('cancel')) {
      reply = 'Ok. Pasame la fecha/hora del turno y lo cancelo. Si querés, te ofrezco otro.';
    } else if (normalized === '4' || normalized.includes('humano') || normalized.includes('recep')) {
      reply = 'Dale. Te paso con recepción. (Demo: por ahora te atiende el sistema y luego escalamos).';
    }

    res.set('Content-Type', 'text/xml');
    return res.status(200).send(twimlMessage(reply));
  }
);

// ========================================================
// 2) META WhatsApp Cloud API Webhook (/webhook) (opcional)
// ========================================================

function verifyMetaSignature(rawBodyBuffer, signatureHeader, appSecret) {
  if (!signatureHeader || typeof signatureHeader !== 'string') return false;
  if (!signatureHeader.startsWith('sha256=')) return false;

  const ours = 'sha256=' + crypto
    .createHmac('sha256', appSecret)
    .update(rawBodyBuffer)
    .digest('hex');

  return timingSafeEq(ours, signatureHeader);
}

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === META_VERIFY_TOKEN) {
    log('info', 'meta_webhook_verified');
    return res.status(200).send(challenge);
  }

  log('warn', 'meta_webhook_verify_failed', { mode, token_present: !!token });
  return res.sendStatus(403);
});

app.post('/webhook',
  express.raw({ type: '*/*', limit: '2mb' }),
  async (req, res) => {
    if (!META_APP_SECRET) {
      log('warn', 'missing_META_APP_SECRET');
      return res.status(500).send('server_misconfigured');
    }

    const sig = req.header('x-hub-signature-256');
    if (!verifyMetaSignature(req.body, sig, META_APP_SECRET)) {
      log('warn', 'meta_invalid_signature', { sig_present: !!sig });
      return res.status(401).send('invalid_signature');
    }

    let payload;
    try {
      payload = JSON.parse(req.body.toString('utf8'));
    } catch {
      log('warn', 'meta_invalid_json');
      return res.status(400).send('invalid_json');
    }

    res.sendStatus(200);

    try {
      await handleMetaInbound(payload);
    } catch (e) {
      log('error', 'meta_handle_inbound_failed', { err: String(e?.message || e) });
    }
  }
);

async function handleMetaInbound(payload) {
  const entries = payload?.entry;
  if (!Array.isArray(entries)) return;

  for (const entry of entries) {
    const changes = entry?.changes;
    if (!Array.isArray(changes)) continue;

    for (const change of changes) {
      const messages = change?.value?.messages;
      if (!Array.isArray(messages)) continue;

      for (const m of messages) {
        const msgId = m.id;
        const from = m.from;
        const text = m.text?.body ? String(m.text.body) : '';

        log('info', 'meta_inbound_message', {
          msgId,
          from,
          text_preview: text.slice(0, 140)
        });

        await metaAutoReply(from, text);
      }
    }
  }
}

async function metaAutoReply(toWaId, userText) {
  if (!WA_ACCESS_TOKEN || !WA_PHONE_NUMBER_ID) {
    log('warn', 'meta_outbound_not_configured', { to: toWaId });
    return;
  }

  const normalized = (userText || '').trim().toLowerCase();

  let reply =
    'Perfecto. Decime qué querés hacer:\n' +
    '1) Sacar turno\n' +
    '2) Reprogramar\n' +
    '3) Cancelar\n' +
    '4) Hablar con recepción';

  if (normalized === '1' || normalized.includes('turno')) {
    reply = 'Genial. ¿Para qué servicio? (Ej: Consulta / Control / Eco / Holter)';
  } else if (normalized === '2' || normalized.includes('repro')) {
    reply = 'Listo. Pasame la fecha/hora del turno actual y te doy opciones nuevas.';
  } else if (normalized === '3' || normalized.includes('cancel')) {
    reply = 'Ok. Pasame la fecha/hora del turno y lo cancelo. Si querés, te ofrezco otro.';
  } else if (normalized === '4' || normalized.includes('humano') || normalized.includes('recep')) {
    reply = 'Dale. Te paso con recepción. (Demo: por ahora te atiende el sistema y luego escalamos).';
  }

  const url = `https://graph.facebook.com/v20.0/${WA_PHONE_NUMBER_ID}/messages`;
  const body = {
    messaging_product: 'whatsapp',
    to: toWaId,
    type: 'text',
    text: { body: reply }
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${WA_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    let j = {};
    try { j = await resp.json(); } catch {}
    log('error', 'meta_outbound_failed', { status: resp.status, err: j });
    return;
  }

  log('info', 'meta_outbound_sent', { to: toWaId });
}

// Start + shutdown
const port = Number(PORT);
const server = app.listen(port, '0.0.0.0', () => {
  log('info', 'server_started', { port });
});

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

function shutdown(sig) {
  log('info', 'shutdown_start', { sig });
  server.close(() => {
    log('info', 'shutdown_done');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 8000).unref();
}
