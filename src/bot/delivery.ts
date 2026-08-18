import type { Order, Product, Lead } from "@prisma/client";

/**
 * Contrato consumido pelo webhook da SyncPay (src/payments/webhook.ts)
 * quando um Order muda para PAID. Implementação real: feature/telegram-bot-core.
 * Reenvia o conteúdo do canal-cofre (copyMessage + protect_content) pro Lead.
 */
export async function deliverProductToLead(_params: {
  leadTelegramId: bigint;
  product: Product;
}): Promise<void> {
  throw new Error(
    "deliverProductToLead: implementação pendente (feature/telegram-bot-core) — ver PROJECT_STATE.md"
  );
}

/**
 * Envia alerta de venda aprovada pro TELEGRAM_ADMIN_USER_ID.
 * Implementação real: feature/telegram-bot-core.
 */
export async function notifyAdminOfSale(_params: {
  order: Order;
  product: Product;
  lead: Lead;
}): Promise<void> {
  throw new Error(
    "notifyAdminOfSale: implementação pendente (feature/telegram-bot-core) — ver PROJECT_STATE.md"
  );
}
