-- "Entrega Padrão (Fallback)" do Flow — substitui WelcomeConfig.defaultDeliveryTarget
-- por um model próprio (FlowDelivery), e Plan.deliveryType vira opcional
-- (nulo = "usar padrão do fluxo"). Pedido do usuário, 2026-08-20, espelhando
-- a referência ApexVips/SharkBot.

-- CreateTable
CREATE TABLE "FlowDelivery" (
    "id" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "deliveryType" "DeliveryType" NOT NULL DEFAULT 'FILE',
    "deliveryTarget" TEXT,
    "fileTelegramId" TEXT,
    "externalLink" TEXT,

    CONSTRAINT "FlowDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FlowDelivery_flowId_key" ON "FlowDelivery"("flowId");

-- AddForeignKey
ALTER TABLE "FlowDelivery" ADD CONSTRAINT "FlowDelivery_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "Flow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Preserva o canal já configurado (se houver) migrando pra FlowDelivery,
-- antes de dropar a coluna antiga. id gerado com gen_random_uuid() (mesma
-- extensão já usada pelo Postgres 16 do projeto) já que não dá pra chamar
-- cuid() do lado do banco.
INSERT INTO "FlowDelivery" ("id", "flowId", "deliveryType", "deliveryTarget")
SELECT gen_random_uuid()::text, "flowId", 'FILE', "defaultDeliveryTarget"
FROM "WelcomeConfig"
WHERE "defaultDeliveryTarget" IS NOT NULL;

-- AlterTable: remove o campo antigo (substituído por FlowDelivery.deliveryTarget)
ALTER TABLE "WelcomeConfig" DROP COLUMN "defaultDeliveryTarget";

-- AlterTable: Plan.deliveryType vira opcional (nulo = usar o padrão do Flow)
ALTER TABLE "Plan" ALTER COLUMN "deliveryType" DROP NOT NULL;
