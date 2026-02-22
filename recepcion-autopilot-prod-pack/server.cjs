'use strict';

/**
 * CEPA Recepción Autopilot — WhatsApp Cloud API — Node/Express
 * + Google Sheets (cases A:N update 1 fila por caso, events A:G append histórico)
 * + MercadoPago seña (preference init_point)
 *
 * Fixes:
 * ✅ GSHEET_ID alias (Render usa GSHEET_ID)
 * ✅ State-first: no pisa ask_os_name/ask_os_token con atajos
 * ✅ Atajo OSDE/obra social SOLO en menu
 * ✅ cases = UPDATE (1 fila) / events = APPEND (histórico)
 * ✅ Logs gsheet_ready + gsheet_append + gsheet_update
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

  // Google Sheets (Render suele tener GSHEET_ID)
  GSHEET_SPREADSHEET_ID,
  GSHEET_ID,
  GSHEET_SA_JSON_BASE64,
  GSHEET_CLIENT_EMAIL,
  GSHEET_PRIVATE_KEY,
} = process.env;

const SPREADSHEET_ID = GSHEET_SPREADSHEET_ID || GSHEET_ID; // ✅ alias
const STARTED_AT = Date.now();

// ========== Util ==========
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

function nowISO() {
  return new Date().toISOString();
}

function makeId(prefix = 'ID') {
  const ts = Date.now().toString(36).toUpperCase();
  const r = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `${prefix}-${ts}-${r}`;
}

function moneyARS(n) {
  try {
    return new Intl.NumberFormat('es-AR').format(n);
  } catch {
    return String(n);
  }
}

function extractOpId(text) {
  const s = String(text || '');
  const m = s.match(/\b(id|op|operacion|operación)\b[\s:#-]*([0-9]{6,})/i);
  if (m) return m[2];
  const n = s.match(/\b(\d{10,})\b/); // fallback largo
  return n ? n[1] : '';
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

// ========== Google Sheets ==========
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
  if (!sa || !SPREADSHEET_ID) return null;

  const auth = new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  return google.sheets({ version: 'v4', auth });
}

function parseRowFromUpdatedRange(updatedRange) {
  // ej: "cases!A12:N12" => 12
  const m = String(updatedRange || '').match(/![A-Z]+(\d+):[A-Z]+(\d+)/);
  if (!m) return null;
  return Number(m[1]) || null;
}

async function sheetAppendWithRow(range, values) {
  try {
    const sheets = await getSheetsClient();
    if (!sheets) return { ok: false, reason: 'missing_gsheet_env' };

    log('info', 'gsheet_append', { range });

    const resp = await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [values] },
    });

    const updatedRange = resp?.data?.updates?.updatedRange;
    const row = parseRowFromUpdatedRange(updatedRange);
    return { ok: true, row, updatedRange };
  } catch (e) {
    log('error', 'gsheet_append_failed', { err: String(e?.message || e), range });
    return { ok: false, reason: 'append_failed' };
  }
}

async function sheetAppend(range, values) {
  // simple append (events)
  try {
    const sheets = await getSheetsClient();
    if (!sheets) return { ok: false, reason: 'missing_gsheet_env' };

    log('info', 'gsheet_append', { range });

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
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

async function sheetUpdate(range, values) {
  try {
    const sheets = await getSheetsClient();
    if (!sheets) return { ok: false, reason: 'missing_gsheet_env' };

    log('info', 'gsheet_update', { range });

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
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

// Schema EXACTO:
// cases A:N = created_at, case_id, wa_from, flow_type, patient_type, os_name, os_token, service_label,
//             deposit_amount, payment_link, payment_op_id, status, last_message, updated_at
// events A:G = event_id, created_at, case_id, wa_from, event_type, payload_preview, payload

const caseStore = new Map(); // waId -> { caseId, row, data }

function buildCaseRow(waId, caseId, data) {
  return [
    data.created_at || nowISO(), // A created_at
    caseId, // B case_id
    waId, // C wa_from
    data.flow_type || 'whatsapp', // D flow_type
    data.patient_type || '', // E patient_type
    data.os_name || '', // F os_name
    data.os_token || '', // G os_token
    data.service_label || '', // H service_label
    data.deposit_amount ?? (DEPOSIT_ON ? String(DEPOSIT_VALUE) : ''), // I deposit_amount
    data.payment_link || '', // J payment_link
    data.payment_op_id || '', // K payment_op_id
    data.status || 'lead', // L status
    data.last_message || '', // M last_message
    nowISO(), // N updated_at
  ];
}

async function getOrCreateCaseId(waId) {
  const cur = caseStore.get(waId);
  if (cur?.caseId) return cur.caseId;

  const caseId = makeId('CASE');
  const created_at = nowISO();
  const data = { created_at, status: 'lead' };
  const rowValues = buildCaseRow(waId, caseId, data);

  const ap = await sheetAppendWithRow('cases!A:N', rowValues);
  const row = ap.ok ? ap.row : null;

  caseStore.set(waId, { caseId, row, data });
  return caseId;
}

async function upsertCase(waId, patch = {}) {
  const cur = caseStore.get(waId);

  if (!cur) {
    const caseId = makeId('CASE');
    const data = { created_at: nowISO(), ...patch };
    const rowValues = buildCaseRow(waId, caseId, data);

    const ap = await sheetAppendWithRow('cases!A:N', rowValues);
    const row = ap.ok ? ap.row : null;

    caseStore.set(waId, { caseId, row, data });
    return { ok: ap.ok, caseId, row };
  }

  const nextData = { ...cur.data, ...patch };
  const rowValues = buildCaseRow(waId, cur.caseId, nextData);

  if (cur.row) {
    await sheetUpdate(`cases!A${cur.row}:N${cur.row}`, rowValues);
  } else {
    // fallback: si no tenemos row (reinicios), append como plan B
    const ap = await sheetAppendWithRow('cases!A:N', rowValues);
    if (ap.ok && ap.row) cur.row = ap.row;
  }

  caseStore.set(waId, { ...cur, data: nextData });
  return { ok: true, caseId: cur.caseId, row: cur.row };
}

async function logEvent(waId, caseId, eventType, payloadPreview, payloadObj) {
  await sheetAppend('events!A:G', [
    makeId('EV'),
    nowISO(),
    caseId || '',
    waId || '',
    eventType || '',
    String(payloadPreview || '').slice(0, 220),
    payloadObj ? JSON.stringify(payloadObj).slice(0, 45000) : '',
  ]);
}

// ========== MercadoPago ==========
async function createMpPreference({ caseId, waId, label, patientType, osName, osToken, amount }) {
  if (!MP_ACCESS_TOKEN) return { ok: false, reason: 'missing_mp_token' };

  const expiresFrom = new Date();
  const expiresTo = new Date(Date.now() + PAYMENT_WINDOW_MS);

  const payload = {
    items: [
      {
        title: `Seña - CEPA (${label || 'Turno'})`,
        quantity: 1,
        currency_id: 'ARS',
        unit_price: Number(amount),
      },
    ],
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
    try {
      j = await resp.json();
    } catch {}
    log('error', 'mp_preference_failed', { status: resp.status, err: j });
    return { ok: false, status: resp.status, err: j };
  }

  const data = await resp.json();
  return { ok: true, init_point: data.init_point, pref_id: data.id };
}

// ========== Data + Copy ==========
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
  'OSDE',
  'Swiss Medical',
  'Galeno',
  'Medifé',
  'OMINT',
  'SanCor Salud',
  'Prevención Salud',
  'Jerárquicos Salud',
  'Andes Salud',
  'Nobis',
  'Federada Salud',
  'Medicus',
];

function menuText() {
  return `Hola 👋 Soy la recepción automática de ${CEPA.name}.
Elegí una opción (respondé con un número):

1) Sacar turno
2) Estudios
3) Obras sociales / prepagas
4) Dirección y horarios
5) Hablar con recepción

0) Menú

${CEPA.disclaimer}`;
}

function infoContacto() {
  return `📍 ${CEPA.address}
🕒 ${CEPA.hours}
📞 Tel: ${CEPA.phone}
✉️ Email: ${CEPA.email}`;
}

function mrTurnoText(extra) {
  return `${extra ? extra + '\n\n' : ''}Para elegir día y horario usá MrTurno:
${CEPA.mrturno}

Cuando tengas el turno reservado, escribime “LISTO”.`;
}

function patientTypePrompt() {
  return `¿Sos:
1) Particular
2) Obra social

(Respondé 1 o 2)`;
}

function askOsNameText() {
  return `Dale ✅ ¿Qué obra social tenés? (ej: OSDE, Swiss Medical, Galeno)`;
}

function askOsTokenText() {
  return `Perfecto ✅ Ahora pasame *token/afiliado* y *DNI* en una sola línea.
Ej: "Token 123456 - DNI 30111222"`;
}

function paymentLinkText(url) {
  return `Perfecto ✅ Para confirmar necesitamos una seña de $${moneyARS(DEPOSIT_VALUE)}.

🔗 Link de pago: ${url}

Cuando pagues, mandame el *ID de operación* (por ejemplo: "ID 123456789") o una *captura* y queda confirmado.`;
}

function receiptAckText(receiptId) {
  return `Recibido ✅ Ya registré tu pago.

🧾 Comprobante: ${receiptId}`;
}

function finalConfirmedText(receiptId) {
  return `Listo ✅ Turno confirmado.
🧾 Comprobante: ${receiptId}

${infoContacto()}

Si necesitás reprogramar, escribí “recepción”.`;
}

// ========== Sessions ==========
const sessions = new Map(); // waId -> { state, ctx, updatedAt }
const SESSION_TTL_MS = 60 * 60 * 1000;

function getSession(waId) {
  return sessions.get(waId) || { state: 'menu', ctx: {}, updatedAt: Date.now() };
}
function setSession(waId, state, ctxPatch = {}) {
  const cur = getSession(waId);
  const next = { state, ctx: { ...cur.ctx, ...ctxPatch }, updatedAt: Date.now() };
  sessions.set(waId, next);
  return next;
}
function resetSession(waId) {
  sessions.set(waId, { state: 'menu', ctx: {}, updatedAt: Date.now() });
}

setInterval(() => {
  const now = Date.now();
  for (const [k, s] of sessions.entries()) {
    if (!s?.updatedAt || now - s.updatedAt > SESSION_TTL_MS) sessions.delete(k);
  }
}, 60 * 1000).unref();

// ========== Dedupe Meta retries ==========
const seenMsg = new Map(); // msgId -> ts
const SEEN_TTL_MS = 10 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, ts] of seenMsg.entries()) {
    if (!ts || now - ts > SEEN_TTL_MS) seenMsg.delete(id);
  }
}, 60 * 1000).unref();

// ========== Core Flow (STATE-FIRST) ==========
async function handleUserText(waId, rawText) {
  const raw = String(rawText || '').trim();
  const firstLine = raw.split('\n').map((s) => s.trim()).filter(Boolean)[0] || raw;
  const norm = normalize(firstLine);

  const s = getSession(waId);
  const caseId = await getOrCreateCaseId(waId);

  // -------- STATE-FIRST --------
  if (s.state === 'awaiting_mrturno_done') {
    if (norm === 'listo' || norm === 'ok' || norm === 'dale' || norm === 'ya') {
      setSession(waId, 'ask_patient_type', { flow: s.ctx.flow, label: s.ctx.label });
      await upsertCase(waId, { flow_type: s.ctx.flow, service_label: s.ctx.label, status: 'awaiting_patient_type', last_message: raw.slice(0, 160) });
      await logEvent(waId, caseId, 'state', 'ask_patient_type', { from: s.state });
      return sendText(waId, patientTypePrompt());
    }
    await upsertCase(waId, { flow_type: s.ctx.flow, service_label: s.ctx.label, status: 'awaiting_mrturno', last_message: raw.slice(0, 160) });
    return sendText(waId, `Cuando tengas el turno en MrTurno, escribime “LISTO” ✅`);
  }

  if (s.state === 'ask_patient_type') {
    if (norm === '1') {
      const flow = s.ctx.flow || 'turno';
      const label = s.ctx.label || 'Turno';

      await upsertCase(waId, { flow_type: flow, patient_type: 'particular', service_label: label, status: 'awaiting_payment', last_message: raw.slice(0, 160) });

      const mp = await createMpPreference({
        caseId,
        waId,
        label,
        patientType: 'particular',
        amount: DEPOSIT_VALUE,
      });

      if (!mp.ok) {
        setSession(waId, 'handoff', {});
        await upsertCase(waId, { flow_type: flow, patient_type: 'particular', service_label: label, status: 'mp_failed', last_message: 'mp_failed' });
        return sendText(waId, `Ahora mismo no pude generar el link. Escribí “recepción” y te lo resuelven ✅`);
      }

      setSession(waId, 'awaiting_payment', { flow, label, patientType: 'particular', mpLink: mp.init_point });
      await upsertCase(waId, { flow_type: flow, patient_type: 'particular', service_label: label, payment_link: mp.init_point, status: 'awaiting_payment', last_message: 'mp_link_sent' });
      await logEvent(waId, caseId, 'mp_link', 'mp_link_created', mp);

      return sendText(waId, paymentLinkText(mp.init_point));
    }

    if (norm === '2') {
      setSession(waId, 'ask_os_name', { flow: s.ctx.flow, label: s.ctx.label, patientType: 'obra_social' });
      await upsertCase(waId, { flow_type: s.ctx.flow, patient_type: 'obra_social', service_label: s.ctx.label, status: 'awaiting_os_name', last_message: raw.slice(0, 160) });
      return sendText(waId, askOsNameText());
    }

    return sendText(waId, `Respondeme 1 (Particular) o 2 (Obra social).`);
  }

  if (s.state === 'ask_os_name') {
    if (/^\d{6,}$/.test(raw)) {
      return sendText(waId, 'Decime el *nombre* de tu obra social (ej: OSDE, Swiss Medical, Galeno).');
    }

    setSession(waId, 'ask_os_token', { ...s.ctx, osName: raw.trim() });
    await upsertCase(waId, { flow_type: s.ctx.flow, patient_type: 'obra_social', os_name: raw.trim(), service_label: s.ctx.label, status: 'awaiting_os_token', last_message: raw.slice(0, 160) });
    return sendText(waId, askOsTokenText());
  }

  if (s.state === 'ask_os_token') {
    const flow = s.ctx.flow || 'turno';
    const label = s.ctx.label || 'Turno';
    const osName = s.ctx.osName || '';
    const osToken = raw.trim();

    await upsertCase(waId, { flow_type: flow, patient_type: 'obra_social', os_name: osName, os_token: osToken, service_label: label, status: 'awaiting_payment', last_message: raw.slice(0, 160) });
    await logEvent(waId, caseId, 'os_data', 'os_token_received', { osName, osToken });

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
      setSession(waId, 'handoff', {});
      await upsertCase(waId, { flow_type: flow, patient_type: 'obra_social', os_name: osName, os_token: osToken, service_label: label, status: 'mp_failed', last_message: 'mp_failed' });
      return sendText(waId, `Listo ✅ Tomé tus datos.\nAhora no pude generar el link.\nEscribí “recepción” y te lo hacen manual.`);
    }

    setSession(waId, 'awaiting_payment', { flow, label, patientType: 'obra_social', osName, osToken, mpLink: mp.init_point });
    await upsertCase(waId, { flow_type: flow, patient_type: 'obra_social', os_name: osName, os_token: osToken, service_label: label, payment_link: mp.init_point, status: 'awaiting_payment', last_message: 'mp_link_sent' });
    await logEvent(waId, caseId, 'mp_link', 'mp_link_created', mp);

    return sendText(waId, paymentLinkText(mp.init_point));
  }

  if (s.state === 'awaiting_payment') {
    const opId = extractOpId(raw);
    if (opId) {
      const receiptId = makeId('CEPA');
      resetSession(waId);

      await upsertCase(waId, {
        flow_type: s.ctx.flow,
        patient_type: s.ctx.patientType,
        os_name: s.ctx.osName || '',
        os_token: s.ctx.osToken || '',
        service_label: s.ctx.label || '',
        deposit_amount: String(DEPOSIT_VALUE),
        payment_link: s.ctx.mpLink || '',
        payment_op_id: opId,
        status: 'confirmed',
        last_message: raw.slice(0, 160),
      });

      await logEvent(waId, caseId, 'receipt', `receipt=${receiptId} op=${opId}`, { receiptId, opId });
      await sendText(waId, receiptAckText(receiptId));
      return sendText(waId, finalConfirmedText(receiptId));
    }

    await upsertCase(waId, { status: 'awaiting_payment', last_message: raw.slice(0, 160) });
    return sendText(waId, `Cuando pagues, mandame el *ID de operación* (ej: “ID 123456789”) o una *captura* ✅`);
  }

  // -------- Atajos SOLO en menú --------
  if (s.state === 'menu') {
    if (norm === '0' || norm === 'menu' || norm === 'menú' || norm === 'inicio') {
      resetSession(waId);
      await upsertCase(waId, { status: 'menu', last_message: raw.slice(0, 160) });
      return sendText(waId, menuText());
    }

    // atajo OS/prepagas solo en menu
    if (norm.includes('obra') || norm.includes('prepaga') || norm.includes('osde') || norm.includes('swiss')) {
      await upsertCase(waId, { status: 'info_os', last_message: raw.slice(0, 160) });
      return sendText(
        waId,
        `Trabajamos con varias obras sociales/prepagas. Algunas frecuentes:\n• ${OBRAS_SOCIALES_TOP.join('\n• ')}\n\nSi me decís cuál tenés, te confirmo si está.`
      );
    }

    if (norm === '1') {
      setSession(waId, 'awaiting_mrturno_done', { flow: 'turno', label: 'Turno' });
      await upsertCase(waId, { flow_type: 'turno', service_label: 'Turno', status: 'awaiting_mrturno', last_message: raw.slice(0, 160) });
      return sendText(waId, mrTurnoText('Perfecto ✅'));
    }

    if (norm === '2') {
      setSession(waId, 'awaiting_mrturno_done', { flow: 'estudio', label: 'Estudios' });
      await upsertCase(waId, { flow_type: 'estudio', service_label: 'Estudios', status: 'awaiting_mrturno', last_message: raw.slice(0, 160) });
      return sendText(waId, mrTurnoText('Perfecto ✅'));
    }

    if (norm === '3') {
      await upsertCase(waId, { status: 'info_os', last_message: raw.slice(0, 160) });
      return sendText(
        waId,
        `Trabajamos con varias obras sociales/prepagas. Algunas frecuentes:\n• ${OBRAS_SOCIALES_TOP.join('\n• ')}\n\nSi me decís cuál tenés, te confirmo si está.`
      );
    }

    if (norm === '4') {
      await upsertCase(waId, { status: 'info_contacto', last_message: raw.slice(0, 160) });
      return sendText(waId, infoContacto());
    }

    if (norm === '5' || norm.includes('recep') || norm.includes('humano')) {
      setSession(waId, 'handoff', {});
      await upsertCase(waId, { status: 'handoff', last_message: raw.slice(0, 160) });
      return sendText(waId, `Listo ✅ Te paso con recepción.\nContame en 1 línea qué necesitás (especialidad/estudio + día preferido).`);
    }

    await upsertCase(waId, { status: 'menu', last_message: raw.slice(0, 160) });
    return sendText(waId, menuText());
  }

  // fallback total
  resetSession(waId);
  await upsertCase(waId, { status: 'fallback', last_message: raw.slice(0, 160) });
  return sendText(waId, menuText());
}

// ========== Webhook Verify ==========
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

// ========== Webhook POST ==========
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
    if (msgId) {
      if (seenMsg.has(msgId)) {
        log('info', 'wa_dedup_ignored', { msgId });
        return;
      }
      seenMsg.set(msgId, Date.now());
    }

    const from = msg.from;
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
      const caseId = await getOrCreateCaseId(from);

      // si está esperando pago, con media confirmamos igual (sin op id)
      if (s.state === 'awaiting_payment') {
        const receiptId = makeId('CEPA');
        resetSession(from);

        await upsertCase(from, {
          flow_type: s.ctx.flow,
          patient_type: s.ctx.patientType,
          os_name: s.ctx.osName || '',
          os_token: s.ctx.osToken || '',
          service_label: s.ctx.label || '',
          deposit_amount: String(DEPOSIT_VALUE),
          payment_link: s.ctx.mpLink || '',
          payment_op_id: '',
          status: 'confirmed',
          last_message: 'media_proof',
        });

        await logEvent(from, caseId, 'receipt_media', `receipt=${receiptId}`, { receiptId });
        await sendText(from, receiptAckText(receiptId));
        await sendText(from, finalConfirmedText(receiptId));
        return;
      }

      await upsertCase(from, { status: 'media_received', last_message: 'media' });
      return sendText(from, `Recibido ✅\n\n${menuText()}`);
    }

    if (!text.trim()) return sendText(from, menuText());

    await handleUserText(from, text);
  } catch (e) {
    log('error', 'wa_handle_failed', { err: String(e?.message || e) });
  }
}

// ========== Routes ==========
app.get('/health', (_req, res) =>
  res.status(200).json({ ok: true, uptime_s: Math.floor((Date.now() - STARTED_AT) / 1000) })
);

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

app.get('/api/whatsapp', verifyHandler);
app.get('/webhook', verifyHandler);
app.post('/api/whatsapp', express.raw({ type: '*/*', limit: '2mb' }), postHandler);
app.post('/webhook', express.raw({ type: '*/*', limit: '2mb' }), postHandler);

// ========== Start ==========
const port = Number(PORT);
app.listen(port, '0.0.0.0', () => {
  const hasGsheet = !!SPREADSHEET_ID && (!!GSHEET_SA_JSON_BASE64 || (!!GSHEET_CLIENT_EMAIL && !!GSHEET_PRIVATE_KEY));
  log('info', 'gsheet_ready', {
    has_gsheet: hasGsheet,
    has_sheet_id: !!SPREADSHEET_ID,
    sheet_id_preview: SPREADSHEET_ID ? String(SPREADSHEET_ID).slice(0, 8) + '...' : null,
  });

  log('info', 'server_started', {
    port,
    has_WA_ACCESS_TOKEN: !!WA_ACCESS_TOKEN,
    has_WA_VERIFY_TOKEN: !!WA_VERIFY_TOKEN,
    has_WA_PHONE_NUMBER_ID: !!WA_PHONE_NUMBER_ID,
    has_mp: !!MP_ACCESS_TOKEN,
    deposit_required: DEPOSIT_ON,
    deposit_amount: DEPOSIT_VALUE,
    payment_window_minutes: Math.round(PAYMENT_WINDOW_MS / 60000),
    has_gsheet: hasGsheet,
  });
});
