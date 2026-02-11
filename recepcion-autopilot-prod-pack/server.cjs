const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const url = require("url");

const PORT = process.env.PORT || 3000;

// ====== ENV (WhatsApp Cloud API) ======
const WA_VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN || "change_me_verify_token";
const WA_ACCESS_TOKEN = process.env.WA_ACCESS_TOKEN || "";

// ACEPTA AMBOS NOMBRES (por tu captura de Render)
const WA_PHONE_NUMBER_ID =
  process.env.WA_PHONE_NUMBER_ID ||
  process.env.WA_PHONE_NUMBER_ID || // (tu key actual en Render)
  "";

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

function detectIntent(message) {
  const m = (message || "").toLowerCase().trim();
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

function menu() {
  return [
    "Hola 👋 Soy la recepción automática de Clínica Ortega.",
    "¿Qué necesitás?",
    "1) Reservar turno",
    "2) Reprogramar",
    "3) Cancelar",
    "4) Hablar con recepción",
  ].join("\n");
}

function getMockSlots() {
  const now = Date.now();
  const h = 60 * 60 * 1000;
  return [
    { label: "A) Hoy 18:00", iso: new Date(now + 2 * h).toISOString() },
    { label: "B) Mañana 09:00", iso: new Date(now + 15 * h).toISOString() },
    { label: "C) Mañana 18:30", iso: new Date(now + 24 * h + 30 * 60 * 1000).toISOString() },
  ];
}

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

function createHeldAppointment({ phone, service, location, coverage, deposit_amount, start_at }) {
  const appt = {
    id: uid(),
    clinic_id: CLINIC.id,
    user_phone: phone,
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
  store.appointments[idx] = { ...store.appointments[idx], payment_status: "paid", status: "confirmed", payment_ref: paymentRef || "demo-pay" };
  return true;
}

function createHandoff(phone, reason, context) {
  const h = { id: uid(), clinic_id: CLINIC.id, user_phone: phone, reason, context, status: "open", created_at: nowISO() };
  store.handoffs.unshift(h);
  return h;
}

function createPayLink(appointmentId, amount) {
  // (En prod sería tu link real, esto es demo)
  return `http://localhost:${PORT}/api/dev/paylink?ref=${encodeURIComponent(appointmentId)}&amount=${encodeURIComponent(amount)}`;
}

async function handleIncomingText(phone, textIn) {
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
    return [menu()];
  }

  if (state.stage === "menu") {
    if (intent === "reserve") {
      updateConversation(key, { state: { stage: "reserve_service" }, last_intent: "reserve" });
      return ["Genial. ¿Qué necesitás?\n1) EcoDoppler\n2) Holter\n3) ECG\n4) Consulta"];
    }
    if (intent === "reschedule") {
      updateConversation(key, { state: { stage: "reschedule" }, last_intent: "reschedule" });
      return ["Pasame tu DNI o el nombre + día del turno y te lo reprogramo."];
    }
    if (intent === "cancel") {
      updateConversation(key, { state: { stage: "cancel" }, last_intent: "cancel" });
      return ["Pasame tu DNI o el nombre + día del turno y lo cancelo."];
    }
    return ["No te entendí 😅 Respondé con 1, 2, 3 o 4.", menu()];
  }

  if (state.stage === "reserve_service") {
    const serviceMap = { "1": "EcoDoppler", "2": "Holter", "3": "ECG", "4": "Consulta" };
    const service = serviceMap[msg] || (msg.length > 2 ? msg : "");
    if (!service) return ["Elegí 1–4 o escribime el estudio/consulta."];
    updateConversation(key, { state: { stage: "reserve_location", service }, last_intent: "reserve" });
    return ["Perfecto. ¿En qué sede?\n1) Centro\n2) Luján"];
  }

  if (state.stage === "reserve_location") {
    const location = msg === "1" ? "Centro" : msg === "2" ? "Luján" : msg;
    if (!location) return ["Decime 1, 2 o escribime la sede."];
    updateConversation(key, { state: { stage: "reserve_coverage", service: state.service, location }, last_intent: "reserve" });
    return ["Perfecto.\n¿Cómo es tu atención?\n1) Obra social\n2) Particular"];
  }

  if (state.stage === "reserve_coverage") {
    const coverage =
      msg === "1" ? "obra_social" :
      msg === "2" ? "particular" :
      (msg.toLowerCase().includes("obra") ? "obra_social" : "particular");

    const slots = getMockSlots();
    updateConversation(key, { state: { stage: "reserve_slot", service: state.service, location: state.location, coverage, slots }, last_intent: "reserve" });
    return [`Listo. Para ${state.service} en ${state.location}, tengo:\n${slots.map(s => s.label).join("\n")}\nRespondé A, B o C.`];
  }

  if (state.stage === "reserve_slot") {
    const pick = msg.toUpperCase();
    const idx = pick === "A" ? 0 : pick === "B" ? 1 : pick === "C" ? 2 : -1;
    if (idx < 0) return ["Respondé A, B o C 🙌"];

    const chosen = state.slots[idx];
    const isObra = state.coverage === "obra_social";
    const amount = isObra ? CLINIC.deposit_obrasocial : CLINIC.deposit_other;

    const depositText = isObra
      ? "Seña reintegrable: $5.000 (se reintegra el día del turno presentándote en recepción)."
      : "Seña: $10.000 para confirmar el turno.";

    const appt = createHeldAppointment({
      phone,
      service: state.service,
      location: state.location,
      coverage: state.coverage,
      deposit_amount: amount,
      start_at: chosen.iso
    });

    const payUrl = createPayLink(appt.id, amount);
    updateConversation(key, { state: { stage: "await_payment", appointmentId: appt.id }, last_intent: "reserve" });

    return [
      `Perfecto ✅\nTurno: ${state.service} · ${state.location}\n${depositText}\nPagás acá: ${payUrl}\nApenas se acredita te confirmo por acá.`
    ];
  }

  if (state.stage === "await_payment") {
    return ["Estoy esperando la acreditación 👀\nSi querés cancelar o hablar con recepción: respondé 3 o 4."];
  }

  updateConversation(key, { state: { stage: "menu" }, last_intent: null });
  return [menu()];
}

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

// ====== WhatsApp Cloud API sender (Graph) ======
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

function redact(s) {
  if (!s) return "";
  if (s.length <= 10) return "***";
  return s.slice(0, 6) + "..." + s.slice(-4);
}

const server = http.createServer(async (req, res) => {
  console.log("[REQ]", req.method, req.url);

  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname || "/";

  if (serveStatic(req, res, pathname)) return;

  // ---- debug env (safe) ----
  if (req.method === "GET" && pathname === "/api/debug/env") {
    return json(res, 200, {
      ok: true,
      PORT,
      WA_VERIFY_TOKEN: redact(WA_VERIFY_TOKEN),
      WA_ACCESS_TOKEN: redact(WA_ACCESS_TOKEN),
      WA_PHONE_NUMBER_ID: WA_PHONE_NUMBER_ID ? "set" : "missing",
      WA_PHONE_NUMBER_ID_value: WA_PHONE_NUMBER_ID ? redact(WA_PHONE_NUMBER_ID) : "",
    });
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
    const mode = parsed.query["hub.mode"];
    const token = parsed.query["hub.verify_token"];
    const challenge = parsed.query["hub.challenge"];
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

    // Meta manda muchos eventos que NO son mensajes
    if (!from || !textIn) return json(res, 200, { ok: true });

    console.log("[WA IN]", from, textIn);

    const replies = await handleIncomingText(from, textIn);

    for (const r of replies) {
      await sendWhatsAppText(from, r);
    }

    return json(res, 200, { ok: true });
  }

  // Mercado Pago webhook (placeholder)
  if (req.method === "POST" && pathname === "/api/mp/webhook") {
    const raw = await readBody(req);
    const body = safeJsonParse(raw) || {};
    console.log("[MP WEBHOOK]", body);

    const appointmentId = body.external_reference || body.appointmentId || null;
    const status = body.status || null;
    const paymentRef = body.id || body.paymentRef || "mp-demo";

    if (appointmentId && status === "approved") {
      markAppointmentPaid(String(appointmentId), String(paymentRef));
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
    WA_PHONE_NUMBER_ID_preview: redact(WA_PHONE_NUMBER_ID)
  });

  if (!WA_ACCESS_TOKEN || !WA_PHONE_NUMBER_ID) {
    console.log("⚠️ Missing WA_ACCESS_TOKEN or WA_PHONE_NUMBER_ID. Incoming will be handled but replies won't be sent.");
  }
});
