import type { Order, OrderItemKind } from "@prisma/client";
import { prisma } from "../db/client.js";
import { createCharge } from "./syncpay.js";

export interface CreatedCharge {
  order: Order;
  pixCopyPaste: string;
  qrCodeUrl: string;
}

export interface OrderItemInput {
  planId: string;
  /** Default "BASE" — Order Bump/Upsell/Downsell (Fase 2) usam os outros kinds. */
  kind?: OrderItemKind;
  /** Downsell aplica desconto em cima do Plan.priceCents — quando presente, sobrescreve o preço do item (ver src/bot/downsellMessage.ts). */
  unitPriceCentsOverride?: number;
}

/**
 * Contrato consumido pelo módulo do bot (src/bot/*) quando um Plano é
 * clicado. Cria a cobrança na SyncPay e o Order (status PENDING) com um
 * OrderItem por item — hoje sempre 1 (o plano escolhido), mas o shape já
 * suporta N itens numa única cobrança (Order Bump, Fase 2 Milestone 4).
 */
export async function createOrderAndCharge(params: {
  botId: string;
  leadId: string;
  items: OrderItemInput[];
  originId?: string | null;
}): Promise<CreatedCharge> {
  if (params.items.length === 0) {
    throw new Error("createOrderAndCharge: precisa de pelo menos 1 item.");
  }

  const lead = await prisma.lead.findUnique({ where: { id: params.leadId } });
  if (!lead) {
    throw new Error(`createOrderAndCharge: lead ${params.leadId} não encontrado.`);
  }

  const plans = await prisma.plan.findMany({
    where: { id: { in: params.items.map((item) => item.planId) } },
  });
  const planById = new Map(plans.map((plan) => [plan.id, plan]));
  for (const item of params.items) {
    const plan = planById.get(item.planId);
    if (!plan) {
      throw new Error(`createOrderAndCharge: plano ${item.planId} não encontrado.`);
    }
    if (!plan.active) {
      throw new Error(`createOrderAndCharge: plano ${plan.id} (${plan.name}) está inativo.`);
    }
  }

  const totalCents = params.items.reduce(
    (sum, item) => sum + (item.unitPriceCentsOverride ?? planById.get(item.planId)!.priceCents),
    0
  );
  const description = params.items.map((item) => planById.get(item.planId)!.name).join(" + ");

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
    amountCents: totalCents,
    description,
  });

  const order = await prisma.order.create({
    data: {
      leadId: lead.id,
      botId: params.botId,
      originId: params.originId ?? null,
      syncpayChargeId: charge.externalId,
      amountCents: totalCents,
      status: "PENDING",
      pixCopyPaste: charge.pixCopyPaste,
      qrCodeUrl: charge.qrCodeUrl,
      expiresAt: charge.expiresAt,
      items: {
        create: params.items.map((item) => ({
          planId: item.planId,
          kind: item.kind ?? "BASE",
          unitPriceCents: item.unitPriceCentsOverride ?? planById.get(item.planId)!.priceCents,
        })),
      },
    },
  });

  return {
    order,
    pixCopyPaste: charge.pixCopyPaste,
    qrCodeUrl: charge.qrCodeUrl,
  };
}
