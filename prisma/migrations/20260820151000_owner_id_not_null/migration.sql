-- Backfill (usuário #1, dono de tudo que já existia) já rodado manualmente
-- antes desta migration — ver Fase 3 Milestone 2 no plano.
ALTER TABLE "Bot" ALTER COLUMN "ownerId" SET NOT NULL;
ALTER TABLE "Flow" ALTER COLUMN "ownerId" SET NOT NULL;
ALTER TABLE "Origin" ALTER COLUMN "ownerId" SET NOT NULL;
ALTER TABLE "Settings" ALTER COLUMN "ownerId" SET NOT NULL;
