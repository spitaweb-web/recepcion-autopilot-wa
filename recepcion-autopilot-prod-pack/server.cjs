'use strict';

/**
 * Recepción Autopilot — Core Mensajería (Node/Express)
 *
 * ✅ WhatsApp via Twilio        -> /twilio/webhook (firma X-Twilio-Signature)
 * ✅ WhatsApp Cloud API (Meta)  -> /webhook  y /api/whatsapp (firma X-Hub-Signature-256 si hay APP_SECRET)
 *
 * CEPA Pack:
 * - Menú claro
 * - Servicios reales
 * - Info (horarios, dirección, obras sociales, estudios)
 * - Link directo a MrTurno
 * - Handoff a humano por keyword o opción 4
 * - /privacidad listo para publish
 */

const fs = require('fs');
const path = require('path');

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

  // Meta
  META_VERIFY_TOKEN,
  WA_VERIFY_TOKEN,        // alias (Render)
  META_APP_SECRET,
  WA_APP_SECRET,          // alias (Render)

  WA_ACCESS_TOKEN,
  WA_PHONE_NUMBER_ID
} = process.env;

const VERIFY_TOKEN = WA_VERIFY_TOKEN || META_VERIFY_TOKEN || '';
const APP_SECRET = META_APP_SECRET || WA_APP_SECRET || '';

const STARTED_AT = Date.now();

