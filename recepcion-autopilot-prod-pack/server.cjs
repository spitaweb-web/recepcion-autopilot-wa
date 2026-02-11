const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;

// ====== ENV (WhatsApp Cloud API) ======
const WA_VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN || "change_me_verify_token";
const WA_ACCESS_TOKEN = process.env.WA_ACCESS_TOKEN || "";

// ACEPTA VARIOS NOMBRES (Render / README / tu setup)
const WA_PHONE_NUMBER_ID =
  process.env.WA_PHONE_NUMBER_ID ||
  process.env.WA_PHONE_ID || // <- tu key actual en Render (por captura)
  process.env.PEGAR_PHONE_NUMBER_ID || // <- por si el README decía eso
  "";

// Demo mode (stateless + confirm sin pago)
const DEMO_STATELESS = String(process.env.DEMO_STATELESS || "1") === "1";
const DEMO_CONFIRM_NO_PAY = String(process.env.DEMO_CONFIRM_NO_PAY || "1") === "1";

// ====== Config Clínica Ortega (demo) ======
const CLINIC = {
  id: "clinic-ortega",
  name: "Clínica Ortega",
  timezone: "America/Argentina/Mendoza",
  deposit_obrasocial: 5000,
  deposit_other: 10000,
};

// ====== In-memory store ======
const store = {
  conversations: new Map(),
  appointments: [],
  handoffs: [],
};

function nowISO() { return new Date().toISOString(); }
function uid() { return crypto.randomUUID(); }

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function text(res, status, data, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => raw += c);
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

function safeJsonParse(s) { try { return JSON.parse(s); } catch { return null; } }

function redact(s) {
  if (!s) return "";
  if (s.length <= 10) return "***";
  return s.slice(0, 6) + "..." + s.slice(-4);
}

function norm(s){ return (s || "").toLowerCase().trim(); }

// ====== Intent ======
function detectIntent(message) {
  const m = norm(message);
  if (!m) return "unknown";
  if (m.includes("reprogram") || m.includes("cambiar") || m.includes("mover")) return "reschedule";
  if (m.includes("cancel") || m.includes("anular")) return "cancel";
  if (m.includes("humano") || m.includes("recepción") || m.includes("recepcion") || m.includes("persona")) return "human";
  if (m.includes("turno") || m.includes("reserv") || m.includes("sacar")) return "reserve";
  if (m === "1") return "reserve";
  if (m === "2") return "reschedule";
  if (m === "3") return "cancel";
  if (m === "4") return "human";
  return "unknown";
}

function menuPro() {
  return [
    `Hola 👋 Soy la recepción automática de ${CLINIC.name}.`,
    "¿Qué necesitás?",
    "1) Reservar turno",
    "2) Reprogramar",
    "3) Cancelar",
    "4) Hablar con recepción humana",
  ].join("\n");
}

// ====== Mock slots ======
function getMockSlots() {
  const now = Date.now();
  const h = 60 * 60 * 1000;
  return [
    { label: "A) Hoy 18:00", iso: new Date(now + 2 * h).toISOString() },
    { label: "B) Mañana 09:00", iso: new Date(now + 15 * h).toISOString() },
    { label: "C) Mañana 18:30", iso: new Date(now + 24 * h + 30 * 60 * 1000).toISOString() },
  ];
}

function extractSlot(msg){
  const m = norm(msg);
  if (m === "a" || m.includes("a)")) return 0;
  if (m === "b" || m.includes("b)")) return 1;
  if (m === "c" || m.includes("c)")) return 2;
  return null;
}

function extractDNI(msg){
  const digits = (msg || "").replace(/\D/g, "");
  if (digits.length === 7 || digits.length === 8) return digits;
  return null;
}

function extractFullName(msg){
  const t = (msg || "").trim();
  if (!t) return null;
  const parts = t.split(/\s+/).filter(Boolean);
  if (parts.length >= 2 && /[a-zA-ZáéíóúñÁÉÍÓÚÑ]/.test(t)) return t;
  return null;
}

