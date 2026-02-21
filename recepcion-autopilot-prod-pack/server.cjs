'use strict';

/**
 * Recepción Autopilot — CEPA (WhatsApp Cloud API) — Node/Express
 * + Google Sheets panel (cases + events)
 * + MercadoPago seña (preference link)
 *
 * Incluye:
 * ✅ Webhook verify + messages: /api/whatsapp y /webhook
 * ✅ Text-only (robusto) + capa natural (hola/gracias/chau random)
 * ✅ Flujo Particular / Obra Social (pide token+dni)
 * ✅ Seña $ configurable + link MP + registro comprobante con receiptId
 * ✅ Log persistente en Sheets + dedupe + sesiones TTL + reminder
 *
 * Importante:
 * - NO menciona reintegro ni políticas (por decisión comercial).
 */

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const { google } = require('googleapis');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(helmet());
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 240,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.ip,
  })
);

const {
  PORT = '3000',
  WA_VERIFY_TOKEN,
  WA_ACCESS_TOKEN,
  WA_PHONE_NUMBER_ID,
  META_APP_SECRET,
  GRAPH_VERSION = 'v22.0',

  DEPOSIT_REQUIRED = 'true',
  DEPOSIT_AMOUNT = '10000',
  PAYMENT_WINDOW_MINUTES = '60',

  // MercadoPago
  MP_ACCESS_TOKEN,
  MP_SUCCESS_URL,
  MP_FAILURE_URL,
  MP_PENDING_URL,

  // Google Sheets
  GSHEET_SPREADSHEET_ID,
  GSHEET_SA_JSON_BASE64, // recomendado (Render)
  GSHEET_CLIENT_EMAIL,   // alternativa
  GSHEET_PRIVATE_KEY,    // alternativa
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
    .replace(/[\u0300-\u036f]/g, '');
}

function verifyMetaSignature(rawBodyBuffer, signatureHeader, appSecret) {
  if (!appSecret) return true;
  if (!signatureHeader || typeof signatureHeader !== 'string') return false;
  if (!signatureHeader.startsWith('sha256=')) return false;

  const ours =
    'sha256=' +
    crypto.createHmac('sha256', appSecret).update(rawBodyBuffer).digest('hex');

  return timingSafeEq(ours, signatureHeader);
}

function randPick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function nowISO() {
  return new Date().toISOString();
}

function makeId(prefix = 'ID') {
  const ts = Date.now().toString(36).toUpperCase();
  const r = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `${prefix}-${ts}-${r}`;
}

function moneyARS(n) {
  try { return new Intl.NumberFormat('es-AR').format(n); }
  catch { return String(n); }
}

