import type { Order } from "@prisma/client";
import { prisma } from "../db/client.js";
import { createCharge } from "./syncpay.js";

export interface CreatedCharge {
  order: Order;
  pixCopyPaste: string;
  qrCodeUrl: string;
}

/**
 * Contrato consumido pelo módulo do bot (src/bot/*) quando um Plano é
 * clicado. Cria a cobrança na SyncPay e o Order (status PENDING) correspondente.
 */
export async function createOrderAndCharge(params: {
  botId: string;
  leadId: string;
  planId: string;
  originId?: string | null;
}): Promise<CreatedCharge> {
  const [lead, plan] = await Promise.all([
    prisma.lead.findUnique({ where: { id: params.leadId } }),
    prisma.plan.findUnique({ where: { id: params.planId } }),
  ]);

  if (!lead) {
    throw new Error(`createOrderAndCharge: lead ${params.leadId} não encontrado.`);
  }
  if (!plan) {
    throw new Error(`createOrderAndCharge: plano ${params.planId} não encontrado.`);
  }
  if (!plan.active) {
    throw new Error(`createOrderAndCharge: plano ${plan.id} (${plan.name}) está inativo.`);
  }

  // Chama a SyncPay ANTES de criar o Order. O schema exige `syncpayChargeId`
  // não-nulo e único no Order, então não dá pra criar o registro sem o id
  // da cobrança em mãos. O trade-off: se o processo cair entre a resposta
  // da SyncPay e o INSERT do Order, fica uma cobrança "órfã" na gateway sem
  // Order local — o pagamento não se perde (o dinheiro cai na conta
  // normalmente), só não fica automaticamente associado a um Lead/Plan até
  // reconciliação manual pelo extrato da SyncPay. A alternativa (criar o
  // Order antes, com um placeholder) trocaria esse risco raro por lixo
  // garantido no banco toda vez que a chamada à SyncPay falhar — pior no
  // caso comum (erro de validação, gateway fora do ar) para evitar um caso
  // raro (crash no meio do processo).
  // Confirmado com chamada real à SyncPay (ver PROJECT_STATE.md): a cobrança
  // não pede nenhum dado do comprador (nome/email/CPF) — só valor e descrição.
  const charge = await createCharge({
    amountCents: plan.priceCents,
    description: plan.name,
  });

  const order = await prisma.order.create({
    data: {
      leadId: lead.id,
      planId: plan.id,
      botId: params.botId,
      originId: params.originId ?? null,
      syncpayChargeId: charge.externalId,
      amountCents: plan.priceCents,
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
