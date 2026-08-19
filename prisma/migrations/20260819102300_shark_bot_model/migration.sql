-- CreateEnum
CREATE TYPE "OriginKind" AS ENUM ('BOT', 'CHANNEL', 'CAMPAIGN', 'OTHER');

-- CreateEnum
CREATE TYPE "BotCommandKind" AS ENUM ('START', 'SUPORTE', 'STATUS');

-- CreateEnum
CREATE TYPE "MediaType" AS ENUM ('PHOTO', 'VIDEO', 'AUDIO', 'DOCUMENT');

-- CreateEnum
CREATE TYPE "PlanButtonColor" AS ENUM ('PADRAO', 'AZUL', 'VERDE', 'VERMELHO');

-- CreateEnum
CREATE TYPE "DeliveryType" AS ENUM ('FILE', 'LINK');

-- CreateEnum
CREATE TYPE "PaymentButtonStyle" AS ENUM ('PADRAO', 'COMPACTO');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'PAID', 'REFUSED', 'EXPIRED');

-- CreateTable
CREATE TABLE "Origin" (
    "id" TEXT NOT NULL,
    "param" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "kind" "OriginKind" NOT NULL DEFAULT 'OTHER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Origin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bot" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "telegramBotTokenEncrypted" TEXT NOT NULL,
    "telegramUsername" TEXT,
    "telegramUserId" BIGINT,
    "displayName" TEXT,
    "photoFileId" TEXT,
    "description" TEXT,
    "shortDescription" TEXT,
    "webhookSecret" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Bot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotCommand" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "kind" "BotCommandKind" NOT NULL,
    "emoji" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "order" INTEGER NOT NULL,

    CONSTRAINT "BotCommand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "telegramId" BIGINT NOT NULL,
    "botId" TEXT NOT NULL,
    "username" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "originId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Flow" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Flow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FlowBot" (
    "flowId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,

    CONSTRAINT "FlowBot_pkey" PRIMARY KEY ("flowId","botId")
);

-- CreateTable
CREATE TABLE "WelcomeConfig" (
    "id" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "text" TEXT,
    "secondaryMessageEnabled" BOOLEAN NOT NULL DEFAULT false,
    "ctaButtonEnabled" BOOLEAN NOT NULL DEFAULT false,
    "ctaLabel" TEXT,
    "miniAppEnabled" BOOLEAN NOT NULL DEFAULT false,
    "miniAppUrl" TEXT,
    "defaultDeliveryTarget" TEXT,

    CONSTRAINT "WelcomeConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WelcomeMedia" (
    "id" TEXT NOT NULL,
    "welcomeConfigId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "mediaType" "MediaType" NOT NULL,
    "fileId" TEXT NOT NULL,

    CONSTRAINT "WelcomeMedia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RedirectButton" (
    "id" TEXT NOT NULL,
    "welcomeConfigId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "url" TEXT NOT NULL,

    CONSTRAINT "RedirectButton_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Plan" (
    "id" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "durationDays" INTEGER,
    "buttonColor" "PlanButtonColor" NOT NULL DEFAULT 'PADRAO',
    "deliveryType" "DeliveryType" NOT NULL,
    "fileTelegramId" TEXT,
    "externalLink" TEXT,
    "customDeliveryTarget" TEXT,
    "protectContent" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentMessages" (
    "id" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "pixGeneratedMessage" TEXT,
    "pixApprovedMessage" TEXT,
    "buttonStyle" "PaymentButtonStyle" NOT NULL DEFAULT 'PADRAO',
    "showConfirmationStep" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "PaymentMessages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "originId" TEXT,
    "syncpayChargeId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "pixCopyPaste" TEXT,
    "qrCodeUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'syncpay',
    "externalId" TEXT NOT NULL,
    "orderId" TEXT,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Origin_param_key" ON "Origin"("param");

-- CreateIndex
CREATE UNIQUE INDEX "BotCommand_botId_kind_key" ON "BotCommand"("botId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_telegramId_botId_key" ON "Lead"("telegramId", "botId");

-- CreateIndex
CREATE UNIQUE INDEX "Flow_key_key" ON "Flow"("key");

-- CreateIndex
CREATE UNIQUE INDEX "WelcomeConfig_flowId_key" ON "WelcomeConfig"("flowId");

-- CreateIndex
CREATE UNIQUE INDEX "WelcomeMedia_welcomeConfigId_order_key" ON "WelcomeMedia"("welcomeConfigId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "RedirectButton_welcomeConfigId_order_key" ON "RedirectButton"("welcomeConfigId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentMessages_flowId_key" ON "PaymentMessages"("flowId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_syncpayChargeId_key" ON "Order"("syncpayChargeId");

-- CreateIndex
CREATE INDEX "Order_status_idx" ON "Order"("status");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_provider_externalId_key" ON "WebhookEvent"("provider", "externalId");

-- AddForeignKey
ALTER TABLE "BotCommand" ADD CONSTRAINT "BotCommand_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_originId_fkey" FOREIGN KEY ("originId") REFERENCES "Origin"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FlowBot" ADD CONSTRAINT "FlowBot_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "Flow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FlowBot" ADD CONSTRAINT "FlowBot_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WelcomeConfig" ADD CONSTRAINT "WelcomeConfig_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "Flow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WelcomeMedia" ADD CONSTRAINT "WelcomeMedia_welcomeConfigId_fkey" FOREIGN KEY ("welcomeConfigId") REFERENCES "WelcomeConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RedirectButton" ADD CONSTRAINT "RedirectButton_welcomeConfigId_fkey" FOREIGN KEY ("welcomeConfigId") REFERENCES "WelcomeConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Plan" ADD CONSTRAINT "Plan_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "Flow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentMessages" ADD CONSTRAINT "PaymentMessages_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "Flow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_originId_fkey" FOREIGN KEY ("originId") REFERENCES "Origin"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
