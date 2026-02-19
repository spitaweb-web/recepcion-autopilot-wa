'use strict';

/**
 * Recepción Autopilot — CEPA (WhatsApp Cloud API) — Node/Express
 * - Webhook verify + messages: /api/whatsapp (y alias /webhook)
 * - Respuestas: text-only (robusto). Fase 2: interactive buttons/lists.
 */

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

app.use(helmet());
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 240,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

const {
  PORT = '3000',
  WA_VERIFY_TOKEN,
  WA_ACCESS_TOKEN,
  WA_PHONE_NUMBER_ID,
  META_APP_SECRET, // recomendado: valida X-Hub-Signature-256
  GRAPH_VERSION = 'v22.0',
} = process.env;

const STARTED_AT = Date.now();

// ===== Util =====
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
    .replace(/[\u0300-\u036f]/g, ''); // sin tildes
}

function verifyMetaSignature(rawBodyBuffer, signatureHeader, appSecret) {
  if (!appSecret) return true; // si no hay secret, no bloqueamos (pero logueamos)
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
    try {
      j = await resp.json();
    } catch {}
    log('error', 'wa_outbound_failed', { status: resp.status, err: j });
    return { ok: false, status: resp.status, err: j };
  }

  const data = await resp.json();
  log('info', 'wa_outbound_sent', { to: toWaId, msg_id: data?.messages?.[0]?.id });
  return { ok: true, data };
}

// ===== CEPA Data =====
const CEPA = {
  name: 'CEPA Centro Médico',
  address: 'Constitución 46, Luján de Cuyo, Mendoza',
  hours: 'Lunes a sábados · 07:30 a 21:00',
  email: 'cepadiagnosticomedicointegral@gmail.com',
  phone: '261-4987007',
  mrturno: 'https://www.mrturno.com/m/@cepa',
  disclaimer:
    'Si es una urgencia, no uses este chat: llamá al 107 o acudí a guardia.',
};

const SPECIALTIES = [
  { key: 'gine', label: 'Ginecología / Obstetricia', kw: ['gine', 'obste', 'papanico', 'pap', 'colpo'] },
  { key: 'pedi', label: 'Pediatría', kw: ['pedi', 'niño', 'nino', 'infantil'] },
  { key: 'clim', label: 'Clínica médica / Medicina familiar', kw: ['clinica', 'familia', 'general'] },
  { key: 'card', label: 'Cardiología', kw: ['cardio', 'corazon'] },
  { key: 'derm', label: 'Dermatología', kw: ['derma', 'piel'] },
  { key: 'trau', label: 'Traumatología', kw: ['trauma', 'rodilla', 'hueso'] },
  { key: 'gastro', label: 'Gastroenterología', kw: ['gastro', 'digest'] },
  { key: 'endo', label: 'Endocrinología / Diabetología', kw: ['endo', 'diabe', 'tiroid'] },
  { key: 'uro', label: 'Urología', kw: ['uro'] },
  { key: 'orl', label: 'ORL', kw: ['orl', 'otorrino'] },
  { key: 'oft', label: 'Oftalmología', kw: ['oft', 'ojo', 'vision'] },
  { key: 'psico', label: 'Psicología', kw: ['psico', 'terapia'] },
  { key: 'nutri', label: 'Nutrición', kw: ['nutri', 'aliment'] },
  { key: 'odonto', label: 'Odontología', kw: ['odonto', 'diente'] },
];

const STUDIES = [
  { key: 'mamo', label: 'Mamografía', kw: ['mamo', 'mamografia'] },
  { key: 'radio', label: 'Radiología', kw: ['radio', 'rayos'] },
  { key: 'eco', label: 'Ecografía / Eco 5D', kw: ['eco', 'ecografia', '5d'] },
  { key: 'doppler', label: 'Ecodoppler Color / Ecocardiograma Doppler', kw: ['doppler', 'ecodoppler', 'ecocardiograma'] },
  { key: 'ecg', label: 'ECG', kw: ['ecg', 'electro'] },
  { key: 'mapa', label: 'MAPA / Presurometría', kw: ['mapa', 'presuro', 'presion'] },
  { key: 'ergo', label: 'Ergometría', kw: ['ergo', 'ergometria'] },
  { key: 'holter', label: 'Holter', kw: ['holter'] },
  { key: 'lab', label: 'Laboratorio', kw: ['laboratorio', 'analisis'] },
  { key: 'resp', label: 'Poligrafía / Espirometría', kw: ['poligrafia', 'espiro', 'respir'] },
  { key: 'audio', label: 'Audiometría / BERA / OEA', kw: ['audio', 'audiometria', 'bera', 'oea', 'imped'] },
];

