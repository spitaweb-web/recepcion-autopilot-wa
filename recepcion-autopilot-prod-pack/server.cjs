'use strict';

/**
 * Recepción Autopilot — CEPA (WhatsApp Cloud API) — Node/Express (PROD)
 * Webhook verify + messages: /api/whatsapp (alias /webhook)
 *
 * ✅ Menú + NLU simple (keywords) + fallback "no entendí"
 * ✅ Flujo real: MrTurno -> "LISTO" -> seña $10.000 -> comprobante -> cierre
 * ✅ Adjuntos: image/document -> registra "media_id" + avisa a recepción interna
 * ✅ Config por env: monto seña, si aplica, número interno para notificaciones
 */

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

app.use(helmet());
app.use(rateLimit({ windowMs: 60 * 1000, max: 240, standardHeaders: true, legacyHeaders: false }));

const {
  PORT = '3000',
  GRAPH_VERSION = 'v22.0',

  // WhatsApp Cloud API
  WA_VERIFY_TOKEN,
  WA_ACCESS_TOKEN,
  WA_PHONE_NUMBER_ID,

  // Recomendado: firma X-Hub-Signature-256
  META_APP_SECRET,

  // Anti no-show (regla simple, fácil de cambiar)
  DEPOSIT_AMOUNT = '10000', // ARS
  DEPOSIT_REQUIRED = 'true', // true/false

  // Notificación interna (tu WA o el de recepción)
  // formato: 549261xxxxxxx (sin +)
  RECEPTION_NOTIFY_TO = '',
} = process.env;

const STARTED_AT = Date.now();
const DEPOSIT_AMOUNT_NUM = Number(String(DEPOSIT_AMOUNT).replace(/[^\d]/g, '')) || 10000;
const DEPOSIT_REQUIRED_BOOL = String(DEPOSIT_REQUIRED).toLowerCase() === 'true';

// ----------------- utils -----------------
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

