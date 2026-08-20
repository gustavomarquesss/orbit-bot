-- Tabela vazia até agora nesta instância — sem passo de backfill necessário.
ALTER TABLE "DashboardNote" ADD COLUMN "ownerId" TEXT NOT NULL;
ALTER TABLE "DashboardNote" ADD CONSTRAINT "DashboardNote_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
