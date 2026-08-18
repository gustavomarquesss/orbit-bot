import type { Order } from "@prisma/client";

export interface CreatedCharge {
  order: Order;
  pixCopyPaste: string;
  qrCodeUrl: string;
}

/**
 * Contrato consumido pelo módulo do bot (src/bot/*) quando um botão
 * BUY_PRODUCT é clicado. Implementação real: feature/pagamento-pix.
 * Cria o Order (status PENDING) e gera a cobrança PIX na SyncPay.
 */
export async function createOrderAndCharge(_params: {
  leadId: string;
  productId: string;
  originId?: string | null;
}): Promise<CreatedCharge> {
  throw new Error(
    "createOrderAndCharge: implementação pendente (feature/pagamento-pix) — ver PROJECT_STATE.md"
  );
}