function normalize(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function verifyMetaSignature(rawBodyBuffer, signatureHeader, appSecret) {
  // En PROD real: si hay secret, exigimos firma válida
  if (!appSecret) return true;

  if (!signatureHeader || typeof signatureHeader !== 'string') return false;
  if (!signatureHeader.startsWith('sha256=')) return false;

  const ours =
    'sha256=' +
    crypto.createHmac('sha256', appSecret).update(rawBodyBuffer).digest('hex');

  return timingSafeEq(ours, signatureHeader);
}

async function sendText(toWaId, text) {
  if (!WA_ACCESS_TOKEN || !WA_PHONE_NUMBER_ID) {
    log('warn', 'wa_outbound_not_configured', {
      has_WA_ACCESS_TOKEN: !!WA_ACCESS_TOKEN,
      has_WA_PHONE_NUMBER_ID: !!WA_PHONE_NUMBER_ID,
    });
    return { ok: false, reason: 'missing_env' };
  }

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${WA_PHONE_NUMBER_ID}/messages`;
  const body = {
    messaging_product: 'whatsapp',
    to: toWaId,
    type: 'text',
    text: { body: text },
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WA_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    let j = {};
    try { j = await resp.json(); } catch {}
    log('error', 'wa_outbound_failed', { status: resp.status, err: j });
    return { ok: false, status: resp.status, err: j };
  }

  const data = await resp.json();
  log('info', 'wa_outbound_sent', { to: toWaId, msg_id: data?.messages?.[0]?.id });
  return { ok: true, data };
}

async function notifyReception(text) {
  if (!RECEPTION_NOTIFY_TO) return;
  try {
    await sendText(RECEPTION_NOTIFY_TO, text);
  } catch (e) {
    log('warn', 'notify_reception_failed', { err: String(e?.message || e) });
  }
}

// ----------------- CEPA config -----------------
const CEPA = {
  name: 'CEPA Consultorios (Luján)',
  address: 'Constitución 46, Luján de Cuyo, Mendoza',
  hours: 'Lunes a sábados · 07:30 a 21:00',
  email: 'cepadiagnosticomedicointegral@gmail.com',
  phone: '261-4987007',
  whatsapp: '2613640994',
  mrturno: 'https://www.mrturno.com/m/@cepa',
  disclaimer: 'Si es una urgencia, no uses este chat: llamá al 107 o acudí a guardia.',
};

// Prioridad (lo que pediste “ordenado”): lo más volumétrico y transaccional arriba
// 1) Estudios -> 2) Especialidades -> 3) Estética -> 4) OS -> 5) Info -> 6) Humano
const MENU = [
  '1) Estudios (eco, doppler, ECG, laboratorio, etc.)',
  '2) Sacar turno (especialidades)',
  '3) Estética',
  '4) Obras sociales / prepagas',
  '5) Dirección y horarios',
  '6) Hablar con recepción',
  '0) Menú',
];

// Estudios (los que más “mueven caja” suelen ser: eco/doppler/holter/mamo/lab)
const STUDIES = [
  { n: '1', label: 'Ecografía / Eco 5D', kw: ['eco', 'ecografia', '5d'] },
  { n: '2', label: 'Doppler / Ecodoppler / Ecocardiograma Doppler', kw: ['doppler', 'ecodoppler', 'ecocardiograma'] },
  { n: '3', label: 'Holter', kw: ['holter'] },
  { n: '4', label: 'ECG', kw: ['ecg', 'electro'] },
  { n: '5', label: 'Laboratorio (análisis)', kw: ['laboratorio', 'analisis', 'sangre'] },
  { n: '6', label: 'Mamografía', kw: ['mamo', 'mamografia'] },
  { n: '7', label: 'MAPA / Presurometría', kw: ['mapa', 'presion', 'presuro'] },
  { n: '8', label: 'Ergometría', kw: ['ergo', 'ergometria'] },
  { n: '9', label: 'Audiometría / BERA / OEA', kw: ['audio', 'audiometria', 'bera', 'oea', 'imped'] },
  { n: '10', label: 'Otro (escribilo)', kw: [] },
];

const SPECIALTIES = [
  { n: '1', label: 'Ginecología / Obstetricia', kw: ['gine', 'obste', 'pap', 'papanico', 'colpo'] },
  { n: '2', label: 'Pediatría', kw: ['pedi', 'nino', 'niño', 'infantil'] },
  { n: '3', label: 'Clínica médica / Medicina familiar', kw: ['clinica', 'general', 'familia'] },
  { n: '4', label: 'Cardiología', kw: ['cardio', 'corazon'] },
  { n: '5', label: 'Dermatología', kw: ['derma', 'piel'] },
  { n: '6', label: 'Traumatología', kw: ['trauma', 'rodilla', 'hueso'] },
  { n: '7', label: 'Otra (escribí el nombre)', kw: [] },
];

const ESTETICA = [
  'Rejuvenecimiento facial',
  'Mesoterapia (facial/corporal/capilar)',
  'Plasma rico en plaquetas (PRP)',
  'Botox',
  'Ácido hialurónico',
  'Hilos tensores',
  'Dermapen / Peeling / Punta de diamante',
  'Celulitis / grasa localizada',
  'Criocirugía / electrocoagulación cutánea',
];

// ----------------- sessions (simple, in-memory) -----------------
/**
 * state:
 *  - menu
 *  - choose_study
 *  - choose_specialty
 *  - waiting_reserved_confirmation   (user debe decir LISTO)
 *  - waiting_receipt                (esperando comprobante)
 */
const sessions = new Map();

function getSession(waId) {
  return sessions.get(waId) || { state: 'menu', intent: null, lastLabel: null, updatedAt: Date.now() };
}

function setSession(waId, patch) {
  const cur = getSession(waId);
  const next = { ...cur, ...patch, updatedAt: Date.now() };
  sessions.set(waId, next);
  return next;
}

function resetSession(waId) {
  sessions.set(waId, { state: 'menu', intent: null, lastLabel: null, updatedAt: Date.now() });
}

// Limpieza simple (evita memoria eterna)
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions.entries()) {
    if (now - (v.updatedAt || 0) > 1000 * 60 * 45) sessions.delete(k); // 45 min
  }
}, 1000 * 60 * 10).unref();

// ----------------- copy / UX -----------------
function menuText() {
  return (
`Hola 👋 Soy la recepción automática de ${CEPA.name}.
Elegí una opción (respondé con un número):

${MENU.join('\n')}

${CEPA.disclaimer}`
  );
}

function infoContacto() {
  return (
`📍 ${CEPA.address}
🕒 ${CEPA.hours}
📞 Tel: ${CEPA.phone}
🟢 Turnos WhatsApp: ${CEPA.whatsapp}
✉️ ${CEPA.email}`
  );
}

function studiesPrompt() {
  return (
`Perfecto. ¿Qué estudio necesitás?

${STUDIES.map(s => `${s.n}) ${s.label}`).join('\n')}

0) Menú`
  );
}

function specialtiesPrompt() {
  return (
`Perfecto. ¿Para qué especialidad?

${SPECIALTIES.map(s => `${s.n}) ${s.label}`).join('\n')}

0) Menú`
  );
}

function mrturnoStep(label) {
  // “cierre real” en dos pasos:
  // 1) ir a MrTurno
  // 2) volver con LISTO
  return (
`Listo ✅ ${label ? `(${label})\n\n` : ''}Reservá tu turno acá:
${CEPA.mrturno}

