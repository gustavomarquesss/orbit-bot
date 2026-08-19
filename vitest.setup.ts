// Valores dummy só pra satisfazer o zod schema de src/config.ts nos testes —
// nunca credenciais reais (não há .env neste worktree).
process.env.TELEGRAM_ADMIN_USER_ID ??= "123456";
process.env.BOT_TOKEN_ENCRYPTION_KEY ??= "test-bot-token-encryption-key-1234567890";
process.env.SYNCPAY_CLIENT_ID ??= "test-syncpay-client-id";
process.env.SYNCPAY_CLIENT_SECRET ??= "test-syncpay-client-secret";
process.env.SYNCPAY_API_BASE_URL ??= "https://api.syncpay.pro";
process.env.SYNCPAY_WEBHOOK_SECRET ??= "test-syncpay-webhook-secret";
process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/dgbot_test";
process.env.ADMIN_PANEL_PASSWORD ??= "test-admin-password";
process.env.SESSION_SECRET ??= "test-session-secret-1234567890";
process.env.PUBLIC_BASE_URL ??= "http://localhost:3000";
process.env.NODE_ENV ??= "test";
