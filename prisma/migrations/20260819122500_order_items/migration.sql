-- Fase 2, Milestone 1: Order deixa de ser 1:1 com um Plan e passa a ter
-- itens de linha (OrderItem) — pré-requisito pra Order Bump (base + itens
-- extras numa única cobrança PIX). Esta migration PRECISA copiar os dados
-- de Order.planId pros novos OrderItem antes de dropar a coluna, senão
-- perde o histórico de vendas já reais feito nesta sessão (edição manual
-- em cima do diff gerado por `prisma migrate diff`).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- CreateEnum
CREATE TYPE "OrderItemKind" AS ENUM ('BASE', 'ORDER_BUMP', 'UPSELL', 'DOWNSELL');

-- CreateTable
CREATE TABLE "OrderItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "kind" "OrderItemKind" NOT NULL DEFAULT 'BASE',
    "unitPriceCents" INTEGER NOT NULL,
    "accessExpiresAt" TIMESTAMP(3),
    "renewalReminderSentAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderItem_orderId_idx" ON "OrderItem"("orderId");

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- DataMigration: copia cada Order existente pra um OrderItem BASE antes de
-- dropar Order.planId. amountCents do Order vira unitPriceCents do item
-- (nesta migration todo Order ainda tem exatamente 1 item, então os
-- valores batem 1:1 — deixa de ser verdade só a partir do Milestone 4).
INSERT INTO "OrderItem" ("id", "orderId", "planId", "kind", "unitPriceCents")
SELECT gen_random_uuid()::text, "id", "planId", 'BASE', "amountCents"
FROM "Order"
WHERE "planId" IS NOT NULL;

-- DropForeignKey
ALTER TABLE "Order" DROP CONSTRAINT "Order_planId_fkey";

-- AlterTable
ALTER TABLE "Order" DROP COLUMN "planId";