const ESTETICA = [
  'Rejuvenecimiento facial',
  'Mesoterapia (facial/corporal/capilar)',
  'Plasma rico en plaquetas (PRP)',
  'Botox',
  'Rellenos con ácido hialurónico',
  'Hilos tensores',
  'Punta de diamante / Peeling / Dermapen',
  'Tratamiento de celulitis / grasa localizada',
  'Criocirugía / electrocoagulación cutánea',
];

const OBRAS_SOCIALES_TOP = [
  'OSDE', 'Swiss Medical', 'Galeno', 'Medifé', 'OMINT', 'SanCor Salud', 'Prevención Salud',
  'Jerárquicos Salud', 'Andes Salud', 'Nobis', 'Federada Salud', 'Medicus'
];

// ===== Simple state (demo) =====
const sessions = new Map(); // wa_id -> { state, updatedAt }

function getSession(waId) {
  const s = sessions.get(waId) || { state: 'menu', updatedAt: Date.now() };
  return s;
}

function setSession(waId, patch) {
  const cur = getSession(waId);
  const next = { ...cur, ...patch, updatedAt: Date.now() };
  sessions.set(waId, next);
  return next;
}

function resetSession(waId) {
  sessions.set(waId, { state: 'menu', updatedAt: Date.now() });
}

// ===== UX copy =====
function menuText() {
  return (
`Hola 👋 Soy la recepción automática de ${CEPA.name}.
Elegí una opción (respondé con un número):

1) Sacar turno (especialidades)
2) Estudios (eco, doppler, ECG, laboratorio, etc.)
3) Estética
4) Obras sociales / prepagas
5) Dirección y horarios
6) Hablar con recepción

0) Menú

${CEPA.disclaimer}`
  );
}

function turnosPrompt() {
  return (
`Perfecto. ¿Para qué especialidad es?

Respondé con:
1) Ginecología / Obstetricia
2) Pediatría
3) Clínica médica / Medicina familiar
4) Cardiología
5) Dermatología
6) Traumatología
7) Otra (escribí el nombre)

0) Menú`
  );
}

function estudiosPrompt() {
  return (
`Genial. ¿Qué estudio necesitás?

Respondé con:
1) Mamografía
2) Ecografía / Eco 5D
3) Doppler / Ecocardiograma Doppler
4) ECG
5) MAPA (presión)
6) Ergometría
7) Holter
8) Laboratorio
9) Audiometría / BERA / OEA
10) Otro (escribilo)

0) Menú`
  );
}

function infoContacto() {
  return (
`📍 ${CEPA.address}
🕒 ${CEPA.hours}
📞 Tel: ${CEPA.phone}
✉️ Email: ${CEPA.email}`
  );
}

function mrturnoText(extraLine) {
  return (
`${extraLine ? extraLine + '\n\n' : ''}Para sacar turno rápido usá MrTurno:
${CEPA.mrturno}

Si preferís, decime “recepción” y te ayudo por acá.`
  );
}

function findMatch(norm, list) {
  for (const item of list) {
    if (item.kw.some(k => norm.includes(k))) return item;
  }
  return null;
}

