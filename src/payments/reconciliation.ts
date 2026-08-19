import { prisma } from "../db/client.js";
import { getTransactionStatus, normalizeChargeStatus } from "./syncpay.js";
import { applyNormalizedStatus, findOrderByChargeId } from "./orderStatus.js";

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
    select: { syncpayChargeId: true },
  });

  for (const { syncpayChargeId } of pending) {
    try {
      const rawStatus = await getTransactionStatus(syncpayChargeId);
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