// -------------------- Config CEPA --------------------
function loadConfig() {
  const tryPaths = [
    path.join(process.cwd(), 'cepa.config.json'),
    path.join(__dirname, 'cepa.config.json')
  ];
  for (const p of tryPaths) {
    try {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {}
  }
  // fallback mínimo (por si falta el archivo)
  return {
    clinic: {
      name: 'CEPA Centro Médico',
      short: 'CEPA',
      address: 'Luján de Cuyo, Mendoza',
      hours: 'Lunes a sábados 07:30 a 21:00',
      booking_url: 'https://www.mrturno.com/m/@cepa',
      contact: { email: '', tel: '' }
    },
    prepagas: [],
    studies: [],
    services_menu: [{ key: 'A', label: 'Consulta' }, { key: 'B', label: 'Estudio' }, { key: 'C', label: 'Otro' }],
    handoff_keywords: ['recepcion', 'humano', 'secretaria'],
    deposit: { enabled: false, amount_ars: 0, note: '' }
  };
}

const CFG = loadConfig();

// -------------------- Util --------------------
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

function digitsOnly(x) {
  return String(x || '').replace(/\D/g, '');
}

function menuText() {
  return [
    `Hola 👋 Soy el asistente de turnos de *${CFG.clinic.short}*.`,
    `¿Qué necesitás?`,
    `1) Sacar turno`,
    `2) Reprogramar / Cancelar`,
    `3) Info (horarios, dirección, obras sociales, estudios)`,
    `4) Hablar con recepción`
  ].join('\n');
}

function servicesText() {
  const lines = [`Perfecto. ¿Para qué servicio? (Respondé con una letra o escribilo)`];
  for (const s of CFG.services_menu) lines.push(`${s.key}) ${s.label}`);
  return lines.join('\n');
}

function infoText() {
  const prepagas = (CFG.prepagas || []).slice(0, 10).join(' · ');
  const studies = (CFG.studies || []).slice(0, 10).join(' · ');
  return [
    `📍 *${CFG.clinic.name}*`,
    `${CFG.clinic.address}`,
    `🕒 ${CFG.clinic.hours}`,
    ``,
    `Turnos online: ${CFG.clinic.booking_url}`,
    `Tel: ${CFG.clinic.contact.tel || '-'}`,
    `Email: ${CFG.clinic.contact.email || '-'}`,
    CFG.clinic.contact.whatsapp_alt ? `WhatsApp alternativo: ${CFG.clinic.contact.whatsapp_alt}` : null,
    ``,
    prepagas ? `Obras sociales / prepagas (parcial): ${prepagas}` : null,
    studies ? `Estudios (parcial): ${studies}` : null
  ].filter(Boolean).join('\n');
}

function depositLine() {
  const d = CFG.deposit || { enabled: false };
  if (!d.enabled) return d.note ? `🧾 Seña: ${d.note}` : null;
  const amt = Number(d.amount_ars || 0);
  const formatted = amt ? `$${amt.toLocaleString('es-AR')}` : '';
  return `🧾 Seña: ${formatted}. ${d.note || ''}`.trim();
}

function shouldHandoff(text) {
  const x = String(text || '').toLowerCase();
  return (CFG.handoff_keywords || []).some(k => x.includes(String(k).toLowerCase()));
}

function looksLikeCoverage(t) {
  const x = String(t || '').toLowerCase();
  if (x.includes('part')) return 'Particular';
  if (x.includes('obra') || x.includes('prep') || x.includes('osde') || x.includes('swiss') || x.includes('galeno') || x.includes('medife')) {
    return 'Obra social / Prepaga';
  }
  return null;
}

// -------------------- Sesiones (simple in-memory) --------------------
const sessions = new Map(); // waId -> session

function getSession(waId) {
  if (!sessions.has(waId)) {
    sessions.set(waId, {
      step: 'menu',
      service: null,
      coverage: null,
      timepref: null,
      startedAt: Date.now(),
      handoff: false
    });
  }
  return sessions.get(waId);
}

function resetSession(s) {
  s.step = 'menu';
  s.service = null;
  s.coverage = null;
  s.timepref = null;
  s.handoff = false;
}

function buildSummary(s) {
  const lines = [
    `Listo ✅`,
    `Resumen:`,
    `• Servicio: ${s.service || '-'}`,
    `• Cobertura: ${s.coverage || '-'}`,
    `• Preferencia: ${s.timepref || '-'}`,
    ``,
    `Para confirmar el turno:`,
    `👉 ${CFG.clinic.booking_url}`
  ];
  const d = depositLine();
  if (d) lines.push('', d);
  lines.push('', `Si querés hablar con recepción: escribí *4*.`);
  return lines.join('\n');
}

/**
 * Motor conversacional único (Twilio + Meta)
 */
function handleInboundText(waId, textRaw) {
  const s = getSession(waId);
  const text = String(textRaw || '').trim();
  const key = text.toUpperCase();

  // Handoff directo
  if (key === '4' || shouldHandoff(text)) {
    s.handoff = true;
    s.step = 'menu';
    return `Perfecto. Te paso con recepción 👤\nDejá tu *nombre* + qué necesitás y te responden en breve.`;
  }

  // Volver al menú
  if (key === 'MENU' || key === 'MENÚ' || key === '0') {
    resetSession(s);
    return menuText();
  }

  if (s.step === 'menu') {
    if (key === '1' || text.toLowerCase().includes('turno')) {
      s.step = 'service';
      return servicesText();
    }
    if (key === '2' || text.toLowerCase().includes('repro') || text.toLowerCase().includes('cancel')) {
      resetSession(s);
      return `Ok. Para reprogramar/cancelar, usá MrTurno:\n👉 ${CFG.clinic.booking_url}\n\nSi no podés, escribí *4* y te pasa recepción.`;
    }
    if (key === '3' || text.toLowerCase().includes('info') || text.toLowerCase().includes('horar') || text.toLowerCase().includes('obra')) {
      return infoText();
    }
    return menuText();
  }

  if (s.step === 'service') {
    const match = (CFG.services_menu || []).find(x => String(x.key).toUpperCase() === key);
    s.service = match ? match.label : text;
    s.step = 'coverage';
    return `Genial. ¿Es *Particular* u *Obra social / Prepaga*?`;
  }

  if (s.step === 'coverage') {
    s.coverage = looksLikeCoverage(text) || text;
    s.step = 'timepref';
    return `Perfecto. ¿Qué día y horario te sirve más? (Ej: "viernes 10–12" / "mañana por la tarde")`;
  }

  if (s.step === 'timepref') {
    s.timepref = text;
    const out = buildSummary(s);
    resetSession(s);
    return out;
  }

  resetSession(s);
  return menuText();
}

// -------------------- Health / Home / Privacidad --------------------
app.get('/health', (_req, res) => {
  res.status(200).json({
    ok: true,
    uptime_s: Math.floor((Date.now() - STARTED_AT) / 1000),
    clinic: CFG.clinic?.short || 'CEPA'
  });
});

app.get('/', (_req, res) => {
  res.status(200).send(`OK — Recepción Autopilot (${CFG.clinic?.short || 'CEPA'})`);
});

app.get('/privacidad', (_req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(`
<!doctype html>
<html><head><meta charset="utf-8"><title>Privacidad - Recepción Autopilot</title></head>
<body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;max-width:820px;margin:40px auto;line-height:1.5">
<h1>Política de Privacidad</h1>
<p>Esta aplicación procesa mensajes de WhatsApp únicamente para gestionar consultas y turnos del centro médico.</p>
<ul>
  <li>No vendemos datos.</li>
  <li>Usamos la información mínima necesaria para responder y derivar a recepción.</li>
  <li>Podés solicitar eliminación escribiendo "BAJA" o contactando al centro.</li>
</ul>
<p><strong>Contacto:</strong> ${CFG.clinic?.contact?.email || '-'}</p>
</body></html>`);
});

// ========================================================
// 1) TWILIO WhatsApp Webhook  (/twilio/webhook)
// ========================================================

function publicUrl(req) {
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

    const from = req.body.From || ''; // "whatsapp:+549..."
    const body = (req.body.Body || '').toString();
    const msgSid = req.body.MessageSid || '';

    log('info', 'twilio_inbound', {
      msgSid,
      from,
      body_preview: body.slice(0, 140)
    });

    const waId = digitsOnly(from); // para unificar sesión
    const reply = handleInboundText(waId, body);

    res.set('Content-Type', 'text/xml');
    return res.status(200).send(twimlMessage(reply));
  }
);