function extractOSName(msg){
  const t = (msg || "").trim();
  if (!t) return null;
  const low = t.toLowerCase();
  if (low === "1" || low === "2") return null;
  if (low.includes("obra social")) return null;
  // simple: si tiene letras y >=3
  if (/[a-zA-ZáéíóúñÁÉÍÓÚÑ]/.test(t) && t.length >= 3) return t;
  return null;
}

function extractService(msg){
  const m = norm(msg);
  if (!m) return null;
  if (m === "1" || m.includes("eco")) return "EcoDoppler";
  if (m === "2" || m.includes("holter")) return "Holter";
  if (m === "3" || m.includes("ecg") || m.includes("electro")) return "ECG";
  if (m === "4" || m.includes("consulta")) return "Consulta";
  // si escribió algo largo, lo tomo como servicio custom
  if (m.length >= 4) return msg.trim();
  return null;
}

function extractLocation(msg){
  const m = norm(msg);
  if (!m) return null;
  if (m === "1" || m.includes("centro")) return "Centro";
  if (m === "2" || m.includes("luján") || m.includes("lujan")) return "Luján";
  return null;
}

function extractCoverage(msg){
  const m = norm(msg);
  if (!m) return null;
  if (m === "1" || m.includes("obra") || m.includes("prepaga") || m.includes("osde") || m.includes("swiss") || m.includes("galeno")) return "obra_social";
  if (m === "2" || m.includes("particular")) return "particular";
  return null;
}

// ====== Store ops ======
function getOrCreateConversation(clinicId, phone) {
  const key = `${clinicId}:${phone}`;
  const existing = store.conversations.get(key);
  if (existing) return { key, convo: existing };
  const convo = { id: uid(), clinic_id: clinicId, user_phone: phone, state: {}, last_intent: null, updated_at: nowISO(), created_at: nowISO() };
  store.conversations.set(key, convo);
  return { key, convo };
}

function updateConversation(key, patch) {
  const convo = store.conversations.get(key);
  if (!convo) return;
  store.conversations.set(key, { ...convo, ...patch, updated_at: nowISO() });
}

function createHeldAppointment({ phone, service, location, coverage, deposit_amount, start_at, patient_dni, patient_name, os_name }) {
  const appt = {
    id: uid(),
    clinic_id: CLINIC.id,
    user_phone: phone,
    patient_dni: patient_dni || null,
    patient_name: patient_name || null,
    os_name: os_name || null,
    service,
    location,
    coverage,
    deposit_amount,
    start_at,
    status: "held",
    payment_status: "unpaid",
    payment_ref: null,
    created_at: nowISO(),
  };
  store.appointments.unshift(appt);
  return appt;
}

function markAppointmentPaid(appointmentId, paymentRef) {
  const idx = store.appointments.findIndex(a => a.id === appointmentId);
  if (idx < 0) return false;
  store.appointments[idx] = { ...store.appointments[idx], payment_status: "paid", status: "confirmed", payment_ref: paymentRef || "demo-confirm" };
  return true;
}

function createHandoff(phone, reason, context) {
  const h = { id: uid(), clinic_id: CLINIC.id, user_phone: phone, reason, context, status: "open", created_at: nowISO() };
  store.handoffs.unshift(h);
  return h;
}

