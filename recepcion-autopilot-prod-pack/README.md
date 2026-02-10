# Recepción Autopilot — Prod Pack (Zero deps)

Este paquete está listo para conectarse a WhatsApp Cloud API (Meta) con número de prueba o número real.

## Lo mínimo que necesitás
- Node 18+ (recomendado Node 20)
- Una URL pública HTTPS para el webhook (ngrok con authtoken, Cloudflare Tunnel, o deploy)

## Rutas
- Web demo: http://localhost:3000/
- Admin: http://localhost:3000/admin.html
- Health: http://localhost:3000/api/health
- WhatsApp webhook: /api/whatsapp
- Mercado Pago webhook (placeholder): /api/mp/webhook

## Variables
Copiá `.env.example` a `.env` y completá:
- WA_ACCESS_TOKEN
- WA_PHONE_NUMBER_ID
- WA_VERIFY_TOKEN (el mismo que ponés en Meta)

## Run
- `node server.cjs`

## Meta (resumen)
1) Webhooks:
   - Callback: https://TU_URL/api/whatsapp
   - Verify token: igual a WA_VERIFY_TOKEN
   - Subscribe: messages
2) WhatsApp:
   - Usá el número de prueba y el token temporal para validar.
