'use strict';

// ================= Imports (FIX) =================
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const { google } = require('googleapis');

// ================= App =================
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

// ================= ENV =================
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

  // MrTurno override opcional
  MR_TURNO_URL,

  // Google Sheets
  GSHEET_SPREADSHEET_ID,
  GSHEET_ID,
  GSHEET_SA_JSON_BASE64,
  GSHEET_CLIENT_EMAIL,
  GSHEET_PRIVATE_KEY,
} = process.env;

const SPREADSHEET_ID = GSHEET_SPREADSHEET_ID || GSHEET_ID;

const STARTED_AT = Date.now();

// ================= Util =================
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
  if (!appSecret) return true; // permitido, pero no ideal
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
  try { return new Intl.NumberFormat('es-AR').format(n); }
  catch { return String(n); }
}

function extractOpId(text) {
  const s = String(text || '');
  const m = s.match(/\b(id|op|operacion|operación)\b[\s:#-]*([0-9]{6,})/i);
  if (m) return m[2];
  const n = s.match(/\b(\d{10,})\b/); // fallback largo
  return n ? n[1] : '';
}

function looksPaidIntent(norm) {
  // “pagué / pague / ya / listo / ok / transferí / aboné”
  return (
    norm === 'pague' ||
    norm === 'pagué' ||
    norm === 'pago' ||
    norm === 'pagado' ||
    norm === 'ya' ||
    norm === 'listo' ||
    norm === 'ok' ||
    norm.includes('ya pag') ||
    norm.includes('abon') ||
    norm.includes('transfer')
  );
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

// ================= Google Sheets (UPSERT cases) =================
const SHEET_CASES = 'cases';
const SHEET_EVENTS = 'events';

// cases A:N
// A created_at, B case_id, C wa_from, D flow_type, E patient_type, F os_name, G os_token, H service_label,
// I deposit_amount, J payment_link, K payment_op_id, L status, M last_message, N updated_at

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

let sheetsClientPromise = null;
async function getSheetsClient() {
  if (sheetsClientPromise) return sheetsClientPromise;

  sheetsClientPromise = (async () => {
    const sa = getServiceAccount();
    if (!sa || !SPREADSHEET_ID) return null;

    const auth = new google.auth.JWT({
      email: sa.client_email,
      key: sa.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    return google.sheets({ version: 'v4', auth });
  })();

  return sheetsClientPromise;
}

async function sheetGet(range) {
  const sheets = await getSheetsClient();
  if (!sheets) return { ok: false, reason: 'missing_gsheet_env' };
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range,
  });
  return { ok: true, values: r.data.values || [] };
}

async function sheetAppend(range, values) {
  try {
    const sheets = await getSheetsClient();
    if (!sheets) return { ok: false, reason: 'missing_gsheet_env' };

    log('info', 'gsheet_append', { range });
    const r = await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [values] },
    });

    const updatedRange = r?.data?.updates?.updatedRange || '';
    return { ok: true, updatedRange };
  } catch (e) {
    log('error', 'gsheet_append_failed', { err: String(e?.message || e), range });
    return { ok: false, reason: 'append_failed' };
  }
}

async function sheetUpdateRow(rowNumber, values) {
  try {
    const sheets = await getSheetsClient();
    if (!sheets) return { ok: false, reason: 'missing_gsheet_env' };

    const range = `${SHEET_CASES}!A${rowNumber}:N${rowNumber}`;
    log('info', 'gsheet_update', { range });

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range,
      valueInputOption: 'RAW',
      requestBody: { values: [values] },
    });

    return { ok: true };
  } catch (e) {
    log('error', 'gsheet_update_failed', { err: String(e?.message || e), rowNumber });
    return { ok: false, reason: 'update_failed' };
  }
}

