-- Fase 2, Milestone 4 (ajuste): botoes de aceitar/recusar de uma Offer
-- ficam com texto editavel pelo admin, em vez de fixo.

-- AlterTable
ALTER TABLE "Offer" ADD COLUMN     "acceptLabel" TEXT,
ADD COLUMN     "declineLabel" TEXT;