async function handleUserText(waId, rawText) {
  const norm = normalize(rawText);

  // comandos globales
  if (norm === '0' || norm === 'menu' || norm === 'inicio') {
    resetSession(waId);
    return sendText(waId, menuText());
  }

  const session = getSession(waId);

  // accesos rápidos
  if (norm.includes('horario') || norm.includes('direccion') || norm.includes('ubic')) {
    resetSession(waId);
    return sendText(waId, infoContacto());
  }
  if (norm.includes('obra') || norm.includes('prepaga') || norm.includes('osde') || norm.includes('swiss')) {
    resetSession(waId);
    return sendText(
      waId,
      `Trabajamos con varias obras sociales/prepagas. Algunas frecuentes:\n• ${OBRAS_SOCIALES_TOP.join('\n• ')}\n\nSi me decís cuál tenés, te confirmo si está.`
    );
  }
  if (norm.includes('recep') || norm.includes('humano') || norm.includes('persona')) {
    // fase 1: mensaje de handoff
    resetSession(waId);
    return sendText(waId, `Listo ✅ Te paso con recepción. Contame en 1 línea qué necesitás (especialidad/estudio + día preferido).`);
  }

  // state machine
  if (session.state === 'menu') {
    if (norm === '1') {
      setSession(waId, { state: 'turnos' });
      return sendText(waId, turnosPrompt());
    }
    if (norm === '2') {
      setSession(waId, { state: 'estudios' });
      return sendText(waId, estudiosPrompt());
    }
    if (norm === '3') {
      resetSession(waId);
      return sendText(waId, `Estética (algunos tratamientos):\n• ${ESTETICA.join('\n• ')}\n\n¿Querés turno? Respondé “turno” y te paso MrTurno.`);
    }
    if (norm === '4') {
      resetSession(waId);
      return sendText(waId, `Obras sociales/prepagas: decime cuál tenés y te confirmo.\nAlgunas frecuentes:\n• ${OBRAS_SOCIALES_TOP.join('\n• ')}`);
    }
    if (norm === '5') {
      resetSession(waId);
      return sendText(waId, infoContacto());
    }
    if (norm === '6') {
      resetSession(waId);
      return sendText(waId, `Dale ✅ Contame en 1 línea qué necesitás (especialidad/estudio + día preferido) y te ayudo.`);
    }

    // fallback desde menú
    if (norm.includes('turno')) {
      setSession(waId, { state: 'turnos' });
      return sendText(waId, turnosPrompt());
    }
    if (norm.includes('estudio') || norm.includes('eco') || norm.includes('holter') || norm.includes('doppler')) {
      setSession(waId, { state: 'estudios' });
      return sendText(waId, estudiosPrompt());
    }

    return sendText(waId, menuText());
  }

  if (session.state === 'turnos') {
    if (norm === '1') return (resetSession(waId), sendText(waId, mrturnoText('Perfecto: Ginecología / Obstetricia.')));
    if (norm === '2') return (resetSession(waId), sendText(waId, mrturnoText('Perfecto: Pediatría.')));
    if (norm === '3') return (resetSession(waId), sendText(waId, mrturnoText('Perfecto: Clínica médica / Medicina familiar.')));
    if (norm === '4') return (resetSession(waId), sendText(waId, mrturnoText('Perfecto: Cardiología.')));
    if (norm === '5') return (resetSession(waId), sendText(waId, mrturnoText('Perfecto: Dermatología.')));
    if (norm === '6') return (resetSession(waId), sendText(waId, mrturnoText('Perfecto: Traumatología.')));
    if (norm === '7') {
      resetSession(waId);
      return sendText(waId, 'Decime la especialidad exacta (ej: Urología, ORL, Oftalmología, Psicología, Nutrición, etc.)');
    }

    // si escribió texto, intentamos match
    const match = findMatch(norm, SPECIALTIES);
    resetSession(waId);
    if (match) return sendText(waId, mrturnoText(`Perfecto: ${match.label}.`));
    return sendText(waId, mrturnoText('Perfecto. Entrá y elegí la especialidad.'));
  }

  if (session.state === 'estudios') {
    const byNum = {
      '1': 'Mamografía',
      '2': 'Ecografía / Eco 5D',
      '3': 'Doppler / Ecocardiograma Doppler',
      '4': 'ECG',
      '5': 'MAPA (presión)',
      '6': 'Ergometría',
      '7': 'Holter',
      '8': 'Laboratorio',
      '9': 'Audiometría / BERA / OEA',
      '10': null,
    };

    if (byNum[norm]) {
      const label = byNum[norm];
      resetSession(waId);
      return sendText(waId, mrturnoText(`Perfecto: ${label}.`));
    }

    if (norm === '10') {
      resetSession(waId);
      return sendText(waId, 'Decime el estudio exacto (ej: Radiología, Poligrafía, Espirometría, etc.)');
    }

    const match = findMatch(norm, STUDIES);
    resetSession(waId);
    if (match) return sendText(waId, mrturnoText(`Perfecto: ${match.label}.`));
    return sendText(waId, mrturnoText('Perfecto. Entrá y elegí el estudio.'));
  }

  // fallback total
  resetSession(waId);
  return sendText(waId, menuText());
}

