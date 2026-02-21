'use strict';

/**
 * Recepción Autopilot — CEPA (WhatsApp Cloud API) — Node/Express
 * - Webhook verify + messages: /api/whatsapp (y alias /webhook)
 * - Respuestas: text-only (robusto). Fase 2: interactive buttons/lists.
 *
 * Fixes incluidos:
 * ✅ express-rate-limit trust proxy warning (trust proxy = 1)
 * ✅ Limpieza sesiones (TTL)
 * ✅ Dedupe básico por msg.id (evita doble respuesta por retries)
 * ✅ Firma X-Hub-Signature-256 (si hay META_APP_SECRET)
 * ✅ Política seña (NO reintegrable, transferible 24h)
 * ✅ Reminder automático si no envía comprobante (ventana de pago)
 *
 * Capa “natural” agregada:
 * ✅ Saludos (hola/buen día) → 3 variantes random
 * ✅ Cierre (gracias/chau) → 3 variantes random
 * ✅ Registro de operación/comprobante con ID interno (pilot-grade)
 * ✅ Respuesta “multicanal” (orienta: MrTurno / Recepción / Menú)
 */

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

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

  // opcional para “multicanal real” a futuro:
  // LEADS_WEBHOOK_URL, // por ej. endpoint tuyo / notion automation
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

