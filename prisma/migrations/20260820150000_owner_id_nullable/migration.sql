-- Fase 3 Milestone 2 — isolamento por usuário. Colunas ownerId nullable
-- nesta migration (dado existente ainda não tem dono); uma segunda
-- migration (20260820151000_owner_id_not_null) vira NOT NULL depois do
-- backfill manual pro usuário #1.

-- Bot
ALTER TABLE "Bot" ADD COLUMN "ownerId" TEXT;
ALTER TABLE "Bot" ADD CONSTRAINT "Bot_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Flow — key era unique global, vira unique por dono
ALTER TABLE "Flow" ADD COLUMN "ownerId" TEXT;
ALTER TABLE "Flow" ADD CONSTRAINT "Flow_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
DROP INDEX "Flow_key_key";
CREATE UNIQUE INDEX "Flow_ownerId_key_key" ON "Flow"("ownerId", "key");

-- Origin — param era unique global, vira unique por dono
ALTER TABLE "Origin" ADD COLUMN "ownerId" TEXT;
ALTER TABLE "Origin" ADD CONSTRAINT "Origin_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
DROP INDEX "Origin_param_key";
CREATE UNIQUE INDEX "Origin_ownerId_param_key" ON "Origin"("ownerId", "param");

-- Settings — deixa de ser uma linha global fixa ("singleton"), vira 1 por
-- usuário. O default de "id" muda de string fixa pra cuid só no schema
-- (não afeta a linha já existente, que mantém id="singleton").
ALTER TABLE "Settings" ADD COLUMN "ownerId" TEXT;
ALTER TABLE "Settings" ADD CONSTRAINT "Settings_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "Settings_ownerId_key" ON "Settings"("ownerId");