// ===== Health + privacidad =====
app.get('/health', (_req, res) => {
  res.status(200).json({
    ok: true,
    uptime_s: Math.floor((Date.now() - STARTED_AT) / 1000),
  });
});

app.get('/privacidad', (_req, res) => {
  res
    .status(200)
    .send(
      `<html><head><meta charset="utf-8"><title>Privacidad</title></head>
      <body style="font-family:system-ui;padding:24px;max-width:820px;margin:auto">
      <h1>Política de Privacidad — Recepción Automática (CEPA)</h1>
      <p>Este sistema responde mensajes para orientar turnos e información general. No es un servicio de emergencias.</p>
      <p>Los mensajes pueden procesarse para mejorar la atención y generar trazabilidad operativa. No compartimos datos con terceros ajenos a la prestación del servicio.</p>
      <p>Contacto: ${CEPA.email}</p>
      </body></html>`
    );
});

// ===== Webhook: verify (GET) =====
function verifyHandler(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  log('info', 'wa_verify_attempt', {
    mode,
    token_present: !!token,
    expected_present: !!WA_VERIFY_TOKEN,
  });

  if (mode === 'subscribe' && token && WA_VERIFY_TOKEN && token === WA_VERIFY_TOKEN) {
    log('info', 'wa_webhook_verified');
    return res.status(200).send(challenge);
  }

  log('warn', 'wa_webhook_verify_failed', { mode, token_preview: token ? String(token).slice(0, 8) : null });
  return res.sendStatus(403);
}

// ===== Webhook: messages (POST) =====
async function postHandler(req, res) {
  // Validación firma (recomendada). Si no hay META_APP_SECRET, no bloqueamos.
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

  // Respondemos rápido a Meta
  res.sendStatus(200);

  try {
    const entry = payload?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    // ignorar statuses
    if (value?.statuses?.length) {
      log('info', 'wa_status_update', { status: value.statuses[0]?.status });
      return;
    }

    const msg = value?.messages?.[0];
    if (!msg) return;

    const from = msg.from;
    const text = msg?.text?.body ? String(msg.text.body) : '';

    log('info', 'wa_inbound', { from, text_preview: text.slice(0, 140) });

    // si llega vacío, devolvemos menú
    if (!text.trim()) {
      resetSession(from);
      await sendText(from, menuText());
      return;
    }

    await handleUserText(from, text);
  } catch (e) {
    log('error', 'wa_handle_failed', { err: String(e?.message || e) });
  }
}

// Importante: raw body para firma
app.get('/api/whatsapp', verifyHandler);
app.get('/webhook', verifyHandler);

app.post('/api/whatsapp', express.raw({ type: '*/*', limit: '2mb' }), postHandler);
app.post('/webhook', express.raw({ type: '*/*', limit: '2mb' }), postHandler);

// ===== Start =====
const port = Number(PORT);
app.listen(port, '0.0.0.0', () => {
  log('info', 'server_started', {
    port,
    has_WA_ACCESS_TOKEN: !!WA_ACCESS_TOKEN,
    has_WA_VERIFY_TOKEN: !!WA_VERIFY_TOKEN,
    has_WA_PHONE_NUMBER_ID: !!WA_PHONE_NUMBER_ID,
    WA_PHONE_NUMBER_ID_preview: WA_PHONE_NUMBER_ID ? String(WA_PHONE_NUMBER_ID).slice(0, 6) + '...' : null,
  });
});