async function sheetBatchUpdate(pairs) {
  try {
    const sheets = await getSheetsClient();
    if (!sheets) return { ok: false, reason: 'missing_gsheet_env' };

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        valueInputOption: 'RAW',
        data: pairs,
      },
    });

    return { ok: true };
  } catch (e) {
    log('error', 'gsheet_batch_failed', { err: String(e?.message || e) });
    return { ok: false, reason: 'batch_failed' };
  }
}

function normalizeRowLen(arr, len) {
  const v = Array.isArray(arr) ? [...arr] : [];
  while (v.length < len) v.push('');
  return v.slice(0, len);
}

function rowToCaseObj(row) {
  const v = normalizeRowLen(row, 14);
  return {
    created_at: v[0] || '',
    case_id: v[1] || '',
    wa_from: v[2] || '',
    flow_type: v[3] || 'whatsapp',
    patient_type: v[4] || '',
    os_name: v[5] || '',
    os_token: v[6] || '',
    service_label: v[7] || '',
    deposit_amount: v[8] || '',
    payment_link: v[9] || '',
    payment_op_id: v[10] || '',
    status: v[11] || 'lead',
    last_message: v[12] || '',
    updated_at: v[13] || '',
  };
}

function caseObjToRow(c) {
  return normalizeRowLen([
    c.created_at,
    c.case_id,
    c.wa_from,
    c.flow_type,
    c.patient_type,
    c.os_name,
    c.os_token,
    c.service_label,
    c.deposit_amount,
    c.payment_link,
    c.payment_op_id,
    c.status,
    c.last_message,
    c.updated_at,
  ], 14);
}

// Cache: waId -> { rowNumber, caseObj }
const caseCache = new Map();

async function findCaseRowByWa(waId) {
  // Lee B:C (case_id, wa_from)
  const r = await sheetGet(`${SHEET_CASES}!B:C`);
  if (!r.ok) return null;

  const values = r.values || [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i] || [];
    const caseId = row[0] || '';
    const wa = row[1] || '';
    if (String(wa) === String(waId)) {
      const rowNumber = i + 1;
      return { rowNumber, caseId };
    }
  }
  return null;
}

async function loadCaseFromSheet(rowNumber) {
  const r = await sheetGet(`${SHEET_CASES}!A${rowNumber}:N${rowNumber}`);
  if (!r.ok) return null;
  const row = (r.values && r.values[0]) ? r.values[0] : [];
  return rowToCaseObj(row);
}

async function ensureCase(waId) {
  if (caseCache.has(waId)) return caseCache.get(waId);

  const found = await findCaseRowByWa(waId);
  if (found) {
    const caseObj = await loadCaseFromSheet(found.rowNumber);
    if (caseObj && caseObj.case_id) {
      const pack = { rowNumber: found.rowNumber, caseObj };
      caseCache.set(waId, pack);
      return pack;
    }
  }

  const caseId = makeId('CASE');
  const now = nowISO();

  const newCase = {
    created_at: now,
    case_id: caseId,
    wa_from: waId,
    flow_type: 'whatsapp',
    patient_type: '',
    os_name: '',
    os_token: '',
    service_label: '',
    deposit_amount: DEPOSIT_ON ? String(DEPOSIT_VALUE) : '',
    payment_link: '',
    payment_op_id: '',
    status: 'lead',
    last_message: '',
    updated_at: now,
  };

  await sheetAppend(`${SHEET_CASES}!A:N`, caseObjToRow(newCase));

  const foundAfter = await findCaseRowByWa(waId);
  const rowNumber = foundAfter ? foundAfter.rowNumber : 2;

  const pack = { rowNumber, caseObj: newCase };
  caseCache.set(waId, pack);
  return pack;
}

async function upsertCase(waId, patch) {
  const pack = await ensureCase(waId);
  const prev = pack.caseObj;

  const next = {
    ...prev,
    ...patch,
    created_at: prev.created_at || nowISO(),
    case_id: prev.case_id,
    wa_from: prev.wa_from,
    updated_at: nowISO(),
  };

  await sheetUpdateRow(pack.rowNumber, caseObjToRow(next));
  pack.caseObj = next;
  caseCache.set(waId, pack);
  return next;
}

