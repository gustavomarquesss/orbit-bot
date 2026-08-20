import type { OrderStatus, Prisma } from "@prisma/client";
import { prisma } from "../db/client.js";
import { deliverPlanToLead, notifyAdminOfSale, notifyLeadOfApproval, resolveEffectiveDelivery } from "../bot/delivery.js";
import { scheduleUpsellSequence } from "../bot/upsellScheduler.js";
import { cancelPendingDownsellsForLead } from "../bot/downsellScheduler.js";
import type { NormalizedChargeStatus } from "./syncpay.js";

export const ORDER_INCLUDE = {
  lead: true,
  items: {
    include: { plan: { include: { flow: { include: { welcomeConfig: true, paymentMessages: true, delivery: true } } } } },
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
    // Upsell é por Flow (dispara após QUALQUER compra do funil, não por
    // plano específico) — agenda uma vez por Flow distinto entre os itens,
    // não uma vez por item, senão base+bump do mesmo funil agendariam a
    // mesma sequência duas vezes.
    const scheduledFlowIds = new Set<string>();

    // O lead converteu — não faz mais sentido oferecer desconto de
    // recuperação (Downsell) de nenhum trigger pendente dele.
    try {
      await cancelPendingDownsellsForLead(order.leadId);
    } catch (err) {
      console.error("[order-status] falha ao cancelar downsells pendentes", err);
    }

    // Uma entrega/notificação por item — hoje todo Order tem exatamente 1
    // item (BASE), mas o shape já é o de vários itens (Order Bump, Fase 2
    // Milestone 4, cobra base + adicionais numa única cobrança).
    for (const item of order.items) {
      const plan = item.plan;

      // Planos com duração são assinatura — marca quando o acesso deste
      // item expira (base pro lembrete de renovação e pra revogação
      // automática, src/payments/subscriptionScheduler.ts). Planos sem
      // duração (pagamento único/vitalício) nunca expiram.
      if (plan.durationDays != null) {
        try {
          await prisma.orderItem.update({
            where: { id: item.id },
            data: { accessExpiresAt: new Date(updatedOrder.paidAt!.getTime() + plan.durationDays * 86_400_000) },
          });
        } catch (err) {
          console.error("[order-status] falha ao marcar accessExpiresAt do item", err);
        }
      }

      const resolved = resolveEffectiveDelivery(plan, plan.flow.delivery);
      if (!resolved) {
        console.error(
          `[order-status] plano ${plan.id} está configurado como "usar padrão do fluxo", mas o fluxo ${plan.flowId} não tem Entrega Padrão configurada`
        );
      } else if (!resolved.deliveryTarget && resolved.plan.deliveryType === "FILE") {
        console.error(
          `[order-status] plano ${plan.id} é do tipo FILE mas não tem canal de entrega configurado (nem custom nem padrão do funil)`
        );
      } else {
        try {
          await deliverPlanToLead({
            botId: order.botId,
            leadTelegramId: order.lead.telegramId,
            plan: resolved.plan,
            deliveryTarget: resolved.deliveryTarget ?? "",
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
      if (!scheduledFlowIds.has(plan.flowId)) {
        scheduledFlowIds.add(plan.flowId);
        try {
          await scheduleUpsellSequence(order.botId, order.leadId, plan.flowId);
        } catch (err) {
          console.error("[order-status] falha ao agendar sequência de upsell", err);
        }
      }
    }
  }

  return updatedOrder;
}
