-- Entrega Padrão (Fallback) do fluxo ganha suporte a "Canal" (assinatura),
-- igual ao Plan.subscriptionChannelId — pedido do usuário, 2026-08-20.
ALTER TABLE "FlowDelivery" ADD COLUMN "subscriptionChannelId" TEXT;