// ====== WhatsApp sender ======
function sendWhatsAppText(to, bodyText) {
  return new Promise((resolve) => {
    if (!WA_ACCESS_TOKEN || !WA_PHONE_NUMBER_ID) {
      console.log("[WA OUT SKIP] Missing WA_ACCESS_TOKEN / WA_PHONE_NUMBER_ID", {
        hasToken: !!WA_ACCESS_TOKEN,
        phoneNumberId: WA_PHONE_NUMBER_ID ? "set" : "missing",
      });
      return resolve({ ok: false, skipped: true });
    }

    const payload = JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: bodyText }
    });

    const options = {
      hostname: "graph.facebook.com",
      path: `/v20.0/${WA_PHONE_NUMBER_ID}/messages`,
      method: "POST",
      headers: {
        "Authorization": `Bearer ${WA_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        console.log("[WA OUT]", res.statusCode, ok ? "OK" : "FAIL", data?.slice?.(0, 400));
        resolve({ ok, status: res.statusCode, data });
      });
    });

    req.on("error", (err) => {
      console.log("[WA OUT ERROR]", err.message);
      resolve({ ok: false, error: err.message });
    });

    req.write(payload);
    req.end();
  });
}

// ====== Stateless demo flow (REAL) ======
async function handleIncomingTextStateless(phone, textIn) {
  const msg = (textIn || "").trim();
  const m = norm(msg);
  const intent = detectIntent(msg);

  if (intent === "human") {
    createHandoff(phone, "User requested human (stateless)", { lastMessage: msg });
    return ["Perfecto ✅ Te paso con recepción humana. (Ya les llegó tu pedido y contexto.)"];
  }
  if (intent === "reschedule") return ["Dale. Pasame *DNI* + *día del turno* y te lo reprogramo."];
  if (intent === "cancel") return ["Ok. Pasame *DNI* + *día del turno* y lo cancelo."];

  const service = extractService(msg);
  const location = extractLocation(msg);
  const coverage = extractCoverage(msg);
  const dni = extractDNI(msg);
  const fullName = extractFullName(msg);
  const osName = extractOSName(msg);
  const slotIdx = extractSlot(msg);

  const wantsReserve =
    intent === "reserve" ||
    m === "1" ||
    m.includes("turno") ||
    m.includes("reserv");

  // menú si está perdido
  if (!wantsReserve && !service && !location && !coverage && !dni && slotIdx == null) {
    return [menuPro()];
  }

  // pedir servicio
  if (!service && !location && !coverage && !dni && slotIdx == null) {
    return ["Genial. ¿Qué necesitás?\n1) EcoDoppler\n2) Holter\n3) ECG\n4) Consulta"];
  }

  // servicio -> sede
  if (service && !location) {
    return [`Perfecto: *${service}*.\n¿En qué sede?\n1) Centro\n2) Luján`];
  }

  // sede -> cobertura
  if ((service || wantsReserve) && location && !coverage) {
    return [`Perfecto: *${location}*.\n¿Cómo es tu atención?\n1) Obra social / Prepaga\n2) Particular`];
  }

  // cobertura -> DNI
  if (location && coverage && !dni) {
    const extra = coverage === "obra_social"
      ? "Si querés, podés mandarlo así: `DNI 40123456 OSDE`"
      : "Si querés, también tu *nombre y apellido*.";
    return [`Listo. Para continuar necesito tu *DNI* (solo números).\n${extra}`];
  }

  // si obra social y no nombre de OS
  if (location && coverage === "obra_social" && dni && !osName) {
    return ["Perfecto ✅ Ahora decime el *nombre de la obra social/prepaga* (ej: OSDE, Swiss Medical, Galeno)."];
  }

  // pedir nombre (para que quede “real”)
  if (dni && !fullName) {
    return ["Gracias ✅ ¿Me pasás tu *nombre y apellido*?"];
  }

  // ofrecer slots
  if (location && coverage && dni && fullName && slotIdx == null) {
    const s = service || "EcoDoppler";
    const slots = getMockSlots();
    return [
      `Listo ✅ Para *${s}* en *${location}* tengo:\n` +
      `${slots.map(x => x.label).join("\n")}\n\nRespondé *A*, *B* o *C*.`
    ];
  }

  // confirmar
  if (slotIdx != null) {
    const slots = getMockSlots();
    const chosen = slots[slotIdx] || slots[0];
    const s = service || "EcoDoppler";
    const loc = location || "Centro";
    const cov = coverage || "particular";

    const isObra = cov === "obra_social";
    const amount = isObra ? CLINIC.deposit_obrasocial : CLINIC.deposit_other;

    const appt = createHeldAppointment({
      phone,
      service: s,
      location: loc,
      coverage: cov,
      deposit_amount: amount,
      start_at: chosen.iso,
      patient_dni: dni,
      patient_name: fullName,
      os_name: isObra ? (osName || null) : null,
    });

    // DEMO: confirmado sin pago
    if (DEMO_CONFIRM_NO_PAY) {
      markAppointmentPaid(appt.id, "demo-confirm");
    }

    const extra = isObra ? `Obra social: ${osName || "—"}` : "Atención: Particular";
    return [
      `Perfecto ✅ *Turno confirmado*\n` +
      `• Paciente: ${fullName}\n` +
      `• DNI: ${dni}\n` +
      `• Estudio: ${s}\n` +
      `• Sede: ${loc}\n` +
      `• Horario: ${chosen.label.replace(/^.\)\s*/, "")}\n` +
      `• ${extra}\n\n` +
      `Si querés hablar con recepción humana: respondé *4*.`
    ];
  }

  return [menuPro()];
}

// ====== (Opcional) Stateful legacy ======
async function handleIncomingTextStateful(phone, textIn) {
  const { key, convo } = getOrCreateConversation(CLINIC.id, phone);
  const state = convo.state || {};
  const msg = (textIn || "").trim();
  const intent = detectIntent(msg);

  if (intent === "human") {
    createHandoff(phone, "User requested human", { lastMessage: msg, state });
    updateConversation(key, { last_intent: "human", state: {} });
    return ["Perfecto. Te paso con recepción ✅ (ya tienen todo el contexto)."];
  }

  if (!state.stage) {
    updateConversation(key, { state: { stage: "menu" }, last_intent: intent });
    return [menuPro()];
  }

  // ... si algún día querés volver a stateful, lo dejamos guardado.
  updateConversation(key, { state: { stage: "menu" }, last_intent: null });
  return [menuPro()];
}

// ====== Static ======
function serveStatic(req, res, pathname) {
  const fileMap = {
    "/": "public/index.html",
    "/admin": "public/admin.html",
    "/styles.css": "public/styles.css",
    "/app.js": "public/app.js",
    "/admin.js": "public/admin.js",
  };

  const rel = fileMap[pathname];
  if (!rel) return false;

  const abs = path.join(__dirname, rel);
  if (!fs.existsSync(abs)) return false;

  const ext = path.extname(abs).toLowerCase();
  const ct =
    ext === ".html" ? "text/html; charset=utf-8" :
    ext === ".css" ? "text/css; charset=utf-8" :
    ext === ".js" ? "application/javascript; charset=utf-8" :
    "application/octet-stream";

  const data = fs.readFileSync(abs);
  res.writeHead(200, { "Content-Type": ct, "Cache-Control": "no-store" });
  res.end(data);
  return true;
}

// ====== Server ======
const server = http.createServer(async (req, res) => {
  console.log("[REQ]", req.method, req.url);

  // URL parse (WHATWG, sin warning)
  const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = u.pathname || "/";

  if (serveStatic(req, res, pathname)) return;

  // ---- debug env (safe) ----
  if (req.method === "GET" && pathname === "/api/debug/env") {
    return json(res, 200, {
      ok: true,
      PORT: String(PORT),
      DEMO_STATELESS,
      DEMO_CONFIRM_NO_PAY,
      WA_VERIFY_TOKEN: redact(WA_VERIFY_TOKEN),
      WA_ACCESS_TOKEN: redact(WA_ACCESS_TOKEN),
      WA_PHONE_NUMBER_ID: WA_PHONE_NUMBER_ID ? "set" : "missing",
      WA_PHONE_NUMBER_ID_value: WA_PHONE_NUMBER_ID ? redact(WA_PHONE_NUMBER_ID) : "",
    });
  }

  // ---- admin endpoints ----
  if (req.method === "GET" && pathname === "/api/admin/appointments") {
    return json(res, 200, { ok: true, items: store.appointments });
  }
  if (req.method === "GET" && pathname === "/api/admin/handoffs") {
    return json(res, 200, { ok: true, items: store.handoffs });
  }

  // ---- dev simulate (POST) ----
  if (req.method === "POST" && pathname === "/api/dev/simulate") {
    const raw = await readBody(req);
    const body = safeJsonParse(raw) || {};
    const phone = String(body.phone || "").trim();
    const textIn = String(body.text || "").trim();
    if (!phone || !textIn) return json(res, 400, { ok: false, error: "missing phone/text" });

    const replies = DEMO_STATELESS
      ? await handleIncomingTextStateless(phone, textIn)
      : await handleIncomingTextStateful(phone, textIn);

    return json(res, 200, { ok: true, phone, in: textIn, replies });
  }

  // ---- debug: force send ----
  if (req.method === "POST" && pathname === "/api/debug/wa-send") {
    const raw = await readBody(req);
    const body = safeJsonParse(raw) || {};
    const to = body.to;
    const message = body.message || "ping desde Render ✅";
    if (!to) return json(res, 400, { ok: false, error: "missing to" });
    const r = await sendWhatsAppText(String(to), String(message));
    return json(res, 200, { ok: true, result: r });
  }

  if (req.method === "GET" && pathname === "/api/health") {
    return json(res, 200, { ok: true, clinic: CLINIC.name, time: nowISO() });
  }

  // WhatsApp verify (Cloud API)
  if (req.method === "GET" && pathname === "/api/whatsapp") {
    const mode = u.searchParams.get("hub.mode");
    const token = u.searchParams.get("hub.verify_token");
    const challenge = u.searchParams.get("hub.challenge");
    console.log("[WA VERIFY]", { mode, token: redact(token), expected: redact(WA_VERIFY_TOKEN) });

    if (mode === "subscribe" && token === WA_VERIFY_TOKEN) {
      return text(res, 200, String(challenge || ""));
    }
    return json(res, 403, { ok: false });
  }

  // WhatsApp inbound (Cloud payload)
  if (req.method === "POST" && pathname === "/api/whatsapp") {
    const raw = await readBody(req);
    const body = safeJsonParse(raw) || {};

    const value = body?.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];

    const from = msg?.from || null;
    const textIn = msg?.type === "text" ? msg.text?.body : null;

    console.log("[WA POST RAW]", raw?.slice?.(0, 400));

    // Meta manda statuses y otros eventos: OK 200 siempre
    if (!from || !textIn) return json(res, 200, { ok: true });

    console.log("[WA IN]", from, textIn);

    const replies = DEMO_STATELESS
      ? await handleIncomingTextStateless(from, textIn)
      : await handleIncomingTextStateful(from, textIn);

    for (const r of replies) {
      await sendWhatsAppText(from, r);
    }

    return json(res, 200, { ok: true });
  }

  res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: false, error: "not_found" }));
});

server.listen(PORT, () => {
  console.log(`[Recepción Autopilot] running on http://localhost:${PORT}`);
  console.log(`[Recepción Autopilot] clinic = ${CLINIC.name}`);
  console.log(`[Recepción Autopilot] webhook = /api/whatsapp (verify+messages)`);
  console.log("[BOOT ENV]", {
    has_WA_ACCESS_TOKEN: !!WA_ACCESS_TOKEN,
    has_WA_VERIFY_TOKEN: !!WA_VERIFY_TOKEN,
    has_WA_PHONE_NUMBER_ID: !!WA_PHONE_NUMBER_ID,
    WA_PHONE_NUMBER_ID_preview: redact(WA_PHONE_NUMBER_ID),
    DEMO_STATELESS,
    DEMO_CONFIRM_NO_PAY
  });

  if (!WA_ACCESS_TOKEN || !WA_PHONE_NUMBER_ID) {
    console.log("⚠️ Missing WA_ACCESS_TOKEN or WA_PHONE_NUMBER_ID. Incoming will be handled but replies won't be sent.");
  }
});

