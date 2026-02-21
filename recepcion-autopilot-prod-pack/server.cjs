'use strict';

/**
 * Recepción Autopilot — CEPA (WhatsApp Cloud API) — Node/Express
 * + Google Sheets panel (cases + events) con esquema REAL (A:N / A:G)
 * + MercadoPago seña (preference link)
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

// ===================== Util =====================
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

// ===================== Google Sheets =====================
// Esquemas:
// cases!A:N = created_at, case_id, wa_from, flow_type, patient_type, os_name, os_token, service_label,
//             deposit_amount, payment_link, payment_op_id, status, last_message, updated_at
// events!A:G = event_id, created_at, case_id, wa_from, event_type, payload_preview, payload

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

function parseRowFromUpdatedRange(updatedRange) {
  // Ej: "cases!A2:N2" => 2
  const m = String(updatedRange || '').match(/![A-Z]+(\d+):[A-Z]+(\d+)/);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return a; // misma fila
}

async function sheetAppend(range, values) {
  try {
    const sheets = await getSheetsClient();
    if (!sheets) return { ok: false, reason: 'missing_gsheet_env' };

    const resp = await sheets.spreadsheets.values.append({
      spreadsheetId: GSHEET_SPREADSHEET_ID,
      range,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [values] },
    });

    const updatedRange = resp?.data?.updates?.updatedRange;
    return { ok: true, updatedRange };
  } catch (e) {
    log('error', 'gsheet_append_failed', { err: String(e?.message || e), range });
    return { ok: false, reason: 'append_failed' };
  }
}

async function sheetUpdate(range, values) {
  try {
    const sheets = await getSheetsClient();
    if (!sheets) return { ok: false, reason: 'missing_gsheet_env' };

    await sheets.spreadsheets.values.update({
      spreadsheetId: GSHEET_SPREADSHEET_ID,
      range,
      valueInputOption: 'RAW',
      requestBody: { values: [values] },
    });

    return { ok: true };
  } catch (e) {
    log('error', 'gsheet_update_failed', { err: String(e?.message || e), range });
    return { ok: false, reason: 'update_failed' };
  }
}

async function sheetFindRowByValue(range, needle) {
  // range: "cases!B:B" por ejemplo
  try {
    const sheets = await getSheetsClient();
    if (!sheets) return { ok: false, reason: 'missing_gsheet_env' };

    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: GSHEET_SPREADSHEET_ID,
      range,
      majorDimension: 'COLUMNS',
    });

    const col = resp?.data?.values?.[0] || [];
    // col[0] sería header si lo pedís desde B:B (en fila 1 está case_id)
    for (let i = 0; i < col.length; i++) {
      if (String(col[i] || '').trim() === String(needle || '').trim()) {
        // i es índice 0-based dentro del array, pero fila real = i+1
        return { ok: true, row: i + 1 };
      }
    }
    return { ok: true, row: null };
  } catch (e) {
    log('error', 'gsheet_find_failed', { err: String(e?.message || e), range });
    return { ok: false, reason: 'find_failed' };
  }
}

// Cache por waId
const caseCache = new Map(); // waId -> { caseId, row, data }

function buildCaseRowFromData(d) {
  // Orden EXACTO A:N
  return [
    d.created_at || nowISO(),      // A created_at
    d.case_id || makeId('CASE'),   // B case_id
    d.wa_from || '',               // C wa_from
    d.flow_type || 'whatsapp',     // D flow_type
    d.patient_type || '',          // E patient_type
    d.os_name || '',               // F os_name
    d.os_token || '',              // G os_token
    d.service_label || '',         // H service_label
    d.deposit_amount || '',        // I deposit_amount
    d.payment_link || '',          // J payment_link
    d.payment_op_id || '',         // K payment_op_id
    d.status || 'lead',            // L status
    d.last_message || '',          // M last_message
    d.updated_at || nowISO(),      // N updated_at
  ];
}

async function ensureCase(waId, patch = {}) {
  const cur = caseCache.get(waId);

  if (!cur) {
    const caseId = makeId('CASE');
    const data = {
      created_at: nowISO(),
      case_id: caseId,
      wa_from: waId,
      flow_type: 'whatsapp',
      patient_type: patch.patient_type || '',
      os_name: patch.os_name || '',
      os_token: patch.os_token || '',
      service_label: patch.service_label || patch.label || '',
      deposit_amount: patch.deposit_amount ?? (DEPOSIT_ON ? String(DEPOSIT_VALUE) : ''),
      payment_link: patch.payment_link || '',
      payment_op_id: patch.payment_op_id || '',
      status: patch.status || 'lead',
      last_message: patch.last_message || '',
      updated_at: nowISO(),
    };

    const rowValues = buildCaseRowFromData(data);
    const ap = await sheetAppend('cases!A:N', rowValues);
    if (!ap.ok) return null;

    const row = parseRowFromUpdatedRange(ap.updatedRange);
    caseCache.set(waId, { caseId, row, data });

    return caseId;
  }

  // Update existente
  const nextData = {
    ...cur.data,
    ...patch,
    service_label: patch.service_label ?? patch.label ?? cur.data.service_label,
    updated_at: nowISO(),
  };

  // Si no tenemos row por parseo (o restart), la buscamos por case_id
  let row = cur.row;
  if (!row) {
    const found = await sheetFindRowByValue('cases!B:B', cur.caseId);
    if (found.ok && found.row) row = found.row;
  }

  // Si todavía no, no podemos updatear; al menos logueamos evento
  if (!row) {
    caseCache.set(waId, { ...cur, data: nextData });
    return cur.caseId;
  }

  const range = `cases!A${row}:N${row}`;
  await sheetUpdate(range, buildCaseRowFromData(nextData));
  caseCache.set(waId, { caseId: cur.caseId, row, data: nextData });
  return cur.caseId;
}

async function logEvent({ caseId, waId, eventType, payloadPreview, payload }) {
  const row = [
    makeId('EV'),                       // A event_id
    nowISO(),                           // B created_at
    caseId || '',                       // C case_id
    waId || '',                         // D wa_from
    eventType || '',                    // E event_type
    String(payloadPreview || '').slice(0, 220), // F payload_preview
    payload ? JSON.stringify(payload).slice(0, 45000) : '', // G payload (limit razonable)
  ];
  return sheetAppend('events!A:G', row);
}

async function registerReceiptInSheets({ waId, kind, hint, opId }) {
  const receiptId = makeId('CEPA');

  const caseId = await ensureCase(waId, {
    status: 'confirmed',
    payment_op_id: opId || hint || '',
    last_message: '',
  });

  await logEvent({
    caseId,
    waId,
    eventType: 'receipt',
    payloadPreview: `receipt_id=${receiptId} op=${String(opId || hint || '').slice(0, 80)}`,
    payload: { receiptId, opId: opId || null, hint: hint || null, kind: kind || null },
  });

  return { caseId, receiptId };
}

// ===================== MercadoPago =====================
async function createMpPreference({ caseId, waId, label, patientType, osName, osToken, amount }) {
  if (!MP_ACCESS_TOKEN) return { ok: false, reason: 'missing_mp_token' };

  const expiresFrom = new Date();
  const expiresTo = new Date(Date.now() + PAYMENT_WINDOW_MS);

  const payload = {
    items: [{
      title: `Seña - CEPA (${label || 'Turno'})`,
      quantity: 1,
      currency_id: 'ARS',
      unit_price: Number(amount),
    }],
    external_reference: caseId,
    expires: true,
    expiration_date_from: expiresFrom.toISOString(),
    expiration_date_to: expiresTo.toISOString(),
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

// ===================== CEPA Data =====================
const CEPA = {
  name: 'CEPA Consultorios (Luján de Cuyo)',
  address: 'Constitución 46, Luján de Cuyo, Mendoza',
  hours: 'Lunes a sábados · 07:30 a 21:00',
  email: 'cepadiagnosticomedicointegral@gmail.com',
  phone: '261-4987007',
  mrturno: 'https://www.mrturno.com/m/@cepa',
  disclaimer: 'Si es una urgencia, no uses este chat: llamá al 107 o acudí a guardia.',
};

const OBRAS_SOCIALES_TOP = [
  'OSDE', 'Swiss Medical', 'Galeno', 'Medifé', 'OMINT', 'SanCor Salud', 'Prevención Salud',
  'Jerárquicos Salud', 'Andes Salud', 'Nobis', 'Federada Salud', 'Medicus'
];

// ===================== Natural layer =====================
const GREETINGS = ['hola', 'holaa', 'buen dia', 'buen día', 'buenas', 'buenas tardes', 'buenas noches', 'hey', 'que tal', 'qué tal'];
const THANKS = ['gracias', 'muchas gracias', 'mil gracias', 'genial gracias', 'graciass'];
const BYE = ['chau', 'chao', 'hasta luego', 'nos vemos', 'adios', 'adiós', 'bye'];

const GREETING_REPLIES = [
  `¡Hola! 👋 Soy la recepción automática de ${CEPA.name}.\n\nRespondé con un número:\n1) Sacar turno\n2) Estudios\n3) Obras sociales\n4) Dirección/horarios\n5) Recepción`,
  `¡Buenas! 👋 Estoy para ayudarte rápido.\n1) Turno · 2) Estudios · 3) Obras sociales · 4) Dirección/horarios · 5) Recepción`,
];

const CLOSING_REPLIES = [
  `¡De nada! ✅ Si necesitás algo más, escribí “menú”.`,
  `Perfecto 🙌 Cualquier cosa, escribime “menú” y te ayudo.`,
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
  // endurecido: keyword + número largo
  const hasKeyword =
    norm.includes('comprobante') ||
    norm.includes('transfer') ||
    norm.includes('operacion') ||
    norm.includes('operación') ||
    norm.includes('op') ||
    norm.includes('id');

  const hasLongNumber = /\b\d{6,}\b/.test(norm);
  return hasKeyword && hasLongNumber;
}

// ===================== Sessions + dedupe =====================
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

// ===================== Reminder =====================
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
        status: 'awaiting_payment',
      });

      await logEvent({
        caseId,
        waId,
        eventType: 'reminder',
        payloadPreview: 'payment_reminder_sent',
        payload: { whenMs: PAYMENT_WINDOW_MS },
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

// ===================== UX copy =====================
function menuText() {
  return (
`Hola 👋 Soy la recepción automática de ${CEPA.name}.
Elegí una opción (respondé con un número):

1) Sacar turno
2) Estudios
3) Obras sociales / prepagas
4) Dirección y horarios
5) Hablar con recepción

0) Menú

${CEPA.disclaimer}`
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

Cuando tengas el turno reservado, escribime “LISTO”.`
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

// ===================== Flow =====================
async function handleUserText(waId, rawText) {
  const raw = String(rawText || '').trim();
  const firstLine = raw.split('\n').map(s => s.trim()).filter(Boolean)[0] || raw;
  const norm = normalize(firstLine);

  const session = getSession(waId);

  // Natural: saludo
  if (isGreeting(norm) && session.state === 'menu') {
    const caseId = await ensureCase(waId, { status: 'lead', last_message: raw.slice(0, 160) });
    await logEvent({ caseId, waId, eventType: 'inbound', payloadPreview: raw, payload: { text: raw } });
    return sendText(waId, randPick(GREETING_REPLIES));
  }

  // Natural: cierre (pero si espera pago, NO cortar)
  if (isThanksOrBye(norm) && session.state !== 'awaiting_payment') {
    const caseId = await ensureCase(waId, { status: 'lead', last_message: raw.slice(0, 160) });
    await logEvent({ caseId, waId, eventType: 'inbound', payloadPreview: raw, payload: { text: raw } });
    return sendText(waId, randPick(CLOSING_REPLIES));
  }

  // Comandos globales
  if (norm === '0' || norm === 'menu' || norm === 'menú' || norm === 'inicio') {
    resetSession(waId);
    const caseId = await ensureCase(waId, { status: 'lead', last_message: raw.slice(0, 160) });
    await logEvent({ caseId, waId, eventType: 'status_change', payloadPreview: 'state=menu' });
    return sendText(waId, menuText());
  }

  // Accesos rápidos
  if (norm.includes('horario') || norm.includes('direccion') || norm.includes('ubic')) {
    resetSession(waId);
    const caseId = await ensureCase(waId, { status: 'lead', last_message: raw.slice(0, 160) });
    await logEvent({ caseId, waId, eventType: 'info', payloadPreview: 'asked=contact_info' });
    return sendText(waId, infoContacto());
  }

  if (norm.includes('obra') || norm.includes('prepaga') || norm.includes('osde') || norm.includes('swiss')) {
    resetSession(waId);
    const caseId = await ensureCase(waId, { status: 'lead', last_message: raw.slice(0, 160) });
    await logEvent({ caseId, waId, eventType: 'info', payloadPreview: 'asked=insurance' });
    return sendText(
      waId,
      `Trabajamos con varias obras sociales/prepagas. Algunas frecuentes:\n• ${OBRAS_SOCIALES_TOP.join('\n• ')}\n\nSi me decís cuál tenés, te confirmo si está.`
    );
  }

  if (norm.includes('recep') || norm.includes('humano') || norm.includes('persona')) {
    setSession(waId, { state: 'handoff', context: {} });

    const caseId = await ensureCase(waId, {
      status: 'handoff',
      last_message: raw.slice(0, 160),
    });

    await logEvent({ caseId, waId, eventType: 'status_change', payloadPreview: 'state=handoff' });

    return sendText(
      waId,
      `Listo ✅ Te paso con recepción.\nContame en 1 línea qué necesitás (especialidad/estudio + día preferido).`
    );
  }

  // Si espera pago y manda “ID ...”
  if (session.state === 'awaiting_payment') {
    // Detecta IDs comunes: "ID 123", "op 123", "operación 123", etc.
    const m = raw.match(/\b(id|op|operacion|operación)\b[\s:#-]*([0-9]{6,})/i);
    if (m) {
      const opId = m[2];
      const { receiptId } = await registerReceiptInSheets({
        waId,
        kind: session.context?.type || 'unknown',
        hint: raw.trim().slice(0, 140),
        opId,
      });

      resetSession(waId);
      await sendText(waId, receiptAckText(receiptId));
      return sendText(waId, finalConfirmedText(receiptId));
    }

    // Mantener recordatorio
    schedulePaymentReminder(waId);
    const caseId = await ensureCase(waId, { status: 'awaiting_payment', last_message: raw.slice(0, 160) });
    await logEvent({ caseId, waId, eventType: 'inbound', payloadPreview: raw, payload: { text: raw } });

    // Si insiste con números sin keyword, NO confirmar.
    return sendText(waId, `Cuando pagues, mandame el *ID de operación* (por ejemplo: “ID 123456789”) o una *captura* ✅`);
  }

  // Máquina de estados (simple)
  if (session.state === 'menu') {
    const caseId = await ensureCase(waId, { status: 'lead', last_message: raw.slice(0, 160) });
    await logEvent({ caseId, waId, eventType: 'inbound', payloadPreview: raw, payload: { text: raw } });

    if (norm === '1') {
      setSession(waId, { state: 'awaiting_mrturno_done', context: { type: 'turno', label: 'Turno' } });
      await ensureCase(waId, { service_label: 'Turno', status: 'awaiting_mrturno' });
      return sendText(waId, mrturnoText('Perfecto ✅'));
    }

    if (norm === '2') {
      setSession(waId, { state: 'awaiting_mrturno_done', context: { type: 'estudio', label: 'Estudios' } });
      await ensureCase(waId, { service_label: 'Estudios', status: 'awaiting_mrturno' });
      return sendText(waId, mrturnoText('Perfecto ✅'));
    }

    if (norm === '3') {
      resetSession(waId);
      return sendText(
        waId,
        `Obras sociales/prepagas: decime cuál tenés.\nAlgunas frecuentes:\n• ${OBRAS_SOCIALES_TOP.join('\n• ')}`
      );
    }

    if (norm === '4') {
      resetSession(waId);
      return sendText(waId, infoContacto());
    }

    if (norm === '5') {
      setSession(waId, { state: 'handoff', context: {} });
      await ensureCase(waId, { status: 'handoff' });
      return sendText(waId, `Dale ✅ Contame en 1 línea qué necesitás (especialidad/estudio + día preferido).`);
    }

    return sendText(waId, menuText());
  }

  if (session.state === 'awaiting_mrturno_done') {
    // LISTO => pedir tipo paciente
    if (norm === 'listo' || norm === 'ok' || norm === 'dale' || norm === 'ya') {
      setSession(waId, { state: 'ask_patient_type', context: { ...session.context } });
      await ensureCase(waId, { status: 'awaiting_patient_type' });
      return sendText(waId, patientTypePrompt());
    }

    // si manda otra cosa, insistimos suave
    const caseId = await ensureCase(waId, { status: 'awaiting_mrturno', last_message: raw.slice(0, 160) });
    await logEvent({ caseId, waId, eventType: 'inbound', payloadPreview: raw, payload: { text: raw } });
    return sendText(waId, `Cuando tengas el turno en MrTurno, escribime “LISTO” ✅`);
  }

  if (session.state === 'ask_patient_type') {
    if (norm === '1') {
      const { label } = session.context || {};
      const caseId = await ensureCase(waId, {
        patient_type: 'particular',
        service_label: label || '',
        status: 'awaiting_payment',
        deposit_amount: DEPOSIT_ON ? String(DEPOSIT_VALUE) : '',
      });

      await logEvent({ caseId, waId, eventType: 'patient_type', payloadPreview: 'particular' });

      const mp = await createMpPreference({
        caseId,
        waId,
        label,
        patientType: 'particular',
        amount: DEPOSIT_VALUE,
      });

      if (!mp.ok) {
        await ensureCase(waId, { status: 'handoff' });
        return sendText(waId, `Perfecto ✅ Ahora mismo no pude generar el link.\nEscribí “recepción” y te lo resuelven.`);
      }

      await ensureCase(waId, { payment_link: mp.init_point, status: 'awaiting_payment' });
      await logEvent({ caseId, waId, eventType: 'mp_link', payloadPreview: 'mp_link_created', payload: mp });

      setSession(waId, { state: 'awaiting_payment', context: { ...session.context, mp } });
      schedulePaymentReminder(waId);

      return sendText(waId, paymentLinkText(mp.init_point));
    }

    if (norm === '2') {
      setSession(waId, { state: 'ask_os_name', context: { ...session.context, patientType: 'obra_social' } });
      await ensureCase(waId, { patient_type: 'obra_social', status: 'awaiting_os_name' });
      return sendText(waId, askOsNameText());
    }

    return sendText(waId, `Respondeme 1 (Particular) o 2 (Obra social).`);
  }

  if (session.state === 'ask_os_name') {
    // Evitar que un número se guarde como obra social
    if (/^\d{6,}$/.test(raw)) {
      return sendText(waId, 'Decime el *nombre* de tu obra social (ej: OSDE, Swiss Medical, Galeno).');
    }

    setSession(waId, { state: 'ask_os_token', context: { ...session.context, osName: raw.trim() } });
    await ensureCase(waId, { os_name: raw.trim(), status: 'awaiting_os_token' });
    return sendText(waId, askOsTokenText());
  }

  if (session.state === 'ask_os_token') {
    const { label } = session.context || {};
    const osName = session.context?.osName || '';
    const osToken = raw.trim();

    const caseId = await ensureCase(waId, {
      os_name: osName,
      os_token: osToken,
      service_label: label || '',
      status: 'awaiting_payment',
      deposit_amount: DEPOSIT_ON ? String(DEPOSIT_VALUE) : '',
      last_message: raw.slice(0, 160),
    });

    await logEvent({
      caseId,
      waId,
      eventType: 'os_data',
      payloadPreview: `os=${osName} token=${osToken.slice(0, 80)}`,
      payload: { osName, osToken },
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

    if (!mp.ok) {
      await ensureCase(waId, { status: 'handoff' });
      return sendText(waId, `Listo ✅ Tomé tus datos.\nAhora no pude generar el link.\nEscribí “recepción” y te lo hacen manual.`);
    }

    await ensureCase(waId, { payment_link: mp.init_point, status: 'awaiting_payment' });
    await logEvent({ caseId, waId, eventType: 'mp_link', payloadPreview: 'mp_link_created', payload: mp });

    setSession(waId, { state: 'awaiting_payment', context: { ...session.context, osToken, mp } });
    schedulePaymentReminder(waId);

    return sendText(waId, paymentLinkText(mp.init_point));
  }

  if (session.state === 'handoff') {
    resetSession(waId);
    const caseId = await ensureCase(waId, { status: 'handoff', last_message: raw.slice(0, 160) });
    await logEvent({ caseId, waId, eventType: 'handoff', payloadPreview: raw, payload: { text: raw } });
    return sendText(waId, `Perfecto ✅ Ya quedó. En breve te responde recepción.\n\nMientras tanto: ${CEPA.mrturno}`);
  }

  // default
  resetSession(waId);
  const caseId = await ensureCase(waId, { status: 'lead', last_message: raw.slice(0, 160) });
  await logEvent({ caseId, waId, eventType: 'fallback', payloadPreview: raw });
  return sendText(waId, menuText());
}

// ===================== Health + privacidad =====================
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

// ===================== Webhook verify (GET) =====================
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

// ===================== Webhook messages (POST) =====================
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

      if (s.state === 'awaiting_payment') {
        const { receiptId } = await registerReceiptInSheets({
          waId: from,
          kind: s.context?.type || 'unknown',
          hint: 'media',
          opId: null,
        });

        resetSession(from);
        await sendText(from, receiptAckText(receiptId));
        await sendText(from, finalConfirmedText(receiptId));
        return;
      }

      const caseId = await ensureCase(from, { status: 'lead', last_message: 'media_received' });
      await logEvent({ caseId, waId: from, eventType: 'inbound_media', payloadPreview: 'media', payload: { media: true } });

      await sendText(from, `Recibido ✅ ¿Querés sacar turno o necesitás recepción?\n\n${menuText()}`);
      return;
    }

    if (!text.trim()) {
      resetSession(from);
      const caseId = await ensureCase(from, { status: 'lead', last_message: '(empty_text)' });
      await logEvent({ caseId, waId: from, eventType: 'inbound', payloadPreview: '(empty_text)' });
      return sendText(from, menuText());
    }

    // Persist mínimo (case + event)
    const caseId = await ensureCase(from, { status: 'lead', last_message: text.slice(0, 160) });
    await logEvent({ caseId, waId: from, eventType: 'inbound', payloadPreview: text, payload: { text } });

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

// ===================== Start =====================
const port = Number(PORT);
app.listen(port, '0.0.0.0', () => {
  log('info', 'server_started', {
    port,
    has_WA_ACCESS_TOKEN: !!WA_ACCESS_TOKEN,
    has_WA_VERIFY_TOKEN: !!WA_VERIFY_TOKEN,
    has_WA_PHONE_NUMBER_ID: !!WA_PHONE_NUMBER_ID,
    has_mp: !!MP_ACCESS_TOKEN,
    deposit_required: DEPOSIT_ON,
    deposit_amount: DEPOSIT_VALUE,
    payment_window_minutes: Math.round(PAYMENT_WINDOW_MS / 60000),
    has_gsheet:
      !!GSHEET_SPREADSHEET_ID &&
      (!!GSHEET_SA_JSON_BASE64 || (!!GSHEET_CLIENT_EMAIL && !!GSHEET_PRIVATE_KEY)),
  });
});
