import type { Order } from "@prisma/client";
import { prisma } from "../db/client.js";
import { createCharge } from "./syncpay.js";

export interface CreatedCharge {
  order: Order;
  pixCopyPaste: string;
  qrCodeUrl: string;
}

/**
 * Contrato consumido pelo módulo do bot (src/bot/*) quando um botão
 * BUY_PRODUCT é clicado. Cria a cobrança na SyncPay e o Order (status PENDING)
 * correspondente.
 */
export async function createOrderAndCharge(params: {
  leadId: string;
  productId: string;
  originId?: string | null;
}): Promise<CreatedCharge> {
  const [lead, product] = await Promise.all([
    prisma.lead.findUnique({ where: { id: params.leadId } }),
    prisma.product.findUnique({ where: { id: params.productId } }),
  ]);

  if (!lead) {
    throw new Error(`createOrderAndCharge: lead ${params.leadId} não encontrado.`);
  }
  if (!product) {
    throw new Error(`createOrderAndCharge: produto ${params.productId} não encontrado.`);
  }
  if (!product.active) {
    throw new Error(
      `createOrderAndCharge: produto ${product.id} (${product.name}) está inativo.`
    );
  }

  // Chama a SyncPay ANTES de criar o Order. O schema exige `syncpayChargeId`
  // não-nulo e único no Order (prisma/schema.prisma), então não dá pra criar
  // o registro sem o id da cobrança em mãos. O trade-off: se o processo cair
  // entre a resposta da SyncPay e o INSERT do Order, fica uma cobrança "órfã"
  // na gateway sem Order local — o pagamento não se perde (o dinheiro cai na
  // conta normalmente), só não fica automaticamente associado a um Lead/Product
  // até reconciliação manual pelo extrato da SyncPay. A alternativa (criar o
  // Order antes, com um placeholder) trocaria esse risco raro por lixo
  // garantido no banco toda vez que a chamada à SyncPay falhar — pior no caso
  // comum (erro de validação, gateway fora do ar) para evitar um caso raro
  // (crash no meio do processo).
  const charge = await createCharge({
    amountCents: product.priceCents,
    description: product.name,
    customer: {
      name: lead.firstName ?? lead.username ?? `lead-${lead.telegramId}`,
      // Telegram não expõe e-mail do usuário. SyncPay exige customer.email no
      // payload — usamos um placeholder determinístico até confirmar com
      // credenciais reais se a gateway aceita/exige e-mail real (ver relatório).
      email: `lead-${lead.telegramId}@dgbot.invalid`,
    },
    externalRef: lead.id,
  });

  const order = await prisma.order.create({
    data: {
      leadId: lead.id,
      productId: product.id,
      originId: params.originId ?? null,
      syncpayChargeId: charge.externalId,
      amountCents: product.priceCents,
      status: "PENDING",
      pixCopyPaste: charge.pixCopyPaste,
      qrCodeUrl: charge.qrCodeUrl,
      expiresAt: charge.expiresAt,
    },
  });

  return {
    order,
    pixCopyPaste: charge.pixCopyPaste,
    qrCodeUrl: charge.qrCodeUrl,
  };
}
