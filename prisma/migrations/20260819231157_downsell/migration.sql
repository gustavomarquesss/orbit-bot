-- CreateEnum
CREATE TYPE "DownsellTrigger" AS ENUM ('GENERAL', 'PIX_GENERATED');

-- CreateEnum
CREATE TYPE "DiscountType" AS ENUM ('PERCENT', 'FIXED');

-- CreateTable
CREATE TABLE "DownsellConfig" (
    "id" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DownsellConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DownsellSequence" (
    "id" TEXT NOT NULL,
    "configId" TEXT NOT NULL,
    "trigger" "DownsellTrigger" NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "delayMinutes" INTEGER NOT NULL DEFAULT 5,
    "discountType" "DiscountType" NOT NULL DEFAULT 'PERCENT',
    "discountValue" INTEGER NOT NULL DEFAULT 0,
    "message" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DownsellSequence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DownsellSequenceMedia" (
    "id" TEXT NOT NULL,
    "sequenceId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "mediaType" "MediaType" NOT NULL,
    "fileId" TEXT NOT NULL,

    CONSTRAINT "DownsellSequenceMedia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DownsellSequencePlan" (
    "id" TEXT NOT NULL,
    "sequenceId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "DownsellSequencePlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduledDownsellSend" (
    "id" TEXT NOT NULL,
    "sequenceId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "orderId" TEXT,
    "sendAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduledDownsellSend_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DownsellConfig_flowId_key" ON "DownsellConfig"("flowId");

-- CreateIndex
CREATE UNIQUE INDEX "DownsellSequenceMedia_sequenceId_order_key" ON "DownsellSequenceMedia"("sequenceId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "DownsellSequencePlan_sequenceId_planId_key" ON "DownsellSequencePlan"("sequenceId", "planId");

-- CreateIndex
CREATE INDEX "ScheduledDownsellSend_sendAt_idx" ON "ScheduledDownsellSend"("sendAt");

-- CreateIndex
CREATE INDEX "ScheduledDownsellSend_leadId_idx" ON "ScheduledDownsellSend"("leadId");

-- AddForeignKey
ALTER TABLE "DownsellConfig" ADD CONSTRAINT "DownsellConfig_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "Flow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DownsellSequence" ADD CONSTRAINT "DownsellSequence_configId_fkey" FOREIGN KEY ("configId") REFERENCES "DownsellConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DownsellSequenceMedia" ADD CONSTRAINT "DownsellSequenceMedia_sequenceId_fkey" FOREIGN KEY ("sequenceId") REFERENCES "DownsellSequence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DownsellSequencePlan" ADD CONSTRAINT "DownsellSequencePlan_sequenceId_fkey" FOREIGN KEY ("sequenceId") REFERENCES "DownsellSequence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DownsellSequencePlan" ADD CONSTRAINT "DownsellSequencePlan_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledDownsellSend" ADD CONSTRAINT "ScheduledDownsellSend_sequenceId_fkey" FOREIGN KEY ("sequenceId") REFERENCES "DownsellSequence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledDownsellSend" ADD CONSTRAINT "ScheduledDownsellSend_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledDownsellSend" ADD CONSTRAINT "ScheduledDownsellSend_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
