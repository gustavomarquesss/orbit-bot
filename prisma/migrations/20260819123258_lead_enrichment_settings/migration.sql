-- Fase 2, Milestone 2: enriquecimento de Lead (idioma/premium, pro canal de
-- vendas rico) + tabela Settings (singleton) pro canal de vendas global,
-- configurável no painel sem precisar de redeploy.

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "isPremium" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "languageCode" TEXT;

-- CreateTable
CREATE TABLE "Settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "salesChannelId" TEXT,

    CONSTRAINT "Settings_pkey" PRIMARY KEY ("id")
);