// ✅ Touch pro (solo M y N) para que el inbox nunca quede “congelado”
async function touchCaseMN(waId, lastMessage) {
  const pack = await ensureCase(waId);
  const rn = pack.rowNumber;
  const ts = nowISO();
  await sheetBatchUpdate([
    { range: `${SHEET_CASES}!M${rn}`, values: [[String(lastMessage || '').slice(0, 220)]] },
    { range: `${SHEET_CASES}!N${rn}`, values: [[ts]] },
  ]);
  return ts;
}

async function appendEvent(waId, caseId, eventType, payloadPreview, payloadObj) {
  const row = [
    makeId('EV'),
    nowISO(),
    caseId || '',
    waId || '',
    eventType || '',
    String(payloadPreview || '').slice(0, 220),
    payloadObj ? JSON.stringify(payloadObj).slice(0, 45000) : '',
  ];
  await sheetAppend(`${SHEET_EVENTS}!A:G`, row);
}

// ================= MercadoPago (REAL VALIDATION) =================
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

async function mpGetPayment(paymentId) {
  if (!MP_ACCESS_TOKEN) return { ok: false, reason: 'missing_mp_token' };

  const resp = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
    headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
  });

  if (!resp.ok) {
    let j = {};
    try { j = await resp.json(); } catch {}
    return { ok: false, status: resp.status, err: j };
  }

  const data = await resp.json();
  return { ok: true, data };
}

async function mpSearchByExternalRef(caseId) {
  if (!MP_ACCESS_TOKEN) return { ok: false, reason: 'missing_mp_token' };

  const url = `https://api.mercadopago.com/v1/payments/search?external_reference=${encodeURIComponent(
    String(caseId || '')
  )}&sort=date_created&criteria=desc&limit=5`;

  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
  });

  if (!resp.ok) {
    let j = {};
    try { j = await resp.json(); } catch {}
    return { ok: false, status: resp.status, err: j };
  }

  const data = await resp.json();
  const results = Array.isArray(data?.results) ? data.results : [];
  return { ok: true, results };
}

function mpPaymentMatches(pay, caseId, amountExpected) {
  const status = String(pay?.status || '');
  const ext = String(pay?.external_reference || '');
  const amount = Number(pay?.transaction_amount || 0);

  if (status !== 'approved') return { ok: false, reason: `status_${status || 'unknown'}` };
  if (!ext || ext !== String(caseId)) return { ok: false, reason: 'external_reference_mismatch' };

  // tolerancia simple por redondeos: exacto o igual
  if (Number.isFinite(amountExpected) && amountExpected > 0) {
    if (Math.abs(amount - Number(amountExpected)) > 0.001) return { ok: false, reason: 'amount_mismatch' };
  }

  return { ok: true };
}

async function confirmPaymentFlow({ waId, caseId, paymentId, ctx, label }) {
  const receiptId = makeId('CEPA');
  resetSession(waId);

  await upsertCase(waId, {
    flow_type: ctx.flow,
    patient_type: ctx.patientType,
    os_name: ctx.osName || '',
    os_token: ctx.osToken || '',
    service_label: label || '',
    deposit_amount: String(DEPOSIT_VALUE),
    payment_link: ctx.mpLink || '',
    payment_op_id: String(paymentId || ''),
    status: 'confirmed',
    last_message: `Pago MP aprobado (${paymentId})`,
  });

  await appendEvent(waId, caseId, 'mp', 'mp_payment_approved', { paymentId, receiptId });

  await sendText(waId, `Pago confirmado ✅ (Mercado Pago)\n🧾 Comprobante: ${receiptId}`);
  return sendText(waId, finalConfirmedText(receiptId));
}