Cuando lo tengas, respondé **LISTO** y seguimos por acá.`
  );
}

function depositRequestText() {
  // sin inventar link de pago: pedimos comprobante y recepción valida.
  // Si después decidís integrar pago real, esto queda encapsulado.
  return (
`Perfecto ✅

Para confirmar y evitar ausencias, la seña es de **$${DEPOSIT_AMOUNT_NUM.toLocaleString('es-AR')}**.
📎 Por favor, enviá el **comprobante** (foto o PDF) por este chat.

Cuando lo envíes, te confirmo recepción y queda registrado.`
  );
}

function finalOkText() {
  return (
`Recibido ✅ Ya quedó registrado.

Si necesitás cambiar o cancelar, escribí **reprogramar** o **cancelar** y te guío.
Gracias.`
  );
}

function noEntendiText() {
  return (
`Te entiendo 🙌 pero no llegué a identificar qué necesitás.

Respondé con un número del menú (1–6) o escribí:
- “turno”
- “estudio” (eco, doppler, holter…)
- “dirección”
- “obras sociales”
- “recepción”`
  );
}

function findByNumberOrKeyword(norm, list) {
  for (const it of list) {
    if (norm === it.n) return it;
  }
  for (const it of list) {
    if (it.kw && it.kw.some(k => norm.includes(k))) return it;
  }
  return null;
}

// ----------------- core handler -----------------
async function handleTextMessage(from, text) {
  const norm = normalize(text);

  // global shortcuts
  if (norm === '0' || norm === 'menu' || norm === 'inicio' || norm === 'hola') {
    resetSession(from);
    return sendText(from, menuText());
  }

  if (norm.includes('direccion') || norm.includes('ubic') || norm.includes('horario')) {
    resetSession(from);
    return sendText(from, infoContacto());
  }

  if (norm.includes('obra') || norm.includes('prepaga') || norm.includes('osde') || norm.includes('swiss')) {
    resetSession(from);
    return sendText(from, `Decime cuál obra social/prepaga tenés y te confirmo si la recibimos.`);
  }

  if (norm.includes('recep') || norm.includes('humano') || norm.includes('persona')) {
    resetSession(from);
    await notifyReception(`🟡 [Handoff solicitado]\nPaciente: ${from}\nMensaje: ${text}`);
    return sendText(from, `Listo ✅ Te paso con recepción. Contame en 1 línea qué necesitás (estudio/especialidad + día preferido).`);
  }

  // if user says LISTO after MrTurno
  if (norm === 'listo') {
    const s = getSession(from);
    // Si venía de reservar
    if (s.state === 'waiting_reserved_confirmation') {
      if (DEPOSIT_REQUIRED_BOOL) {
        setSession(from, { state: 'waiting_receipt' });
        return sendText(from, depositRequestText());
      }
      resetSession(from);
      await notifyReception(`✅ [MrTurno confirmado sin seña]\nPaciente: ${from}\nServicio: ${s.lastLabel || 'N/D'}`);
      return sendText(from, `Perfecto ✅ Ya quedó.\nSi necesitás ayuda, escribí “recepción”.`);
    }

    // si dice LISTO sin contexto:
    return sendText(from, `Perfecto ✅ ¿Qué reservaste?\nDecime “estudio” o “turno” y te guío.`);
  }

  const session = getSession(from);

  // menu state
  if (session.state === 'menu') {
    // números del menú
    if (norm === '1') {
      setSession(from, { state: 'choose_study' });
      return sendText(from, studiesPrompt());
    }
    if (norm === '2') {
      setSession(from, { state: 'choose_specialty' });
      return sendText(from, specialtiesPrompt());
    }
    if (norm === '3') {
      resetSession(from);
      return sendText(from, `Estética (algunos tratamientos):\n• ${ESTETICA.join('\n• ')}\n\n¿Querés turno? Escribí “turno” y te mando el link.`);
    }
    if (norm === '4') {
      resetSession(from);
      return sendText(from, `Decime qué obra social/prepaga tenés y te confirmo si la recibimos.`);
    }
    if (norm === '5') {
      resetSession(from);
      return sendText(from, infoContacto());
    }
    if (norm === '6') {
      resetSession(from);
      await notifyReception(`🟡 [Handoff solicitado]\nPaciente: ${from}\nMensaje: ${text}`);
      return sendText(from, `Dale ✅ Contame en 1 línea qué necesitás (estudio/especialidad + día preferido).`);
    }

    // NLU simple desde menú
    if (norm.includes('turno') || norm.includes('especialidad') || norm.includes('medico')) {
      setSession(from, { state: 'choose_specialty' });
      return sendText(from, specialtiesPrompt());
    }
    if (norm.includes('estudio') || norm.includes('eco') || norm.includes('doppler') || norm.includes('holter') || norm.includes('laboratorio')) {
      setSession(from, { state: 'choose_study' });
      return sendText(from, studiesPrompt());
    }

    return sendText(from, noEntendiText());
  }

  // choose study
  if (session.state === 'choose_study') {
    if (norm === '0') return (resetSession(from), sendText(from, menuText()));

    const match = findByNumberOrKeyword(norm, STUDIES);
    if (!match) return sendText(from, `No lo reconocí 🙌\n\n${studiesPrompt()}`);

    // "Otro"
    if (match.n === '10') {
      setSession(from, { state: 'choose_study', intent: 'study_other' });
      return sendText(from, `Perfecto. Escribí el estudio exacto (ej: radiología, espirometría, poligrafía, etc.).`);
    }

    // si venía de "otro" y ahora escribió texto libre:
    if (session.intent === 'study_other' && norm.length >= 3) {
      const label = `Estudio: ${text}`;
      setSession(from, { state: 'waiting_reserved_confirmation', intent: null, lastLabel: label });
      return sendText(from, mrturnoStep(label));
    }

    const label = `Estudio: ${match.label}`;
    setSession(from, { state: 'waiting_reserved_confirmation', lastLabel: label });
    return sendText(from, mrturnoStep(label));
  }

  // choose specialty
  if (session.state === 'choose_specialty') {
    if (norm === '0') return (resetSession(from), sendText(from, menuText()));

    const match = findByNumberOrKeyword(norm, SPECIALTIES);
    if (!match) return sendText(from, `No lo reconocí 🙌\n\n${specialtiesPrompt()}`);

    if (match.n === '7') {
      setSession(from, { state: 'choose_specialty', intent: 'spec_other' });
      return sendText(from, `Perfecto. Escribí la especialidad exacta (ej: urología, ORL, oftalmología, psicología, nutrición...).`);
    }

    if (session.intent === 'spec_other' && norm.length >= 3) {
      const label = `Especialidad: ${text}`;
      setSession(from, { state: 'waiting_reserved_confirmation', intent: null, lastLabel: label });
      return sendText(from, mrturnoStep(label));
    }

    const label = `Especialidad: ${match.label}`;
    setSession(from, { state: 'waiting_reserved_confirmation', lastLabel: label });
    return sendText(from, mrturnoStep(label));
  }

  // waiting for receipt (comprobante)
  if (session.state === 'waiting_receipt') {
    // si escribe texto en vez de adjuntar:
    if (norm.includes('no tengo') || norm.includes('despues') || norm.includes('luego')) {
      return sendText(from, `Ok. Cuando lo tengas, enviá el comprobante por acá y lo registramos ✅`);
    }
    return sendText(from, `Dale ✅ Enviame el comprobante (foto o PDF) por este chat y lo dejo registrado.`);
  }

  // fallback total
  resetSession(from);
  return sendText(from, menuText()));
}

// ---- media handler (image/document) ----
async function handleMediaMessage(from, msg) {
  const s = getSession(from);

  const mediaId =
    msg?.image?.id ||
    msg?.document?.id ||
    null;

  const mime =
    msg?.image?.mime_type ||
    msg?.document?.mime_type ||
    null;

  const filename =
    msg?.document?.filename ||
    null;

  log('info', 'wa_media_received', { from, mediaId, mime, filename });

  // Si estamos esperando comprobante, esto cierra el flujo
  if (s.state === 'waiting_receipt') {
    resetSession(from);

    await notifyReception(
      `✅ [Comprobante recibido]\nPaciente: ${from}\nServicio: ${s.lastLabel || 'N/D'}\nmedia_id: ${mediaId || 'N/D'}\n${filename ? `archivo: ${filename}\n` : ''}monto: $${DEPOSIT_AMOUNT_NUM.toLocaleString('es-AR')}`
    );

    return sendText(from, finalOkText());
  }

  // Si manda un archivo sin contexto:
  await notifyReception(`📎 [Archivo sin contexto]\nPaciente: ${from}\nmedia_id: ${mediaId || 'N/D'}\n${filename ? `archivo: ${filename}` : ''}`);
  return sendText(from, `Recibido ✅ ¿Esto es un comprobante de seña?\nSi sí, respondé “sí” y te pido el dato del turno. Si no, escribí qué necesitás.`);
}

// ----------------- webhook -----------------
app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true, uptime_s: Math.floor((Date.now() - STARTED_AT) / 1000) });
});

function verifyHandler(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  log('info', 'wa_verify_attempt', { mode, token_present: !!token, expected_present: !!WA_VERIFY_TOKEN });

  if (mode === 'subscribe' && token && WA_VERIFY_TOKEN && token === WA_VERIFY_TOKEN) {
    log('info', 'wa_webhook_verified');
    return res.status(200).send(challenge);
  }

  log('warn', 'wa_webhook_verify_failed', { mode });
  return res.sendStatus(403);
}

async function postHandler(req, res) {
  const sig = req.header('x-hub-signature-256');
  const okSig = verifyMetaSignature(req.body, sig, META_APP_SECRET);

  if (!META_APP_SECRET) log('warn', 'missing_META_APP_SECRET_signature_not_verified');
  if (!okSig) {
    log('warn', 'wa_invalid_signature', { sig_present: !!sig });
    return res.status(401).send('invalid_signature');
  }

  let payload;
  try {
    payload = JSON.parse(req.body.toString('utf8'));
  } catch {
    log('warn', 'wa_invalid_json');
    return res.status(400).send('invalid_json');
  }

  // Respond fast
  res.sendStatus(200);

  try {
    const entry = payload?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    // statuses -> ignore
    if (value?.statuses?.length) {
      log('info', 'wa_status_update', { status: value.statuses[0]?.status });
      return;
    }

    const msg = value?.messages?.[0];
    if (!msg) return;

    const from = msg.from;

    // text
    if (msg.type === 'text') {
      const text = msg?.text?.body ? String(msg.text.body) : '';
      log('info', 'wa_inbound', { from, text_preview: text.slice(0, 140) });

      if (!text.trim()) {
        resetSession(from);
        await sendText(from, menuText());
        return;
      }

      await handleTextMessage(from, text);
      return;
    }

    // image/doc receipt
    if (msg.type === 'image' || msg.type === 'document') {
      await handleMediaMessage(from, msg);
      return;
    }

    // other message types
    await sendText(from, `Te leo perfecto ✅\nPara avanzar, mandame texto (ej: “eco doppler”, “turno”, “dirección”) o el comprobante si corresponde.`);
  } catch (e) {
    log('error', 'wa_handle_failed', { err: String(e?.message || e) });
  }
}

app.get('/api/whatsapp', verifyHandler);
app.get('/webhook', verifyHandler);

app.post('/api/whatsapp', express.raw({ type: '*/*', limit: '2mb' }), postHandler);
app.post('/webhook', express.raw({ type: '*/*', limit: '2mb' }), postHandler);

// ----------------- start -----------------
const port = Number(PORT);
app.listen(port, '0.0.0.0', () => {
  log('info', 'server_started', {
    port,
    has_WA_ACCESS_TOKEN: !!WA_ACCESS_TOKEN,
    has_WA_VERIFY_TOKEN: !!WA_VERIFY_TOKEN,
    has_WA_PHONE_NUMBER_ID: !!WA_PHONE_NUMBER_ID,
    has_META_APP_SECRET: !!META_APP_SECRET,
    deposit_required: DEPOSIT_REQUIRED_BOOL,
    deposit_amount: DEPOSIT_AMOUNT_NUM,
    has_RECEPTION_NOTIFY_TO: !!RECEPTION_NOTIFY_TO,
  });
});