function extractOperationId(text) {
  const s = String(text || '');
  // busca números largos típicos de operación (>=6 dígitos)
  const m = s.match(/\b(\d{6,})\b/);
  return m ? m[1] : '';
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

const DEPOSIT_ON = normalize(DEPOSIT_REQUIRED) !== 'false';
const DEPOSIT_VALUE = (() => {
  const n = Number(String(DEPOSIT_AMOUNT || '').replace(/[^\d]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : 10000;
})();

const PAYMENT_WINDOW_MS = (() => {
  const mins = Number(String(PAYMENT_WINDOW_MINUTES || '60').replace(/[^\d]/g, ''));
  const safe = Number.isFinite(mins) && mins > 0 ? mins : 60;
  return safe * 60 * 1000;
})();

// ===== Google Sheets (panel) =====
function getServiceAccount() {
  if (GSHEET_SA_JSON_BASE64) {
    const raw = Buffer.from(GSHEET_SA_JSON_BASE64, 'base64').toString('utf8');
    return JSON.parse(raw);
  }
  if (GSHEET_CLIENT_EMAIL && GSHEET_PRIVATE_KEY) {
    return {
      client_email: GSHEET_CLIENT_EMAIL,
      private_key: GSHEET_PRIVATE_KEY.replace(/\\n/g, '\n'),
    };
  }
  return null;
}

async function getSheetsClient() {
  const sa = getServiceAccount();
  if (!sa || !GSHEET_SPREADSHEET_ID) return null;

  const auth = new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  return google.sheets({ version: 'v4', auth });
}

async function sheetAppend(range, values) {
  try {
    const sheets = await getSheetsClient();
    if (!sheets) return { ok: false, reason: 'missing_gsheet_env' };

    await sheets.spreadsheets.values.append({
      spreadsheetId: GSHEET_SPREADSHEET_ID,
      range,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [values] },
    });

    return { ok: true };
  } catch (e) {
    log('error', 'gsheet_append_failed', { err: String(e?.message || e), range });
    return { ok: false, reason: 'append_failed' };
  }
}

// Mantiene un caseId estable por WA (y appendea filas como auditoría por estado)
const caseByWa = new Map(); // wa_id -> case_id

async function ensureCase(waId, patch = {}) {
  let caseId = caseByWa.get(waId);
  if (!caseId) {
    caseId = makeId('CASE');
    caseByWa.set(waId, caseId);
  }

  const flowType = patch.flow_type || patch.intent_type || '';
  const serviceLabel = patch.service_label || patch.label || '';

  const row = [
    nowISO(),                           // A created_at
    caseId,                             // B case_id
    waId,                               // C wa_from
    flowType,                           // D flow_type
    patch.patient_type || patch.patientType || '', // E patient_type
    patch.os_name || patch.osName || '',           // F os_name
    patch.os_token || patch.osToken || '',         // G os_token
    serviceLabel,                       // H service_label
    patch.deposit_amount ?? (DEPOSIT_ON ? DEPOSIT_VALUE : ''), // I deposit_amount
    patch.payment_link || '',           // J payment_link
    patch.payment_op_id || '',          // K payment_op_id
    patch.status || 'lead',             // L status
    patch.last_message || '',           // M last_message
    nowISO(),                           // N updated_at
  ];

  await sheetAppend('cases!A:N', row);
  return caseId;
}

async function logEvent({ caseId, waId, eventType, payloadPreview, payload }) {
  return sheetAppend('events!A:G', [
    makeId('EV'),                              // A event_id
    nowISO(),                                  // B created_at
    caseId,                                    // C case_id
    waId,                                      // D wa_from
    eventType,                                 // E event_type
    String(payloadPreview || '').slice(0, 220), // F payload_preview
    payload ? JSON.stringify(payload).slice(0, 800) : '', // G payload
  ]);
}

async function registerReceiptInSheets({ waId, kind, hint, paymentOpId }) {
  const receiptId = makeId('CEPA');

  const caseId = await ensureCase(waId, {
    intent_type: kind || '',
    status: 'confirmed',
    payment_op_id: paymentOpId || '',
    last_message: '',
  });

  await logEvent({
    caseId,
    waId,
    eventType: 'receipt',
    payloadPreview: `receipt_id=${receiptId} op=${paymentOpId || ''} hint=${String(hint || '').slice(0, 40)}`,
    payload: { receiptId, paymentOpId: paymentOpId || null, hint: hint || null },
  });

  return { caseId, receiptId };
}

// ===== MercadoPago =====
async function createMpPreference({ caseId, waId, label, patientType, osName, osToken, amount }) {
  if (!MP_ACCESS_TOKEN) return { ok: false, reason: 'missing_mp_token' };

  const expiresFrom = new Date();
  const expiresTo = new Date(Date.now() + PAYMENT_WINDOW_MS);

  const payload = {
    items: [{
      title: `Seña - ${CEPA.name} (${label})`,
      quantity: 1,
      currency_id: 'ARS',
      unit_price: Number(amount),
    }],
    external_reference: caseId,
    expires: true,
    expiration_date_from: expiresFrom.toISOString(),
    expiration_date_to: expiresTo.toISOString(),
    payer: { phone: { number: waId } },
    metadata: {
      waId,
      label,
      patientType,
      osName: osName || '',
      osToken: osToken || '',
    },
    back_urls: {
      success: MP_SUCCESS_URL || 'https://example.com/ok',
      failure: MP_FAILURE_URL || 'https://example.com/error',
      pending: MP_PENDING_URL || 'https://example.com/pendiente',
    },
    auto_return: 'approved',
  };

  const resp = await fetch('https://api.mercadopago.com/checkout/preferences', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    let j = {};
    try { j = await resp.json(); } catch {}
    log('error', 'mp_preference_failed', { status: resp.status, err: j });
    return { ok: false, status: resp.status, err: j };
  }

  const data = await resp.json();
  return { ok: true, init_point: data.init_point, pref_id: data.id };
}

// ===== CEPA Data =====
const CEPA = {
  name: 'CEPA Consultorios (Luján de Cuyo)',
  address: 'Constitución 46, Luján de Cuyo, Mendoza',
  hours: 'Lunes a sábados · 07:30 a 21:00',
  email: 'cepadiagnosticomedicointegral@gmail.com',
  phone: '261-4987007',
  mrturno: 'https://www.mrturno.com/m/@cepa',
  disclaimer: 'Si es una urgencia, no uses este chat: llamá al 107 o acudí a guardia.',
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

// ===== Natural layer =====
const GREETINGS = ['hola', 'holaa', 'buen dia', 'buen día', 'buenas', 'buenas tardes', 'buenas noches', 'hey', 'que tal', 'qué tal'];
const THANKS = ['gracias', 'muchas gracias', 'mil gracias', 'genial gracias', 'graciass'];
const BYE = ['chau', 'chao', 'hasta luego', 'nos vemos', 'adios', 'adiós', 'bye'];

const GREETING_REPLIES = [
  `¡Hola! 👋 Soy la recepción automática de ${CEPA.name}.\n\nRespondé con un número:\n1) Sacar turno\n2) Estudios\n3) Estética\n4) Obras sociales\n5) Dirección/horarios\n6) Recepción`,
  `¡Buenas! 👋 Estoy para ayudarte rápido.\n1) Turno · 2) Estudios · 3) Estética · 4) Obras sociales · 5) Dirección/horarios · 6) Recepción`,
  `Hola 👋 Bienvenido/a a ${CEPA.name}.\n¿Turno o info?\n1) Turno\n2) Estudios\n3) Estética\n4) Obras sociales\n5) Dirección/horarios\n6) Recepción`,
];

const CLOSING_REPLIES = [
  `¡De nada! ✅ Si necesitás algo más, escribí “menú”.`,
  `Perfecto 🙌 Cualquier cosa, escribime “menú” y te ayudo.`,
  `Listo ✅ Te leo cuando quieras. (Escribí “menú” para ver opciones)`,
];

function isGreeting(norm) {
  return GREETINGS.some((g) => norm === normalize(g) || norm.startsWith(normalize(g)));
}
function isThanksOrBye(norm) {
  const hasThanks = THANKS.some((t) => norm === normalize(t) || norm.includes(normalize(t)));
  const hasBye = BYE.some((b) => norm === normalize(b) || norm.includes(normalize(b)));
  return hasThanks || hasBye;
}
function maybeLooksLikeReceiptText(norm) {
  return (
    norm.includes('comprobante') ||
    norm.includes('transfer') ||
    norm.includes('id') ||
    norm.includes('op') ||
    /\d{6,}/.test(norm)
  );
}

// ===== Sessions + dedupe =====
const sessions = new Map(); // wa_id -> { state, context, updatedAt }
const SESSION_TTL_MS = 60 * 60 * 1000;

const seenMsg = new Map(); // msgId -> ts
const SEEN_TTL_MS = 10 * 60 * 1000;

function gc() {
  const now = Date.now();

  for (const [k, s] of sessions.entries()) {
    if (!s?.updatedAt || now - s.updatedAt > SESSION_TTL_MS) {
      try { if (s?.context?.reminderTimer) clearTimeout(s.context.reminderTimer); } catch {}
      sessions.delete(k);
    }
  }

  for (const [id, ts] of seenMsg.entries()) {
    if (!ts || now - ts > SEEN_TTL_MS) seenMsg.delete(id);
  }
}
setInterval(gc, 60 * 1000).unref();

function getSession(waId) {
  return sessions.get(waId) || { state: 'menu', context: {}, updatedAt: Date.now() };
}

function setSession(waId, patch) {
  const cur = getSession(waId);
  const next = { ...cur, ...patch, updatedAt: Date.now() };
  sessions.set(waId, next);
  return next;
}

function resetSession(waId) {
  const cur = sessions.get(waId);
  try { if (cur?.context?.reminderTimer) clearTimeout(cur.context.reminderTimer); } catch {}
  sessions.set(waId, { state: 'menu', context: {}, updatedAt: Date.now() });
}

function findMatch(norm, list) {
  for (const item of list) {
    if (item.kw.some((k) => norm.includes(k))) return item;
  }
  return null;
}

// ===== Reminder (si cuelga en pago) =====
function schedulePaymentReminder(waId) {
  if (!DEPOSIT_ON) return;

  const s = getSession(waId);
  if (!['awaiting_payment'].includes(s.state)) return;
  if (s?.context?.reminderTimer) return;

  const timer = setTimeout(async () => {
    try {
      const cur = getSession(waId);
      if (cur.state !== 'awaiting_payment') return;
      if (cur.context?.reminderSent) return;

      setSession(waId, {
        state: 'awaiting_payment',
        context: { ...cur.context, reminderSent: true },
      });

      const caseId = await ensureCase(waId, {
        flow_type: cur.context?.type || '',
        service_label: cur.context?.label || '',
        patient_type: cur.context?.patientType || '',
        os_name: cur.context?.osName || '',
        os_token: cur.context?.osToken || '',
        status: 'awaiting_payment',
        last_message: '',
      });

      await logEvent({
        caseId,
        waId,
        eventType: 'reminder',
        payloadPreview: 'payment_reminder_sent',
      });

      await sendText(
        waId,
        `Recordatorio ✅ Para confirmar necesitamos la seña de $${moneyARS(DEPOSIT_VALUE)}.\n\nSi ya abonaste, enviá el comprobante (captura o ID de operación).`
      );
    } catch (e) {
      log('error', 'payment_reminder_failed', { err: String(e?.message || e) });
    }
  }, PAYMENT_WINDOW_MS);

  setSession(waId, {
    state: 'awaiting_payment',
    context: { ...s.context, reminderTimer: timer, reminderSent: false },
  });
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
`${extraLine ? extraLine + '\n\n' : ''}Para elegir día y horario usá MrTurno:
${CEPA.mrturno}

Cuando tengas el turno reservado, escribime “LISTO” y lo confirmo por acá.`
  );
}

function patientTypePrompt() {
  return (
`¿Sos:
1) Particular
2) Obra social

(Respondé 1 o 2)`
  );
}

function askOsNameText() {
  return `Dale ✅ ¿Qué obra social tenés? (ej: OSDE, Swiss Medical, Galeno)`;
}

function askOsTokenText() {
  return `Perfecto ✅ Ahora pasame *token/afiliado* y *DNI* en una sola línea.\nEj: "Token 123456 - DNI 30111222"`;
}

function paymentLinkText(url) {
  return (
`Perfecto ✅ Para confirmar necesitamos una seña de $${moneyARS(DEPOSIT_VALUE)}.

🔗 Link de pago: ${url}

Cuando pagues, mandame el *ID de operación* o una *captura* y queda confirmado.`
  );
}

function receiptAckText(receiptId) {
  return (
`Recibido ✅ Ya registré tu pago.

🧾 Comprobante: ${receiptId}`
  );
}

function finalConfirmedText(receiptId) {
  const receiptLine = receiptId ? `\n🧾 Comprobante: ${receiptId}\n` : '\n';
  return (
`Listo ✅ Turno confirmado.${receiptLine}
${infoContacto()}

Si necesitás reprogramar, escribí “recepción”.`
  );
}

// ===== Flow =====
async function handleUserText(waId, rawText) {
  const norm = normalize(rawText);
  const session = getSession(waId);

  // Natural: saludo
  if (isGreeting(norm) && session.state === 'menu') {
    const caseId = await ensureCase(waId, { status: 'lead', last_message: rawText.slice(0, 140) });
    await logEvent({ caseId, waId, eventType: 'inbound', payloadPreview: rawText });
    return sendText(waId, randPick(GREETING_REPLIES));
  }

  // Natural: cierre (pero si espera pago, NO lo dejamos cortar)
  if (isThanksOrBye(norm) && !['awaiting_payment'].includes(session.state)) {
    const caseId = await ensureCase(waId, { status: 'lead', last_message: rawText.slice(0, 140) });
    await logEvent({ caseId, waId, eventType: 'inbound', payloadPreview: rawText });
    return sendText(waId, randPick(CLOSING_REPLIES));
  }

  // Comandos globales
  if (norm === '0' || norm === 'menu' || norm === 'inicio') {
    resetSession(waId);
    const caseId = await ensureCase(waId, { status: 'lead', last_message: rawText.slice(0, 140) });
    await logEvent({ caseId, waId, eventType: 'status_change', payloadPreview: 'status=menu' });
    return sendText(waId, menuText());
  }

  // Accesos rápidos
  if (norm.includes('horario') || norm.includes('direccion') || norm.includes('ubic')) {
    resetSession(waId);
    const caseId = await ensureCase(waId, { status: 'lead', last_message: rawText.slice(0, 140) });
    await logEvent({ caseId, waId, eventType: 'info', payloadPreview: 'asked=contact_info' });
    return sendText(waId, infoContacto());
  }

  if (norm.includes('obra') || norm.includes('prepaga') || norm.includes('osde') || norm.includes('swiss')) {
    resetSession(waId);
    const caseId = await ensureCase(waId, { status: 'lead', last_message: rawText.slice(0, 140) });
    await logEvent({ caseId, waId, eventType: 'info', payloadPreview: 'asked=insurance' });
    return sendText(
      waId,
      `Trabajamos con varias obras sociales/prepagas. Algunas frecuentes:\n• ${OBRAS_SOCIALES_TOP.join('\n• ')}\n\nSi me decís cuál tenés, te confirmo si está.`
    );
  }

  if (norm.includes('recep') || norm.includes('humano') || norm.includes('persona')) {
    setSession(waId, { state: 'handoff', context: {} });

    const caseId = await ensureCase(waId, {
      flow_type: 'recepcion',
      status: 'handoff',
      last_message: rawText.slice(0, 140),
    });

    await logEvent({ caseId, waId, eventType: 'status_change', payloadPreview: 'status=handoff' });

    return sendText(
      waId,
      `Listo ✅ Te paso con recepción.\nContame en 1 línea qué necesitás (especialidad/estudio + día preferido).`
    );
  }

  // LISTO => lo llevamos a pago (si ya eligió label)
  if (norm === 'listo' || norm === 'ok' || norm === 'dale' || norm === 'ya') {
    if (session.state === 'awaiting_mrturno_done') {
      setSession(waId, { state: 'ask_patient_type', context: { ...session.context } });
      return sendText(waId, patientTypePrompt());
    }

    resetSession(waId);
    const caseId = await ensureCase(waId, { status: 'lead', last_message: rawText.slice(0, 140) });
    await logEvent({ caseId, waId, eventType: 'inbound', payloadPreview: rawText });
    return sendText(waId, `Perfecto. ¿En qué te ayudo?\n\n${menuText()}`);
  }

  // Si espera pago y manda algo “tipo comprobante”
  if (session.state === 'awaiting_payment' && maybeLooksLikeReceiptText(norm)) {
    const opId = extractOperationId(rawText) || '';

    // auditoría cases
    const caseId = await ensureCase(waId, {
      flow_type: session.context?.type || '',
      service_label: session.context?.label || '',
      patient_type: session.context?.patientType || '',
      os_name: session.context?.osName || '',
      os_token: session.context?.osToken || '',
      payment_link: session.context?.mp?.init_point || '',
      payment_op_id: opId,
      status: 'confirmed',
      last_message: rawText.slice(0, 140),
    });

    await logEvent({
      caseId,
      waId,
      eventType: 'payment_proof_text',
      payloadPreview: opId ? `op_id=${opId}` : 'proof_text',
      payload: { opId: opId || null, text: rawText.slice(0, 300) },
    });

    const { receiptId } = await registerReceiptInSheets({
      waId,
      kind: session.context?.type || 'unknown',
      hint: rawText.trim().slice(0, 120),
      paymentOpId: opId,
    });

    resetSession(waId);
    await sendText(waId, receiptAckText(receiptId));
    return sendText(waId, finalConfirmedText(receiptId));
  }

  // Máquina de estados
  if (session.state === 'menu') {
    const caseId = await ensureCase(waId, { status: 'lead', last_message: rawText.slice(0, 140) });
    await logEvent({ caseId, waId, eventType: 'inbound', payloadPreview: rawText });

    if (norm === '1') {
      setSession(waId, { state: 'turnos' });
      await logEvent({ caseId, waId, eventType: 'status_change', payloadPreview: 'state=turnos' });
      return sendText(waId, turnosPrompt());
    }
    if (norm === '2') {
      setSession(waId, { state: 'estudios' });
      await logEvent({ caseId, waId, eventType: 'status_change', payloadPreview: 'state=estudios' });
      return sendText(waId, estudiosPrompt());
    }
    if (norm === '3') {
      resetSession(waId);
      return sendText(
        waId,
        `Estética (algunos tratamientos):\n• ${ESTETICA.join('\n• ')}\n\n¿Querés turno? Respondé “turno” y te paso MrTurno.`
      );
    }
    if (norm === '4') {
      resetSession(waId);
      return sendText(
        waId,
        `Obras sociales/prepagas: decime cuál tenés y te confirmo.\nAlgunas frecuentes:\n• ${OBRAS_SOCIALES_TOP.join('\n• ')}`
      );
    }
    if (norm === '5') {
      resetSession(waId);
      return sendText(waId, infoContacto());
    }
    if (norm === '6') {
      setSession(waId, { state: 'handoff', context: {} });
      await logEvent({ caseId, waId, eventType: 'status_change', payloadPreview: 'status=handoff' });
      return sendText(waId, `Dale ✅ Contame en 1 línea qué necesitás (especialidad/estudio + día preferido) y te ayudo.`);
    }

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
    const sendMrTurno = async (label) => {
      setSession(waId, { state: 'awaiting_mrturno_done', context: { type: 'turno', label } });

      const caseId = await ensureCase(waId, {
        flow_type: 'turno',
        service_label: label,
        status: 'awaiting_mrturno',
        last_message: rawText.slice(0, 140),
      });

      await logEvent({
        caseId,
        waId,
        eventType: 'status_change',
        payloadPreview: `status=awaiting_mrturno label=${label}`,
      });

      return sendText(waId, mrturnoText(`Perfecto: ${label}.`));
    };

    if (norm === '1') return sendMrTurno('Ginecología / Obstetricia');
    if (norm === '2') return sendMrTurno('Pediatría');
    if (norm === '3') return sendMrTurno('Clínica médica / Medicina familiar');
    if (norm === '4') return sendMrTurno('Cardiología');
    if (norm === '5') return sendMrTurno('Dermatología');
    if (norm === '6') return sendMrTurno('Traumatología');
    if (norm === '7') {
      setSession(waId, { state: 'awaiting_specialty_text', context: {} });
      return sendText(waId, 'Decime la especialidad exacta (ej: Urología, ORL, Oftalmología, Psicología, Nutrición, etc.)');
    }

    const match = findMatch(norm, SPECIALTIES);
    if (match) return sendMrTurno(match.label);

    return sendText(waId, `No lo pude identificar del todo 🙈\nDecime la especialidad exacta (ej: Urología / ORL / Oftalmología).`);
  }

  if (session.state === 'awaiting_specialty_text') {
    const match = findMatch(norm, SPECIALTIES);
    const label = match ? match.label : rawText.trim();

    setSession(waId, { state: 'awaiting_mrturno_done', context: { type: 'turno', label } });

    const caseId = await ensureCase(waId, {
      flow_type: 'turno',
      service_label: label,
      status: 'awaiting_mrturno',
      last_message: rawText.slice(0, 140),
    });

    await logEvent({ caseId, waId, eventType: 'status_change', payloadPreview: `status=awaiting_mrturno label=${label}` });
    return sendText(waId, mrturnoText(`Perfecto: ${label}.`));
  }

  if (session.state === 'estudios') {
    const sendMrTurno = async (label) => {
      setSession(waId, { state: 'awaiting_mrturno_done', context: { type: 'estudio', label } });

      const caseId = await ensureCase(waId, {
        flow_type: 'estudio',
        service_label: label,
        status: 'awaiting_mrturno',
        last_message: rawText.slice(0, 140),
      });

      await logEvent({ caseId, waId, eventType: 'status_change', payloadPreview: `status=awaiting_mrturno label=${label}` });
      return sendText(waId, mrturnoText(`Perfecto: ${label}.`));
    };

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

    if (Object.prototype.hasOwnProperty.call(byNum, norm) && byNum[norm]) return sendMrTurno(byNum[norm]);

    if (norm === '10') {
      setSession(waId, { state: 'awaiting_study_text', context: {} });
      return sendText(waId, 'Decime el estudio exacto (ej: Radiología, Poligrafía, Espirometría, etc.)');
    }

    const match = findMatch(norm, STUDIES);
    if (match) return sendMrTurno(match.label);

    return sendText(waId, `No lo pude identificar 🙈\nDecime el estudio exacto (ej: Radiología / Espirometría / BERA).`);
  }

  if (session.state === 'awaiting_study_text') {
    const match = findMatch(norm, STUDIES);
    const label = match ? match.label : rawText.trim();

    setSession(waId, { state: 'awaiting_mrturno_done', context: { type: 'estudio', label } });

    const caseId = await ensureCase(waId, {
      flow_type: 'estudio',
      service_label: label,
      status: 'awaiting_mrturno',
      last_message: rawText.slice(0, 140),
    });

    await logEvent({ caseId, waId, eventType: 'status_change', payloadPreview: `status=awaiting_mrturno label=${label}` });
    return sendText(waId, mrturnoText(`Perfecto: ${label}.`));
  }

  // Tipo paciente
  if (session.state === 'ask_patient_type') {
    if (norm === '1') {
      const { type, label } = session.context || {};

      const caseId = await ensureCase(waId, {
        flow_type: type || '',
        service_label: label || '',
        patient_type: 'particular',
        status: 'awaiting_payment',
        last_message: rawText.slice(0, 140),
      });

      await logEvent({ caseId, waId, eventType: 'patient_type', payloadPreview: 'particular' });

      const mp = await createMpPreference({
        caseId,
        waId,
        label,
        patientType: 'particular',
        amount: DEPOSIT_VALUE,
      });

      setSession(waId, { state: 'awaiting_payment', context: { ...session.context, patientType: 'particular', mp } });
      schedulePaymentReminder(waId);

      if (!mp.ok) {
        await ensureCase(waId, {
          flow_type: type || '',
          service_label: label || '',
          patient_type: 'particular',
          status: 'mp_failed',
          last_message: 'mp_preference_failed',
        });
        return sendText(waId, `Perfecto ✅ Para confirmar necesitamos la seña de $${moneyARS(DEPOSIT_VALUE)}.\n\nAhora mismo no pude generar el link.\nEscribí “recepción” y te lo resuelven.`);
      }

      // guardar link en cases
      await ensureCase(waId, {
        flow_type: type || '',
        service_label: label || '',
        patient_type: 'particular',
        status: 'awaiting_payment',
        payment_link: mp.init_point,
        last_message: 'mp_link_sent',
      });

      return sendText(waId, paymentLinkText(mp.init_point));
    }

    if (norm === '2') {
      setSession(waId, { state: 'ask_os_name', context: { ...session.context, patientType: 'obra_social' } });
      return sendText(waId, askOsNameText());
    }

    return sendText(waId, `Respondeme 1 (Particular) o 2 (Obra social).`);
  }

  if (session.state === 'ask_os_name') {
    setSession(waId, { state: 'ask_os_token', context: { ...session.context, osName: rawText.trim() } });
    return sendText(waId, askOsTokenText());
  }

  if (session.state === 'ask_os_token') {
    const { type, label, osName } = session.context || {};
    const osToken = rawText.trim();

    const caseId = await ensureCase(waId, {
      flow_type: type || '',
      service_label: label || '',
      patient_type: 'obra_social',
      os_name: osName || '',
      os_token: osToken,
      status: 'awaiting_payment',
      last_message: rawText.slice(0, 140),
    });

    await logEvent({
      caseId,
      waId,
      eventType: 'os_data',
      payloadPreview: `os=${osName} token=${osToken.slice(0, 80)}`,
    });

    const mp = await createMpPreference({
      caseId,
      waId,
      label,
      patientType: 'obra_social',
      osName,
      osToken,
      amount: DEPOSIT_VALUE,
    });

    setSession(waId, { state: 'awaiting_payment', context: { ...session.context, osToken, mp } });
    schedulePaymentReminder(waId);

    if (!mp.ok) {
      await ensureCase(waId, {
        flow_type: type || '',
        service_label: label || '',
        patient_type: 'obra_social',
        os_name: osName || '',
        os_token: osToken,
        status: 'mp_failed',
        last_message: 'mp_preference_failed',
      });
      return sendText(waId, `Listo ✅ Tomé tus datos.\nPara confirmar necesitamos la seña de $${moneyARS(DEPOSIT_VALUE)}.\n\nAhora no pude generar el link.\nEscribí “recepción” y te lo hacen manual.`);
    }

    // guardar link en cases
    await ensureCase(waId, {
      flow_type: type || '',
      service_label: label || '',
      patient_type: 'obra_social',
      os_name: osName || '',
      os_token: osToken,
      status: 'awaiting_payment',
      payment_link: mp.init_point,
      last_message: 'mp_link_sent',
    });

    return sendText(waId, paymentLinkText(mp.init_point));
  }

  if (session.state === 'awaiting_payment') {
    schedulePaymentReminder(waId);

    await ensureCase(waId, {
      flow_type: session.context?.type || '',
      service_label: session.context?.label || '',
      patient_type: session.context?.patientType || '',
      os_name: session.context?.osName || '',
      os_token: session.context?.osToken || '',
      payment_link: session.context?.mp?.init_point || '',
      status: 'awaiting_payment',
      last_message: rawText.slice(0, 140),
    });

    return sendText(waId, `Cuando pagues, mandame el *ID de operación* o una *captura* para confirmarlo ✅`);
  }

  if (session.state === 'handoff') {
    resetSession(waId);
    const caseId = await ensureCase(waId, {
      flow_type: 'recepcion',
      status: 'handoff',
      last_message: rawText.slice(0, 140),
    });
    await logEvent({ caseId, waId, eventType: 'handoff', payloadPreview: rawText });
    return sendText(waId, `Perfecto ✅ Ya quedó. En breve te responde recepción.\n\nMientras tanto, si querés sacar turno rápido: ${CEPA.mrturno}`);
  }

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
  res.status(200).send(
    `<html><head><meta charset="utf-8"><title>Privacidad</title></head>
    <body style="font-family:system-ui;padding:24px;max-width:820px;margin:auto">
    <h1>Política de Privacidad — Recepción Automática (CEPA)</h1>
    <p>Este sistema responde mensajes para orientar turnos e información general. No es un servicio de emergencias.</p>
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

  log('warn', 'wa_webhook_verify_failed', {
    mode,
    token_preview: token ? String(token).slice(0, 8) : null,
  });
  return res.sendStatus(403);
}

// ===== Webhook: messages (POST) =====
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

  res.sendStatus(200);

  try {
    const entry = payload?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    if (value?.statuses?.length) {
      log('info', 'wa_status_update', { status: value.statuses[0]?.status });
      return;
    }

    const msg = value?.messages?.[0];
    if (!msg) return;

    const msgId = msg.id;
    const from = msg.from;

    if (msgId) {
      if (seenMsg.has(msgId)) {
        log('info', 'wa_dedup_ignored', { msgId });
        return;
      }
      seenMsg.set(msgId, Date.now());
    }

    const text = msg?.text?.body ? String(msg.text.body) : '';
    log('info', 'wa_inbound', { from, msgId, text_preview: text.slice(0, 140) });

    const hasMedia =
      !!msg?.image ||
      !!msg?.document ||
      !!msg?.video ||
      !!msg?.audio ||
      !!msg?.sticker;

    if (hasMedia) {
      const s = getSession(from);

      // Si llega media y estamos esperando pago => registrar + confirmar
      if (s.state === 'awaiting_payment') {
        const caseId = await ensureCase(from, {
          flow_type: s.context?.type || '',
          service_label: s.context?.label || '',
          patient_type: s.context?.patientType || '',
          os_name: s.context?.osName || '',
          os_token: s.context?.osToken || '',
          payment_link: s.context?.mp?.init_point || '',
          status: 'confirmed',
          last_message: 'media_proof',
        });

        await logEvent({ caseId, waId: from, eventType: 'payment_proof_media', payloadPreview: 'media' });

        const { receiptId } = await registerReceiptInSheets({
          waId: from,
          kind: s.context?.type || 'unknown',
          hint: 'media',
          paymentOpId: '',
        });

        resetSession(from);
        await sendText(from, receiptAckText(receiptId));
        await sendText(from, finalConfirmedText(receiptId));
        return;
      }

      const caseId = await ensureCase(from, { status: 'lead', last_message: 'media_received' });
      await logEvent({ caseId, waId: from, eventType: 'inbound_media', payloadPreview: 'media' });

      await sendText(from, `Recibido ✅ ¿Querés sacar turno o necesitás recepción?\n\n${menuText()}`);
      return;
    }

    if (!text.trim()) {
      resetSession(from);
      const caseId = await ensureCase(from, { status: 'lead', last_message: '(empty_text)' });
      await logEvent({ caseId, waId: from, eventType: 'inbound', payloadPreview: '(empty_text)' });
      return sendText(from, menuText());
    }

    // Log inbound
    const caseId = await ensureCase(from, { status: 'lead', last_message: text.slice(0, 140) });
    await logEvent({ caseId, waId: from, eventType: 'inbound', payloadPreview: text });

    await handleUserText(from, text);
  } catch (e) {
    log('error', 'wa_handle_failed', { err: String(e?.message || e) });
  }
}

// raw body para firma
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
    has_mp: !!MP_ACCESS_TOKEN,
    WA_PHONE_NUMBER_ID_preview: WA_PHONE_NUMBER_ID ? String(WA_PHONE_NUMBER_ID).slice(0, 6) + '...' : null,
    deposit_required: DEPOSIT_ON,
    deposit_amount: DEPOSIT_VALUE,
    payment_window_minutes: Math.round(PAYMENT_WINDOW_MS / 60000),
    has_gsheet: !!GSHEET_SPREADSHEET_ID && (!!GSHEET_SA_JSON_BASE64 || (!!GSHEET_CLIENT_EMAIL && !!GSHEET_PRIVATE_KEY)),
  });
});