// ================= Data + Copy =================
const CEPA = {
  name: 'CEPA Consultorios (Luján de Cuyo)',
  address: 'Constitución 46, Luján de Cuyo, Mendoza',
  hours: 'Lunes a sábados · 07:30 a 21:00',
  email: 'cepadiagnosticomedicointegral@gmail.com',
  phone: '261-4987007',
  mrturno: MR_TURNO_URL || 'https://www.mrturno.com/m/@cepa',
  disclaimer: 'Si es una urgencia, no uses este chat: llamá al 107 o acudí a guardia.',
};

const OBRAS_SOCIALES_TOP = [
  'OSDE', 'Swiss Medical', 'Galeno', 'Medifé', 'OMINT', 'SanCor Salud', 'Prevención Salud',
  'Jerárquicos Salud', 'Andes Salud', 'Nobis', 'Federada Salud', 'Medicus'
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

Cuando pagues, escribime “PAGUÉ” (o “LISTO”).  
Si preferís, también podés mandar una captura, pero la confirmación es automática cuando Mercado Pago aprueba el pago.`;
}

function finalConfirmedText(receiptId) {
  return `Listo ✅ Turno confirmado.
🧾 Comprobante: ${receiptId}

${infoContacto()}

Si necesitás reprogramar, escribí “recepción”.`;
}

// ================= Sessions =================
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

// ================= Dedupe msg.id =================
const seenMsg = new Map(); // msgId -> ts
const SEEN_TTL_MS = 10 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, ts] of seenMsg.entries()) {
    if (!ts || now - ts > SEEN_TTL_MS) seenMsg.delete(id);
  }
}, 60 * 1000).unref();

// ================= Core Flow (STATE-FIRST) =================
async function handleUserText(waId, rawText) {
  const raw = String(rawText || '').trim();
  const firstLine = raw.split('\n').map(s => s.trim()).filter(Boolean)[0] || raw;
  const norm = normalize(firstLine);

  const sess = getSession(waId);
  const pack = await ensureCase(waId);
  const caseId = pack.caseObj.case_id;

  // siempre logueamos inbound y tocamos M/N
  await appendEvent(waId, caseId, 'message_in', raw.slice(0, 140), { text: raw });
  await touchCaseMN(waId, raw.slice(0, 160));

  // ---------- STATE-FIRST ----------
  if (sess.state === 'awaiting_mrturno_done') {
    if (['listo','ok','dale','ya'].includes(norm)) {
      setSession(waId, 'ask_patient_type', { flow: sess.ctx.flow, label: sess.ctx.label });

      await upsertCase(waId, {
        flow_type: sess.ctx.flow,
        service_label: sess.ctx.label,
        status: 'awaiting_patient_type',
        last_message: raw.slice(0, 160),
      });
      await appendEvent(waId, caseId, 'state', 'ask_patient_type', { from: 'awaiting_mrturno_done' });

      await sendText(waId, patientTypePrompt());
      return;
    }

    await upsertCase(waId, {
      flow_type: sess.ctx.flow,
      service_label: sess.ctx.label,
      status: 'awaiting_mrturno',
      last_message: raw.slice(0, 160),
    });

    await sendText(waId, `Cuando tengas el turno en MrTurno, escribime “LISTO” ✅`);
    return;
  }

  if (sess.state === 'ask_patient_type') {
    if (norm === '1') {
      const flow = sess.ctx.flow || 'turno';
      const label = sess.ctx.label || 'Turno';

      await upsertCase(waId, {
        flow_type: flow,
        patient_type: 'particular',
        service_label: label,
        status: 'awaiting_payment',
        last_message: raw.slice(0, 160),
      });

      const mp = await createMpPreference({
        caseId,
        waId,
        label,
        patientType: 'particular',
        amount: DEPOSIT_VALUE,
      });

      if (!mp.ok) {
        setSession(waId, 'handoff', {});
        await upsertCase(waId, { status: 'mp_failed', last_message: 'mp_failed' });
        await appendEvent(waId, caseId, 'mp', 'mp_failed', mp);
        await sendText(waId, `Ahora mismo no pude generar el link. Escribí “recepción” y te lo resuelven ✅`);
        return;
      }

      setSession(waId, 'awaiting_payment', { flow, label, patientType: 'particular', mpLink: mp.init_point });
      await upsertCase(waId, {
        flow_type: flow,
        patient_type: 'particular',
        service_label: label,
        payment_link: mp.init_point,
        status: 'awaiting_payment',
        last_message: 'Link de pago enviado',
      });
      await appendEvent(waId, caseId, 'mp', 'mp_link_created', mp);

      await sendText(waId, paymentLinkText(mp.init_point));
      return;
    }

    if (norm === '2') {
      setSession(waId, 'ask_os_name', { flow: sess.ctx.flow, label: sess.ctx.label, patientType: 'obra_social' });
      await upsertCase(waId, {
        flow_type: sess.ctx.flow,
        patient_type: 'obra_social',
        service_label: sess.ctx.label,
        status: 'awaiting_os_name',
        last_message: raw.slice(0, 160),
      });
      await sendText(waId, askOsNameText());
      return;
    }

    await sendText(waId, `Respondeme 1 (Particular) o 2 (Obra social).`);
    return;
  }

  if (sess.state === 'ask_os_name') {
    if (/^\d{6,}$/.test(raw)) {
      await sendText(waId, 'Decime el *nombre* de tu obra social (ej: OSDE, Swiss Medical, Galeno).');
      return;
    }

    setSession(waId, 'ask_os_token', { ...sess.ctx, osName: raw.trim() });

    await upsertCase(waId, {
      flow_type: sess.ctx.flow,
      patient_type: 'obra_social',
      os_name: raw.trim(),
      service_label: sess.ctx.label,
      status: 'awaiting_os_token',
      last_message: raw.slice(0, 160),
    });

    await sendText(waId, askOsTokenText());
    return;
  }

  if (sess.state === 'ask_os_token') {
    const flow = sess.ctx.flow || 'turno';
    const label = sess.ctx.label || 'Turno';
    const osName = sess.ctx.osName || '';
    const osToken = raw.trim();

    await upsertCase(waId, {
      flow_type: flow,
      patient_type: 'obra_social',
      os_name: osName,
      os_token: osToken,
      service_label: label,
      status: 'awaiting_payment',
      last_message: raw.slice(0, 160),
    });
    await appendEvent(waId, caseId, 'os', 'os_token_received', { osName, osToken });

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
      await upsertCase(waId, { status: 'mp_failed', last_message: 'mp_failed' });
      await appendEvent(waId, caseId, 'mp', 'mp_failed', mp);
      await sendText(waId, `Listo ✅ Tomé tus datos.\nAhora no pude generar el link.\nEscribí “recepción” y te lo hacen manual.`);
      return;
    }

    setSession(waId, 'awaiting_payment', { flow, label, patientType: 'obra_social', osName, osToken, mpLink: mp.init_point });

    await upsertCase(waId, {
      flow_type: flow,
      patient_type: 'obra_social',
      os_name: osName,
      os_token: osToken,
      service_label: label,
      payment_link: mp.init_point,
      status: 'awaiting_payment',
      last_message: 'Link de pago enviado',
    });
    await appendEvent(waId, caseId, 'mp', 'mp_link_created', mp);

    await sendText(waId, paymentLinkText(mp.init_point));
    return;
  }

  if (sess.state === 'awaiting_payment') {
    // ✅ 1) Si mandó un paymentId / opId: validamos por /v1/payments/:id
    const opId = extractOpId(raw);
    if (opId) {
      const chk = await mpGetPayment(opId);
      if (chk.ok) {
        const match = mpPaymentMatches(chk.data, caseId, DEPOSIT_VALUE);
        if (match.ok) {
          await confirmPaymentFlow({ waId, caseId, paymentId: opId, ctx: sess.ctx, label: sess.ctx.label });
          return;
        }
        // no aprobado / mismatch
        await upsertCase(waId, { status: 'awaiting_payment', last_message: `Pago en revisión (${match.reason})` });
        await appendEvent(waId, caseId, 'mp', 'mp_payment_not_approved', {
          paymentId: opId,
          reason: match.reason,
          status: chk.data?.status,
        });
        await sendText(waId, `Gracias ✅ Lo estoy validando.\nAún no figura como *aprobado* en Mercado Pago.\nSi en unos minutos sigue igual, mandá una captura o escribí “recepción”.`);
        return;
      }

      await appendEvent(waId, caseId, 'mp', 'mp_payment_lookup_failed', { opId, err: chk });
      await sendText(waId, `No pude validar ese ID ahora mismo.\nMandá “PAGUÉ” o una captura, o escribí “recepción”.`);
      return;
    }

    // ✅ 2) Si dice “PAGUÉ/LISTO/YA”: buscamos por external_reference (caseId)
    if (looksPaidIntent(norm)) {
      const sr = await mpSearchByExternalRef(caseId);
      if (sr.ok) {
        const cand = (sr.results || [])[0];
        if (cand) {
          const match = mpPaymentMatches(cand, caseId, DEPOSIT_VALUE);
          if (match.ok) {
            await confirmPaymentFlow({ waId, caseId, paymentId: cand.id, ctx: sess.ctx, label: sess.ctx.label });
            return;
          }
        }

        await upsertCase(waId, { status: 'awaiting_payment', last_message: 'Pago aún no aprobado' });
        await appendEvent(waId, caseId, 'mp', 'mp_search_no_approved', { count: (sr.results || []).length });
        await sendText(waId, `Gracias ✅ todavía no figura como *aprobado*.\nSi pagaste recién, puede demorar unos minutos.\nSi querés, mandá una captura o escribí “recepción”.`);
        return;
      }

      await appendEvent(waId, caseId, 'mp', 'mp_search_failed', sr);
      await sendText(waId, `Ahora mismo no pude validar el pago automáticamente.\nMandá una captura o escribí “recepción”.`);
      return;
    }

    await upsertCase(waId, { status: 'awaiting_payment', last_message: raw.slice(0, 160) });
    await sendText(waId, `Cuando pagues, escribime “PAGUÉ” (o “LISTO”) ✅\nSi preferís, mandá una captura.`);
    return;
  }

  // ---------- ATAJOS SOLO EN MENU ----------
  if (sess.state === 'menu') {
    if (norm === '0' || norm === 'menu' || norm === 'menú' || norm === 'inicio') {
      resetSession(waId);
      await upsertCase(waId, { status: 'menu', last_message: raw.slice(0, 160) });
      await sendText(waId, menuText());
      return;
    }

    if (norm.includes('obra') || norm.includes('prepaga') || norm.includes('osde') || norm.includes('swiss')) {
      await upsertCase(waId, { status: 'info_os', last_message: raw.slice(0, 160) });
      await sendText(
        waId,
        `Trabajamos con varias obras sociales/prepagas. Algunas frecuentes:\n• ${OBRAS_SOCIALES_TOP.join('\n• ')}\n\nSi me decís cuál tenés, te confirmo si está.`
      );
      return;
    }

    if (norm === '1') {
      setSession(waId, 'awaiting_mrturno_done', { flow: 'turno', label: 'Turno' });
      await upsertCase(waId, { flow_type: 'turno', service_label: 'Turno', status: 'awaiting_mrturno', last_message: raw.slice(0, 160) });
      await appendEvent(waId, caseId, 'menu', 'turno', {});
      await sendText(waId, mrTurnoText('Perfecto ✅'));
      return;
    }

    if (norm === '2') {
      setSession(waId, 'awaiting_mrturno_done', { flow: 'estudio', label: 'Estudios' });
      await upsertCase(waId, { flow_type: 'estudio', service_label: 'Estudios', status: 'awaiting_mrturno', last_message: raw.slice(0, 160) });
      await appendEvent(waId, caseId, 'menu', 'estudios', {});
      await sendText(waId, mrTurnoText('Perfecto ✅'));
      return;
    }

    if (norm === '3') {
      await upsertCase(waId, { status: 'info_os', last_message: raw.slice(0, 160) });
      await sendText(
        waId,
        `Trabajamos con varias obras sociales/prepagas. Algunas frecuentes:\n• ${OBRAS_SOCIALES_TOP.join('\n• ')}\n\nSi me decís cuál tenés, te confirmo si está.`
      );
      return;
    }

    if (norm === '4') {
      await upsertCase(waId, { status: 'info_contacto', last_message: raw.slice(0, 160) });
      await sendText(waId, infoContacto());
      return;
    }

    if (norm === '5' || norm.includes('recep') || norm.includes('humano')) {
      setSession(waId, 'handoff', {});
      await upsertCase(waId, { status: 'handoff', last_message: raw.slice(0, 160) });
      await appendEvent(waId, caseId, 'handoff', 'handoff_requested', {});
      await sendText(waId, `Listo ✅ Te paso con recepción.\nContame en 1 línea qué necesitás (especialidad/estudio + día preferido).`);
      return;
    }

    await upsertCase(waId, { status: 'menu', last_message: raw.slice(0, 160) });
    await sendText(waId, menuText());
    return;
  }

  // fallback total
  resetSession(waId);
  await upsertCase(waId, { status: 'fallback', last_message: raw.slice(0, 160) });
  await sendText(waId, menuText());
}

// ================= Webhook Verify =================
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

// ================= Webhook POST =================
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
      const sess = getSession(from);
      const pack = await ensureCase(from);
      const caseId = pack.caseObj.case_id;

      await appendEvent(from, caseId, 'message_in_media', 'media_in', { hasMedia: true });
      await touchCaseMN(from, 'Comprobante/archivo recibido');

      // ✅ Antes confirmabas “a ojo”. Ahora: intentamos validar por external_reference.
      if (sess.state === 'awaiting_payment') {
        const sr = await mpSearchByExternalRef(caseId);
        if (sr.ok) {
          const cand = (sr.results || [])[0];
          if (cand) {
            const match = mpPaymentMatches(cand, caseId, DEPOSIT_VALUE);
            if (match.ok) {
              await confirmPaymentFlow({ waId: from, caseId, paymentId: cand.id, ctx: sess.ctx, label: sess.ctx.label });
              return;
            }
          }
        }

        // si no pudimos confirmar, pasamos a revisión humana
        setSession(from, 'handoff', {});
        await upsertCase(from, {
          status: 'payment_review',
          last_message: 'Comprobante recibido - revisión',
        });
        await appendEvent(from, caseId, 'handoff', 'payment_review', {});
        await sendText(from, `Recibido ✅ Estoy validando el pago.\nSi en breve no se confirma automático, recepción lo revisa y te responde.`);
        return;
      }

      await sendText(from, `Recibido ✅\n\n${menuText()}`);
      return;
    }

    if (!text.trim()) {
      await sendText(from, menuText());
      return;
    }

    await handleUserText(from, text);
  } catch (e) {
    log('error', 'wa_handle_failed', { err: String(e?.message || e) });
  }
}

// ================= Routes =================
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

// ================= Start =================
app.listen(Number(PORT), '0.0.0.0', () => {
  const hasGsheet =
    !!SPREADSHEET_ID &&
    (!!GSHEET_SA_JSON_BASE64 || (!!GSHEET_CLIENT_EMAIL && !!GSHEET_PRIVATE_KEY));

  log('info', 'gsheet_ready', {
    has_gsheet: hasGsheet,
    has_sheet_id: !!SPREADSHEET_ID,
    sheet_id_preview: SPREADSHEET_ID ? String(SPREADSHEET_ID).slice(0, 8) + '...' : null,
  });

  log('info', 'server_started', {
    port: Number(PORT),
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
