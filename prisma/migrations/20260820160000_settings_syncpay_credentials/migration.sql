-- Credenciais SyncPay por usuário (Fase 3 Milestone 3) — antes fixas no
-- .env. Todas nullable: ninguém tem conta configurada ainda até salvar em
-- /admin/settings.
ALTER TABLE "Settings" ADD COLUMN "syncpayClientId" TEXT;
ALTER TABLE "Settings" ADD COLUMN "syncpayClientSecretEncrypted" TEXT;
ALTER TABLE "Settings" ADD COLUMN "syncpayWebhookSecret" TEXT;
