-- Redesenho da seção Pagamentos (paridade Shark Bot): mídia própria pra
-- instrução/aprovação, mensagens auxiliares antes do código/botões,
-- botões Verificar Status/Copiar Código, Prova Social rotativa e opções
-- de exibição do QR/formato do código.

-- CreateEnum
CREATE TYPE "QrCodeDisplay" AS ENUM ('IMAGE', 'HIDDEN');

-- CreateEnum
CREATE TYPE "PixCodeFormat" AS ENUM ('CODE', 'PLAIN');

-- AlterTable
ALTER TABLE "PaymentMessages"
  ADD COLUMN "showButtonsIntroMessage" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "buttonsIntroMessage" TEXT,
  ADD COLUMN "pixCodeInSameMessage" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "showPixCodeIntroMessage" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "pixCodeIntroMessage" TEXT,
  ADD COLUMN "showCheckStatusButton" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "showCopyCodeButton" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "showSocialProof" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "socialProofIntervalSeconds" INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN "qrCodeDisplay" "QrCodeDisplay" NOT NULL DEFAULT 'IMAGE',
  ADD COLUMN "pixCodeFormat" "PixCodeFormat" NOT NULL DEFAULT 'CODE',
  ADD COLUMN "showAccessButton" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "PaymentGeneratedMedia" (
    "id" TEXT NOT NULL,
    "paymentMessagesId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "mediaType" "MediaType" NOT NULL,
    "fileId" TEXT NOT NULL,

    CONSTRAINT "PaymentGeneratedMedia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentApprovedMedia" (
    "id" TEXT NOT NULL,
    "paymentMessagesId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "mediaType" "MediaType" NOT NULL,
    "fileId" TEXT NOT NULL,

    CONSTRAINT "PaymentApprovedMedia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialProofMessage" (
    "id" TEXT NOT NULL,
    "paymentMessagesId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "text" TEXT NOT NULL,

    CONSTRAINT "SocialProofMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduledSocialProofEdit" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "messageId" INTEGER NOT NULL,
    "orderId" TEXT NOT NULL,
    "messages" TEXT[],
    "lastIndex" INTEGER NOT NULL DEFAULT -1,
    "intervalSeconds" INTEGER NOT NULL,
    "nextTickAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ScheduledSocialProofEdit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentGeneratedMedia_paymentMessagesId_order_key" ON "PaymentGeneratedMedia"("paymentMessagesId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentApprovedMedia_paymentMessagesId_order_key" ON "PaymentApprovedMedia"("paymentMessagesId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "SocialProofMessage_paymentMessagesId_order_key" ON "SocialProofMessage"("paymentMessagesId", "order");

-- CreateIndex
CREATE INDEX "ScheduledSocialProofEdit_nextTickAt_idx" ON "ScheduledSocialProofEdit"("nextTickAt");

-- AddForeignKey
ALTER TABLE "PaymentGeneratedMedia" ADD CONSTRAINT "PaymentGeneratedMedia_paymentMessagesId_fkey" FOREIGN KEY ("paymentMessagesId") REFERENCES "PaymentMessages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentApprovedMedia" ADD CONSTRAINT "PaymentApprovedMedia_paymentMessagesId_fkey" FOREIGN KEY ("paymentMessagesId") REFERENCES "PaymentMessages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialProofMessage" ADD CONSTRAINT "SocialProofMessage_paymentMessagesId_fkey" FOREIGN KEY ("paymentMessagesId") REFERENCES "PaymentMessages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
