# Meta setup checklist (fast)

## Use test number
1) Meta Developers → App → WhatsApp → Getting Started
2) Copy:
   - Temporary access token
   - Phone number ID
3) Webhooks:
   - Callback URL: https://PUBLIC_URL/api/whatsapp
   - Verify token: spita_verify_123 (or your custom token)
   - Subscribe to: messages
4) Start server with env vars filled.
5) Send a test message from the Quickstart and reply from your WhatsApp with "hola".
