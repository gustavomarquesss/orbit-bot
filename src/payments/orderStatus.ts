import type { OrderStatus, Prisma } from "@prisma/client";
import { prisma } from "../db/client.js";
import { deliverPlanToLead, notifyAdminOfSale, notifyLeadOfApproval, offerUpsellIfAny } from "../bot/delivery.js";
import type { NormalizedChargeStatus } from "./syncpay.js";

export const ORDER_INCLUDE = {
  lead: true,
  items: {
    include: { plan: { include: { flow: { include: { welcomeConfig: true, paymentMessages: true } } } } },
  },
} satisfies Prisma.OrderInclude;

export type OrderWithRelations = Prisma.OrderGetPayload<{ include: typeof ORDER_INCLUDE }>;

export function findOrderByChargeId(syncpayChargeId: string) {
  return prisma.order.findUnique({ where: { syncpayChargeId }, include: ORDER_INCLUDE });
}

/**
 * Aplica uma mudança de status normalizada a um Order, disparando entrega e
 * notificações na transição PENDING -> PAID. Compartilhado entre o webhook
 * (src/payments/webhook.ts) e o polling de reconciliação
 * (src/payments/reconciliation.ts) — o pagamento pode ser confirmado por
 * qualquer um dos dois canais, e a lógica de entrega/idempotência precisa
 * ser a mesma nos dois casos. Idempotente: não faz nada se o status
 * normalizado não muda nada em relação ao que já está salvo.
 */
export async function applyNormalizedStatus(
  order: OrderWithRelations,
  normalizedStatus: NormalizedChargeStatus,
  opts?: { webhookEventId?: string }
): Promise<OrderWithRelations | null> {
  const wasAlreadyPaid = order.status === "PAID";

  let nextStatus: OrderStatus = order.status;
  if (normalizedStatus === "PAID") nextStatus = "PAID";
  else if (normalizedStatus === "REFUSED") nextStatus = "REFUSED";
  else if (normalizedStatus === "EXPIRED") nextStatus = "EXPIRED";
  // "PENDING" ou "UNKNOWN": mantém o status atual — não regredimos um Order
  // de PAID/REFUSED/EXPIRED de volta pra PENDING por uma leitura ambígua.

  if (nextStatus === order.status && !opts?.webhookEventId) {
    return null;
  }

  const updatedOrder = await prisma.order.update({
    where: { id: order.id },
    data: {
      status: nextStatus,
      paidAt: nextStatus === "PAID" && !order.paidAt ? new Date() : order.paidAt,
      ...(opts?.webhookEventId ? { webhookEvents: { connect: { id: opts.webhookEventId } } } : {}),
    },
    include: ORDER_INCLUDE,
  });

  if (nextStatus === "PAID" && !wasAlreadyPaid) {
    // Uma entrega/notificação por item — hoje todo Order tem exatamente 1
    // item (BASE), mas o shape já é o de vários itens (Order Bump, Fase 2
    // Milestone 4, cobra base + adicionais numa única cobrança).
    for (const item of order.items) {
      const plan = item.plan;
      const deliveryTarget = plan.customDeliveryTarget ?? plan.flow.welcomeConfig?.defaultDeliveryTarget;
      if (!deliveryTarget && plan.deliveryType === "FILE") {
        console.error(
          `[order-status] plano ${plan.id} é do tipo FILE mas não tem canal de entrega configurado (nem custom nem padrão do funil)`
        );
      } else {
        try {
          await deliverPlanToLead({
            botId: order.botId,
            leadTelegramId: order.lead.telegramId,
            plan,
            deliveryTarget: deliveryTarget ?? "",
          });
        } catch (err) {
          console.error("[order-status] falha ao entregar plano", err);
        }
      }
      try {
        await notifyAdminOfSale({
          botId: order.botId,
          order: updatedOrder,
          item,
          plan,
          lead: order.lead,
        });
      } catch (err) {
        console.error("[order-status] falha ao notificar admin", err);
      }
      try {
        await notifyLeadOfApproval({
          botId: order.botId,
          leadTelegramId: order.lead.telegramId,
          lead: order.lead,
          plan,
          order: updatedOrder,
          pixApprovedMessage: plan.flow.paymentMessages?.pixApprovedMessage,
        });
      } catch (err) {
        console.error("[order-status] falha ao notificar comprador da aprovação", err);
      }
      try {
        await offerUpsellIfAny(order.botId, order.lead.telegramId, plan.id);
      } catch (err) {
        console.error("[order-status] falha ao oferecer upsell", err);
      }
    }
  }

  return updatedOrder;
}
