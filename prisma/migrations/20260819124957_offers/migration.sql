-- Fase 2, Milestone 4: Offer (Order Bump / Upsell / Downsell) — regra
-- "quando compra/recusa X, oferece Y", onde Y e sempre um Plan normal.

-- CreateEnum
CREATE TYPE "OfferKind" AS ENUM ('ORDER_BUMP', 'UPSELL', 'DOWNSELL');

-- CreateTable
CREATE TABLE "Offer" (
    "id" TEXT NOT NULL,
    "triggerPlanId" TEXT NOT NULL,
    "offeredPlanId" TEXT NOT NULL,
    "kind" "OfferKind" NOT NULL,
    "parentOfferId" TEXT,
    "message" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Offer_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_triggerPlanId_fkey" FOREIGN KEY ("triggerPlanId") REFERENCES "Plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_offeredPlanId_fkey" FOREIGN KEY ("offeredPlanId") REFERENCES "Plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_parentOfferId_fkey" FOREIGN KEY ("parentOfferId") REFERENCES "Offer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
