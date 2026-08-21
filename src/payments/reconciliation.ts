import type { OrderStatus } from "@prisma/client";
import { prisma } from "../db/client.js";
import { getTransactionStatus, normalizeChargeStatus } from "./syncpay.js";
import { applyNormalizedStatus, findOrderByChargeId } from "./orderStatus.js";
import { resolveSyncPayCredentialsForBot, type SyncPayCredentials } from "./syncpayCredentials.js";

/**
 * Checa o status de UM Order agora, fora do ciclo do polling (botão
 * "Verificar Status" da mensagem de PIX gerado — src/bot/flows.ts). Reusa a
 * mesma lógica de transição/entrega de `pollPendingOrders` — se o Order já
 * não está PENDING (webhook/polling já resolveu antes do clique), só
 * retorna o status atual sem chamar a SyncPay de novo. `null` = Order não
 * encontrado.
 */
export async function checkOrderStatusNow(orderId: string): Promise<OrderStatus | null> {
  const orderRow = await prisma.order.findUnique({
    where: { id: orderId },
    select: { syncpayChargeId: true, botId: true, status: true },
  });
  if (!orderRow) return null;
  if (orderRow.status !== "PENDING") return orderRow.status;

  const credentials = await resolveSyncPayCredentialsForBot(orderRow.botId);
  const rawStatus = await getTransactionStatus(orderRow.syncpayChargeId, credentials);
  const normalized = normalizeChargeStatus(rawStatus);
  if (normalized === "PENDING" || normalized === "UNKNOWN") return "PENDING";

  const order = await findOrderByChargeId(orderRow.syncpayChargeId);
  if (!order) return null;
  const updated = await applyNormalizedStatus(order, normalized);
  return updated?.status ?? order.status;
}

/**
 * Rede de segurança pro caso do postback da SyncPay não chegar (visto no
 * primeiro pagamento real testado em 2026-08-19 — nosso endpoint de webhook
 * funciona, testado via chamada direta, mas a SyncPay nunca chamou; ver
 * PROJECT_STATE.md). Varre os Orders ainda PENDING e consulta o status
 * direto na SyncPay. Reaproveita a mesma lógica de transição/entrega do
 * webhook (src/payments/orderStatus.ts) — se o webhook chegar primeiro, o
 * polling encontra o Order já PAID e não faz nada (idempotente).
 */
export async function pollPendingOrders(): Promise<void> {
  const pending = await prisma.order.findMany({
    where: { status: "PENDING" },
    select: { syncpayChargeId: true, botId: true },
  });

  // Cache de credenciais por bot dentro desta varredura — vários Orders
  // pendentes do mesmo bot não precisam resolver a credencial de novo.
  const credentialsByBot = new Map<string, SyncPayCredentials>();

  for (const { syncpayChargeId, botId } of pending) {
    try {
      let credentials = credentialsByBot.get(botId);
      if (!credentials) {
        credentials = await resolveSyncPayCredentialsForBot(botId);
        credentialsByBot.set(botId, credentials);
      }

      const rawStatus = await getTransactionStatus(syncpayChargeId, credentials);
      const normalized = normalizeChargeStatus(rawStatus);
      if (normalized === "PENDING" || normalized === "UNKNOWN") continue;

      const order = await findOrderByChargeId(syncpayChargeId);
      if (!order) continue;

      await applyNormalizedStatus(order, normalized);
    } catch (err) {
      console.error(`[reconciliation] falha ao consultar status de ${syncpayChargeId}`, err);
    }
  }
}

let pollInFlight = false;

/** Evita rodar duas varreduras sobrepostas se uma demorar mais que o intervalo. */
export function startReconciliationPolling(intervalMs: number): NodeJS.Timeout {
  return setInterval(() => {
    if (pollInFlight) return;
    pollInFlight = true;
    pollPendingOrders()
      .catch((err) => console.error("[reconciliation] falha na varredura", err))
      .finally(() => {
        pollInFlight = false;
      });
  }, intervalMs);
}