// ========================================================
// 2) META WhatsApp Cloud API Webhook (/webhook y /api/whatsapp)
// ========================================================

function verifyMetaSignature(rawBodyBuffer, signatureHeader, appSecret) {
  if (!appSecret) return true; // si no hay secret, no bloqueamos (pero logueamos)
  if (!signatureHeader || typeof signatureHeader !== 'string') return false;
  if (!signatureHeader.startsWith('sha256=')) return false;

  const ours = 'sha256=' + crypto
    .createHmac('sha256', appSecret)
    .update(rawBodyBuffer)
    .digest('hex');

  return timingSafeEq(ours, signatureHeader);
}

function metaVerifyHandler(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    log('info', 'meta_webhook_verified');
    return res.status(200).send(challenge);
  }

  log('warn', 'meta_webhook_verify_failed', { mode, token_present: !!token });
  return res.sendStatus(403);
}

app.get('/webhook', metaVerifyHandler);
app.get('/api/whatsapp', metaVerifyHandler);

async function metaInboundHandler(req, res) {
  const sig = req.header('x-hub-signature-256');

  if (!APP_SECRET) log('warn', 'missing_APP_SECRET_signature_check_disabled');
  if (!verifyMetaSignature(req.body, sig, APP_SECRET)) {
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

  // responder rápido
  res.sendStatus(200);

  try {
    await handleMetaInbound(payload);
  } catch (e) {
    log('error', 'meta_handle_inbound_failed', { err: String(e?.message || e) });
  }
}

app.post('/webhook', express.raw({ type: '*/*', limit: '2mb' }), metaInboundHandler);
app.post('/api/whatsapp', express.raw({ type: '*/*', limit: '2mb' }), metaInboundHandler);

function extractTextFromMetaMessage(m) {
  if (!m) return '';
  if (m.text?.body) return String(m.text.body);
  if (m.button?.text) return String(m.button.text);
  if (m.interactive?.button_reply?.title) return String(m.interactive.button_reply.title);
  if (m.interactive?.list_reply?.title) return String(m.interactive.list_reply.title);
  return '';
}

async function handleMetaInbound(payload) {
  const entries = payload?.entry;
  if (!Array.isArray(entries)) return;

  for (const entry of entries) {
    const changes = entry?.changes;
    if (!Array.isArray(changes)) continue;

    for (const change of changes) {
      const value = change?.value;

      // ignorar statuses (no responder)
      if (Array.isArray(value?.statuses) && !Array.isArray(value?.messages)) {
        continue;
      }

      const messages = value?.messages;
      if (!Array.isArray(messages)) continue;

      for (const m of messages) {
        const msgId = m.id;
        const from = digitsOnly(m.from);
        const text = extractTextFromMetaMessage(m);

        log('info', 'meta_inbound_message', {
          msgId,
          from,
          text_preview: String(text).slice(0, 140)
        });

        const reply = handleInboundText(from, text);
        await metaSendText(from, reply);
      }
    }
  }
}

async function metaSendText(toWaId, bodyText) {
  if (!WA_ACCESS_TOKEN || !WA_PHONE_NUMBER_ID) {
    log('warn', 'meta_outbound_not_configured', { to: toWaId });
    return;
  }

  const url = `https://graph.facebook.com/v22.0/${WA_PHONE_NUMBER_ID}/messages`;
  const body = {
    messaging_product: 'whatsapp',
    to: String(toWaId),
    type: 'text',
    text: { body: String(bodyText).slice(0, 3900) } // evitar overflow
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

  const j = await resp.json();
  log('info', 'meta_outbound_sent', { to: toWaId, message_id: j?.messages?.[0]?.id });
}

// Start + shutdown
const port = Number(PORT);
const server = app.listen(port, '0.0.0.0', () => {
  log('info', 'server_started', { port, clinic: CFG?.clinic?.short || 'CEPA' });
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
