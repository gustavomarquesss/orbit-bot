-- Fase 2, Milestone 4 (redesign): Upsell vira uma sequencia de mensagens
-- (nao mais vinculado a um plano-gatilho especifico -- dispara apos
-- QUALQUER compra do funil), cada uma com atraso configuravel, planos
-- anexados e botoes livres (compra plano ou abre link). Substitui o
-- mecanismo antigo baseado em Offer(kind=UPSELL), que fica sem uso.

-- CreateEnum
CREATE TYPE "UpsellButtonType" AS ENUM ('BUY_PLAN', 'OPEN_LINK');

-- CreateTable
CREATE TABLE "UpsellSequence" (
    "id" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "UpsellSequence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UpsellMessage" (
    "id" TEXT NOT NULL,
    "sequenceId" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "text" TEXT,
    "delayMinutes" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UpsellMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UpsellMessagePlan" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "UpsellMessagePlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UpsellMessageButton" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "text" TEXT NOT NULL,
    "type" "UpsellButtonType" NOT NULL,
    "targetPlanId" TEXT,
    "url" TEXT,

    CONSTRAINT "UpsellMessageButton_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduledUpsellSend" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "sendAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduledUpsellSend_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UpsellSequence_flowId_key" ON "UpsellSequence"("flowId");

-- CreateIndex
CREATE UNIQUE INDEX "UpsellMessagePlan_messageId_planId_key" ON "UpsellMessagePlan"("messageId", "planId");

-- CreateIndex
CREATE INDEX "ScheduledUpsellSend_sendAt_idx" ON "ScheduledUpsellSend"("sendAt");

-- AddForeignKey
ALTER TABLE "UpsellSequence" ADD CONSTRAINT "UpsellSequence_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "Flow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UpsellMessage" ADD CONSTRAINT "UpsellMessage_sequenceId_fkey" FOREIGN KEY ("sequenceId") REFERENCES "UpsellSequence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UpsellMessagePlan" ADD CONSTRAINT "UpsellMessagePlan_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "UpsellMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UpsellMessagePlan" ADD CONSTRAINT "UpsellMessagePlan_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UpsellMessageButton" ADD CONSTRAINT "UpsellMessageButton_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "UpsellMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UpsellMessageButton" ADD CONSTRAINT "UpsellMessageButton_targetPlanId_fkey" FOREIGN KEY ("targetPlanId") REFERENCES "Plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledUpsellSend" ADD CONSTRAINT "ScheduledUpsellSend_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "UpsellMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledUpsellSend" ADD CONSTRAINT "ScheduledUpsellSend_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Limpa a Offer(kind=UPSELL) de teste criada antes desse redesign -- o
-- mecanismo antigo nao e mais lido pelo runtime.
DELETE FROM "Offer" WHERE "kind" = 'UPSELL';
