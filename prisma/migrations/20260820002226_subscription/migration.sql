-- AlterEnum
ALTER TYPE "DeliveryType" ADD VALUE 'CHANNEL';

-- AlterTable
ALTER TABLE "PaymentMessages" ADD COLUMN     "renewalMessage" TEXT;

-- AlterTable
ALTER TABLE "Plan" ADD COLUMN     "subscriptionChannelId" TEXT;
