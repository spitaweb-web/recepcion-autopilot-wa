(function(){
  const chat = document.getElementById("chat");
  const phoneEl = document.getElementById("phone");
  const inputEl = document.getElementById("input");
  const sendBtn = document.getElementById("send");
  const detectBox = document.getElementById("detect");
  const apptShort = document.getElementById("apptShort");
  const payBtn = document.getElementById("payBtn");

  let lastAppointmentId = null;
  let busy = false;

  function addBubble(role, text){
    const wrap = document.createElement("div");
    wrap.style.display = "flex";
    wrap.style.justifyContent = role === "user" ? "flex-end" : "flex-start";
    const bubble = document.createElement("div");
    bubble.className = "bubble" + (role === "user" ? " bubbleUser" : "");
    bubble.textContent = text;
    wrap.appendChild(bubble);
    chat.appendChild(wrap);
    chat.scrollTop = chat.scrollHeight;
  }

  function extractAppointmentIdFromText(text){
    const m = String(text).match(/paylink\?ref=([a-f0-9\-]{20,})/i);
    return m && m[1] ? m[1] : null;
  }

  async function send(text){
    const t = String(text || "").trim();
    if(!t || busy) return;

    addBubble("user", t);
    inputEl.value = "";
    busy = true;

    try{
      const res = await fetch("/api/dev/simulate", {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ phone: phoneEl.value.trim() || "5492610000000", text: t })
      });
      const data = await res.json();
      const replies = data.replies || ["(Sin respuesta)"];
      replies.forEach(r => {
        addBubble("bot", r);
        const id = extractAppointmentIdFromText(r);
        if(id) lastAppointmentId = id;
      });

      if(lastAppointmentId){
        detectBox.style.display = "flex";
        apptShort.textContent = lastAppointmentId.slice(0,8) + "…";
      }
    }catch(e){
      addBubble("bot", "Uy, algo falló. Probemos de nuevo.");
    }finally{
      busy = false;
    }
  }

  sendBtn.addEventListener("click", () => send(inputEl.value));
  inputEl.addEventListener("keydown", (e) => { if(e.key === "Enter") send(inputEl.value); });

  document.querySelectorAll(".quick").forEach(btn => {
    btn.addEventListener("click", () => send(btn.getAttribute("data-q")));
  });

  payBtn.addEventListener("click", async () => {
    if(!lastAppointmentId || busy) return;
    busy = true;
    try{
      await fetch("/api/dev/pay", {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ appointmentId: lastAppointmentId, paymentRef: "demo-123" })
      });
      addBubble("bot", "Pago acreditado ✅ Turno confirmado. Te llega recordatorio 24 hs antes.");
    }catch(e){
      addBubble("bot", "No pude marcar el pago. Probemos de nuevo.");
    }finally{
      busy = false;
    }
  });

  addBubble("bot", "Hola 👋 Soy la recepción automática de Clínica Ortega. Escribí “hola” para empezar.");
})();
