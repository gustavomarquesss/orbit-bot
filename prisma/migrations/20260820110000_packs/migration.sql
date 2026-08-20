-- Packs (Fase 2, Milestone 8) — Pack é um Plan com productType = PACK,
-- reaproveitando todo o pipeline de Order/entrega já existente.

-- DeliveryType ganha "Apenas Mensagem".
ALTER TYPE "DeliveryType" ADD VALUE 'MESSAGE';

-- Novo enum pra distinguir Plan normal de Pack.
CREATE TYPE "ProductType" AS ENUM ('PLAN', 'PACK');

ALTER TABLE "Plan" ADD COLUMN "productType" "ProductType" NOT NULL DEFAULT 'PLAN';
ALTER TABLE "Plan" ADD COLUMN "description" TEXT;
ALTER TABLE "Plan" ADD COLUMN "messageContent" TEXT;

CREATE TABLE "PackPreviewMedia" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "mediaType" "MediaType" NOT NULL,
    "fileId" TEXT NOT NULL,

    CONSTRAINT "PackPreviewMedia_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PackPreviewMedia_planId_order_key" ON "PackPreviewMedia"("planId", "order");

ALTER TABLE "PackPreviewMedia" ADD CONSTRAINT "PackPreviewMedia_planId_fkey"
    FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PackConfig" (
    "id" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "buttonLabel" TEXT,
    "headerMessage" TEXT,

    CONSTRAINT "PackConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PackConfig_flowId_key" ON "PackConfig"("flowId");

ALTER TABLE "PackConfig" ADD CONSTRAINT "PackConfig_flowId_fkey"
    FOREIGN KEY ("flowId") REFERENCES "Flow"("id") ON DELETE CASCADE ON UPDATE CASCADE;
