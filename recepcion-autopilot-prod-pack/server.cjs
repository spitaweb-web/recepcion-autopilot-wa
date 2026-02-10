/**
 * Recepción Autopilot — Zero-deps production pack (CommonJS)
 * - Static web demo (/) + admin (/admin)
 * - WhatsApp Cloud API webhook: /api/whatsapp (GET verify, POST messages)
 * - Minimal in-memory store (for demo)
 *
 * No external dependencies. Node 18+ recommended (Node 20 OK).
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

// ------------------ Config ------------------
const PORT = parseInt(process.env.PORT || "3000", 10);
const CLINIC_NAME = process.env.CLINIC_NAME || "Clínica Ortega";

// WhatsApp Cloud API (Meta)
const WA_VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN || "spita_verify_123";
const WA_ACCESS_TOKEN = process.env.WA_ACCESS_TOKEN || "";
const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID || "";
const WA_GRAPH_VERSION = process.env.WA_GRAPH_VERSION || "v19.0"; // stable

// ------------------ In-memory store (demo) ------------------
const store = {
  messages: [], // {ts, from, text, channel}
  appointments: [], // {id, name, phone, service, date, slot, payerType, deposit, status, createdAt}
  handoffs: [], // {id, phone, reason, context, createdAt, status}
};

function nowISO() {
  return new Date().toISOString();
}

function json(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function text(res, statusCode, body) {
  res.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function badRequest(res, msg) {
  json(res, 400, { ok: false, error: msg || "bad_request" });
}

function notFound(res) {
  json(res, 404, { ok: false, error: "not_found" });
}

function readBody(req, limitBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error("payload_too_large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function serveStatic(req, res) {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  let pathname = u.pathname;

  if (pathname === "/") pathname = "/index.html";
  const filePath = path.join(__dirname, "public", pathname.replace(/^\/+/, ""));
  const publicRoot = path.join(__dirname, "public");

  // Prevent path traversal
  if (!filePath.startsWith(publicRoot)) {
    return notFound(res);
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return notFound(res);
  }

  const ext = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
  };
  const ctype = types[ext] || "application/octet-stream";

  res.writeHead(200, { "content-type": ctype, "cache-control": "no-cache" });
  fs.createReadStream(filePath).pipe(res);
}

function pickTextFromWAMessage(msg) {
  // https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/components/
  if (!msg) return "";
  if (msg.type === "text" && msg.text && msg.text.body) return msg.text.body;
  // future: interactive, button, etc.
  return "";
}

function buildAutoReply(userText) {
  const t = (userText || "").trim().toLowerCase();

  // Concierge-minimal demo replies
  if (!t) return `Hola 👋 Soy la recepción de ${CLINIC_NAME}. ¿Qué necesitás: reservar, reprogramar o cancelar?`;

  if (t.includes("hola") || t.includes("buenas") || t.includes("buen")) {
    return `Hola 👋 Soy la recepción de ${CLINIC_NAME}. ¿Querés reservar turno? (respondé: reservar)`;
  }
  if (t.includes("reservar")) {
    return `Perfecto. ¿Qué estudio? (EcoDoppler / Holter / ECG / Consulta)`;
  }
  if (t.includes("ecodoppler") || t.includes("eco")) {
    return `EcoDoppler ✅ ¿Obra social o particular?`;
  }
  if (t.includes("obra")) {
    return `Obra social ✅ Seña reintegrable $5.000. ¿Te va bien esta semana? (sí/no)`;
  }
  if (t.includes("particular")) {
    return `Particular ✅ Seña $10.000. ¿Te va bien esta semana? (sí/no)`;
  }
  if (t === "si" || t === "sí") {
    return `Genial. Te paso el link de seña (demo) y al pagar queda confirmado.`;
  }
  if (t.includes("cancel")) {
    return `Ok. Decime tu DNI o nombre completo y te lo cancelo (demo).`;
  }
  if (t.includes("reprog")) {
    return `Ok. Decime tu DNI o nombre y te propongo 2 horarios (demo).`;
  }

  return `Te leo. Para avanzar rápido: respondé "reservar", "reprogramar" o "cancelar".`;
}

async function waSendText(to, body) {
  if (!WA_ACCESS_TOKEN || !WA_PHONE_NUMBER_ID) {
    return { ok: false, error: "wa_not_configured" };
  }

  const url = `https://graph.facebook.com/${WA_GRAPH_VERSION}/${WA_PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: body.slice(0, 3900) },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${WA_ACCESS_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    return { ok: false, status: resp.status, data };
  }
  return { ok: true, data };
}

function logMessage(channel, from, textBody) {
  store.messages.push({ ts: nowISO(), from, text: textBody, channel });
  if (store.messages.length > 500) store.messages.shift();
}

// ------------------ API routes ------------------
async function handleApi(req, res) {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const p = u.pathname;

  if (p === "/api/health") {
    return json(res, 200, { ok: true, clinic: CLINIC_NAME, time: nowISO() });
  }

  if (p === "/api/admin/state") {
    return json(res, 200, { ok: true, store });
  }

  // WhatsApp webhook verify (GET)
  if (p === "/api/whatsapp" && req.method === "GET") {
    const mode = u.searchParams.get("hub.mode");
    const token = u.searchParams.get("hub.verify_token");
    const challenge = u.searchParams.get("hub.challenge");

    if (mode === "subscribe" && token === WA_VERIFY_TOKEN && challenge) {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      return res.end(challenge);
    }
    return text(res, 403, "Forbidden");
  }

  // WhatsApp webhook receive (POST)
  if (p === "/api/whatsapp" && req.method === "POST") {
    const raw = await readBody(req).catch((e) => {
      if (String(e.message) === "payload_too_large") return null;
      throw e;
    });
    if (raw == null) return badRequest(res, "payload_too_large");

    const payload = safeJsonParse(raw);
    // Always 200 to acknowledge quickly (Meta expects this)
    json(res, 200, { ok: true });

    // Process async (don't block the response)
    setImmediate(async () => {
      try {
        const entry = payload && payload.entry && payload.entry[0];
        const change = entry && entry.changes && entry.changes[0];
        const value = change && change.value;
        const messages = value && value.messages;

        if (!Array.isArray(messages) || messages.length === 0) return;

        for (const m of messages) {
          const from = m.from || "unknown";
          const userText = pickTextFromWAMessage(m);

          logMessage("whatsapp", from, userText);

          const reply = buildAutoReply(userText);

          // If reply contains deposit hint, we can also include a demo URL
          let finalReply = reply;
          if (reply.includes("link de seña")) {
            finalReply = `${reply}\n\nLink (demo): http://localhost:${PORT}/?deposit=1`;
          }

          const sent = await waSendText(from, finalReply);
          logMessage("whatsapp-out", from, `[sent=${sent.ok}] ${finalReply}`);
        }
      } catch (err) {
        // best-effort logging
        logMessage("system", "server", `wa_handler_error: ${String(err && err.message || err)}`);
      }
    });

    return;
  }

  // Mercado Pago webhook placeholder (POST)
  if (p === "/api/mp/webhook" && req.method === "POST") {
    // Store raw for later reconciliation (demo)
    const raw = await readBody(req).catch(() => "");
    logMessage("mp", "webhook", raw.slice(0, 5000));
    return json(res, 200, { ok: true });
  }

  return notFound(res);
}

// ------------------ Main server ------------------
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://localhost:${PORT}`);

    if (u.pathname.startsWith("/api/")) {
      return await handleApi(req, res);
    }

    return serveStatic(req, res);
  } catch (err) {
    return json(res, 500, { ok: false, error: "server_error", detail: String(err && err.message || err) });
  }
});

server.listen(PORT, () => {
  console.log(`[Recepción Autopilot] running on http://localhost:${PORT}`);
  console.log(`[Recepción Autopilot] clinic = ${CLINIC_NAME}`);
  console.log(`[Recepción Autopilot] webhook = /api/whatsapp (verify+messages)`);
});
