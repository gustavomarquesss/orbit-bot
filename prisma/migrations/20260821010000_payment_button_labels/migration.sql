-- Rótulos editáveis dos botões da seção Pagamentos (Verificar Status,
-- Copiar Código, Acessar Conteúdo) — vazio continua usando o texto padrão.
ALTER TABLE "PaymentMessages"
  ADD COLUMN "checkStatusButtonLabel" TEXT,
  ADD COLUMN "copyCodeButtonLabel" TEXT,
  ADD COLUMN "accessButtonLabel" TEXT;