function makeReceiptId(prefix = 'CEPA') {
  // corto, legible, unique-ish
  const ts = Date.now().toString(36).toUpperCase();
  const r = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `${prefix}-${ts}-${r}`;
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

function moneyARS(n) {
  try { return new Intl.NumberFormat('es-AR').format(n); }
  catch { return String(n); }
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

const DEPOSIT_POLICY = {
  refundable: false,
  transferable_hours: 24,
  copy_short: (amount) =>
    `Seña para confirmar: $${moneyARS(amount)}. No reintegrable. Transferible si reprogramás con ${DEPOSIT_POLICY.transferable_hours} hs de anticipación.`,
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

// ===== Natural layer triggers =====
const GREETINGS = ['hola', 'holaa', 'buen dia', 'buen día', 'buenas', 'buenas tardes', 'buenas noches', 'hey', 'que tal', 'qué tal'];
const THANKS = ['gracias', 'muchas gracias', 'mil gracias', 'genial gracias', 'graciass'];
const BYE = ['chau', 'chao', 'hasta luego', 'nos vemos', 'adios', 'adiós', 'bye'];

const GREETING_REPLIES = [
  `¡Hola! 👋 Soy la recepción automática de ${CEPA.name}.\nDecime qué necesitás o respondé con un número:\n\n1) Sacar turno\n2) Estudios\n3) Estética\n4) Obras sociales\n5) Dirección/horarios\n6) Recepción`,
  `¡Buenas! 👋 Estoy para ayudarte rápido.\nRespondé:\n1) Turno\n2) Estudios\n3) Estética\n4) Obras sociales\n5) Dirección/horarios\n6) Recepción`,
  `Hola 👋 Bienvenido/a a ${CEPA.name}.\n¿Querés turno o info? (Respondé con número)\n1) Turno · 2) Estudios · 3) Estética · 4) Obras sociales · 5) Dirección/horarios · 6) Recepción`,
];

const CLOSING_REPLIES = [
  `¡De nada! ✅ Si necesitás algo más, escribí “menú”.`,
  `Perfecto 🙌 Cualquier cosa, escribime “menú” y te ayudo.`,
  `Listo ✅ Te leo cuando quieras. (Escribí “menú” para ver opciones)`,
];

// ===== Sessions + dedupe =====
/**
 * sessions: wa_id -> { state, context, updatedAt }
 * context:
 *  - type, label
 *  - awaitingSince, reminderSent, reminderTimer
 *  - lastReceiptId (último comprobante)
 */
const sessions = new Map();
const SESSION_TTL_MS = 60 * 60 * 1000;

const seenMsg = new Map();
const SEEN_TTL_MS = 10 * 60 * 1000;

// Registro in-memory del piloto (para mostrar “trazabilidad”)
const receiptsLog = new Map(); // receiptId -> { waId, at, kind, rawHint }

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

  // receiptsLog: lo dejamos 48h
  const RECEIPT_TTL = 48 * 60 * 60 * 1000;
  for (const [rid, r] of receiptsLog.entries()) {
    if (!r?.at || now - r.at > RECEIPT_TTL) receiptsLog.delete(rid);
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

// ===== Payment reminder scheduling =====
function schedulePaymentReminder(waId) {
  if (!DEPOSIT_ON) return;

  const s = getSession(waId);
  if (s.state !== 'awaiting_receipt') return;
  if (s?.context?.reminderTimer) return;

  const createdAt = Date.now();
  const timer = setTimeout(async () => {
    try {
      const cur = getSession(waId);
      if (cur.state !== 'awaiting_receipt') return;
      if (cur.context?.reminderSent) return;

      setSession(waId, {
        state: 'awaiting_receipt',
        context: { ...cur.context, reminderSent: true },
      });

      await sendText(
        waId,
        `Recordatorio ✅ Para confirmar el turno necesitamos la seña de $${moneyARS(DEPOSIT_VALUE)}.\n${DEPOSIT_POLICY.copy_short(DEPOSIT_VALUE)}\n\nSi ya la abonaste, enviá el comprobante (captura o ID de operación).`
      );
    } catch (e) {
      log('error', 'payment_reminder_failed', { err: String(e?.message || e) });
    }
  }, PAYMENT_WINDOW_MS);

  setSession(waId, {
    state: 'awaiting_receipt',
    context: { ...s.context, awaitingSince: createdAt, reminderTimer: timer, reminderSent: false },
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
  const depositLine = DEPOSIT_ON ? `\n\n✅ ${DEPOSIT_POLICY.copy_short(DEPOSIT_VALUE)}` : '';
  return (
`${extraLine ? extraLine + '\n\n' : ''}Para sacar turno rápido usá MrTurno:
${CEPA.mrturno}${depositLine}

Cuando lo tengas reservado, escribime “LISTO” para confirmarlo por acá.`
  );
}

function askReceiptText() {
  if (!DEPOSIT_ON) {
    return `Listo ✅ Cuando tengas el turno confirmado, escribime “LISTO” y te dejo la info final (dirección/horarios).`;
  }
  return (
`Perfecto ✅ Para confirmar el turno necesitamos la seña de $${moneyARS(DEPOSIT_VALUE)}.

${DEPOSIT_POLICY.copy_short(DEPOSIT_VALUE)}

📌 Enviame:
• Captura del comprobante (imagen) o
• El número/ID de operación en texto

Apenas lo reciba, te genero un comprobante con ID y queda confirmado.`
  );
}

function finalConfirmedText(receiptId) {
  const depositLine = DEPOSIT_ON ? `\n✅ Seña registrada: $${moneyARS(DEPOSIT_VALUE)}.` : '';
  const receiptLine = receiptId ? `\n🧾 Comprobante: ${receiptId}` : '';
  return (
`Listo ✅ Turno confirmado.${receiptLine}

${infoContacto()}${depositLine}

Si necesitás reprogramar, escribí “recepción”.`
  );
}

function receiptAckText(receiptId) {
  return (
`Recibido ✅ Ya registré tu seña.

🧾 Este es tu comprobante: ${receiptId}

${DEPOSIT_POLICY.copy_short(DEPOSIT_VALUE)}`
  );
}

// ===== Helpers: detect greetings/closing =====
function isGreeting(norm) {
  return GREETINGS.some((g) => norm === normalize(g) || norm.startsWith(normalize(g)));
}
function isThanksOrBye(norm) {
  const hasThanks = THANKS.some((t) => norm === normalize(t) || norm.includes(normalize(t)));
  const hasBye = BYE.some((b) => norm === normalize(b) || norm.includes(normalize(b)));
  return hasThanks || hasBye;
}

// ===== Receipt registration =====
function registerReceipt({ waId, kind, rawHint }) {
  const receiptId = makeReceiptId('CEPA');
  receiptsLog.set(receiptId, { waId, at: Date.now(), kind, rawHint: rawHint || null });

  // guardamos en sesión también
  const s = getSession(waId);
  setSession(waId, { state: s.state, context: { ...s.context, lastReceiptId: receiptId } });

  return receiptId;
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

// ===== Flow =====
async function handleUserText(waId, rawText) {
  const norm = normalize(rawText);
  const session = getSession(waId);

  // capa natural: saludo
  if (isGreeting(norm) && session.state === 'menu') {
    return sendText(waId, randPick(GREETING_REPLIES));
  }

  // capa natural: cierre (gracias/chau)
  if (isThanksOrBye(norm) && session.state !== 'awaiting_receipt') {
    // si está esperando comprobante, no cortamos; lo guiamos
    return sendText(waId, randPick(CLOSING_REPLIES));
  }

  // comandos globales
  if (norm === '0' || norm === 'menu' || norm === 'inicio') {
    resetSession(waId);
    return sendText(waId, menuText());
  }

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
    setSession(waId, { state: 'handoff', context: {} });
    return sendText(
      waId,
      `Listo ✅ Te paso con recepción.\nContame en 1 línea qué necesitás (especialidad/estudio + día preferido).`
    );
  }

  // LISTO => pedir comprobante (si aplica)
  if (norm === 'listo' || norm === 'ok' || norm === 'dale' || norm === 'ya') {
    // si veníamos de mrturno/awaiting, pedimos comprobante
    if (session.state === 'awaiting_receipt') {
      schedulePaymentReminder(waId);
      return sendText(waId, askReceiptText());
    }
    resetSession(waId);
    return sendText(waId, `Perfecto. ¿En qué te ayudo?\n\n${menuText()}`);
  }

  // Si está esperando comprobante y el usuario manda texto que parece comprobante:
  if (session.state === 'awaiting_receipt' && maybeLooksLikeReceiptText(norm)) {
    // registrar comprobante con ID interno
    const receiptId = registerReceipt({ waId, kind: session.context?.type || 'unknown', rawHint: rawText.trim().slice(0, 120) });
    resetSession(waId);
    await sendText(waId, receiptAckText(receiptId));
    return sendText(waId, finalConfirmedText(receiptId));
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
      return sendText(
        waId,
        `Dale ✅ Contame en 1 línea qué necesitás (especialidad/estudio + día preferido) y te ayudo.`
      );
    }

    // fallback inteligente
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
      setSession(waId, { state: 'awaiting_receipt', context: { type: 'turno', label } });
      await sendText(waId, mrturnoText(`Perfecto: ${label}.`));
      await sendText(waId, askReceiptText());
      schedulePaymentReminder(waId);
      return;
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

    setSession(waId, { state: 'awaiting_receipt', context: { type: 'turno', label } });
    await sendText(waId, mrturnoText(`Perfecto: ${label}.`));
    await sendText(waId, askReceiptText());
    schedulePaymentReminder(waId);
    return;
  }

  if (session.state === 'estudios') {
    const sendMrTurno = async (label) => {
      setSession(waId, { state: 'awaiting_receipt', context: { type: 'estudio', label } });
      await sendText(waId, mrturnoText(`Perfecto: ${label}.`));
      await sendText(waId, askReceiptText());
      schedulePaymentReminder(waId);
      return;
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

    if (Object.prototype.hasOwnProperty.call(byNum, norm) && byNum[norm]) {
      return sendMrTurno(byNum[norm]);
    }

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

    setSession(waId, { state: 'awaiting_receipt', context: { type: 'estudio', label } });
    await sendText(waId, mrturnoText(`Perfecto: ${label}.`));
    await sendText(waId, askReceiptText());
    schedulePaymentReminder(waId);
    return;
  }

  if (session.state === 'awaiting_receipt') {
    // si no parece comprobante, insistimos + no cortamos con chau/gracias
    schedulePaymentReminder(waId);
    return sendText(waId, askReceiptText());
  }

  if (session.state === 'handoff') {
    resetSession(waId);
    return sendText(
      waId,
      `Perfecto ✅ Ya quedó. En breve te responde recepción.\n\nMientras tanto, si querés sacar turno rápido: ${CEPA.mrturno}`
    );
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

      // Si llega media y estamos esperando comprobante => registramos receipt + confirmamos
      if (s.state === 'awaiting_receipt') {
        const receiptId = registerReceipt({ waId: from, kind: s.context?.type || 'unknown', rawHint: 'media' });
        resetSession(from);
        await sendText(from, receiptAckText(receiptId));
        await sendText(from, finalConfirmedText(receiptId));
        return;
      }

      await sendText(from, `Recibido ✅ ¿Querés sacar turno o necesitás recepción?\n\n${menuText()}`);
      return;
    }

    if (!text.trim()) {
      resetSession(from);
      return sendText(from, menuText());
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
    deposit_required: DEPOSIT_ON,
    deposit_amount: DEPOSIT_VALUE,
    payment_window_minutes: Math.round(PAYMENT_WINDOW_MS / 60000),
  });
});
