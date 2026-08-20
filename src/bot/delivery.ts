import type { Order, OrderItem, OrderItemKind, Plan, FlowDelivery, DeliveryType, Lead } from "@prisma/client";
import { getTelegraf } from "./botManager.js";
import { prisma } from "../db/client.js";
import { formatBRL, formatConversionDuration } from "./format.js";
import { prepareRichText, registerCountdownIfNeeded } from "./richSend.js";
import { config } from "../config.js";

/** Só os campos que `deliverPlanToLead` de fato usa — deixa explícito que
 * pode vir tanto de um `Plan` com entrega própria quanto do `FlowDelivery`
 * do funil (quando `Plan.deliveryType` é nulo, "usar padrão"). */
export interface DeliveryPlanLike {
  id: string;
  deliveryType: DeliveryType;
  fileTelegramId: string | null;
  externalLink: string | null;
  subscriptionChannelId: string | null;
  /// DeliveryType.MESSAGE — corpo mandado literal (Fase 2, Milestone 8).
  messageContent: string | null;
  protectContent: boolean;
}

export interface ResolvedDelivery {
  plan: DeliveryPlanLike;
  deliveryTarget: string | null;
}

/**
 * Resolve o que efetivamente entregar: se o Plano tem `deliveryType`
 * próprio, usa os campos dele (com `customDeliveryTarget` sobrepondo o
 * padrão do funil, se houver). Se `deliveryType` é nulo ("usar padrão"),
 * herda tipo/arquivo/link inteiros do `FlowDelivery` do funil — `null` se
 * o funil também não tiver Entrega Padrão configurada (nada a entregar).
 */
export function resolveEffectiveDelivery(
  plan: Pick<Plan, "id" | "deliveryType" | "fileTelegramId" | "externalLink" | "subscriptionChannelId" | "messageContent" | "customDeliveryTarget" | "protectContent">,
  flowDelivery: FlowDelivery | null
): ResolvedDelivery | null {
  if (plan.deliveryType) {
    return {
      plan: {
        id: plan.id,
        deliveryType: plan.deliveryType,
        fileTelegramId: plan.fileTelegramId,
        externalLink: plan.externalLink,
        subscriptionChannelId: plan.subscriptionChannelId,
        messageContent: plan.messageContent,
        protectContent: plan.protectContent,
      },
      deliveryTarget: plan.customDeliveryTarget ?? flowDelivery?.deliveryTarget ?? null,
    };
  }
  if (!flowDelivery) return null;
  return {
    plan: {
      id: plan.id,
      deliveryType: flowDelivery.deliveryType,
      fileTelegramId: flowDelivery.fileTelegramId,
      externalLink: flowDelivery.externalLink,
      subscriptionChannelId: flowDelivery.subscriptionChannelId,
      messageContent: null,
      protectContent: plan.protectContent,
    },
    deliveryTarget: flowDelivery.deliveryTarget,
  };
}

/**
 * `fileTelegramId` guarda o `message_id` (como string) da mensagem já
 * postada no canal-cofre — não um `file_id`. A entrega usa
 * `telegram.copyMessage(destino, canalCofre, message_id)`, que exige um
 * `message_id` dentro do canal de origem; não existe uma chamada da Bot API
 * que copie/reenvie uma mensagem a partir de um `file_id` isolado preservando
 * legenda/mídia originais.
 */
export async function deliverPlanToLead(params: {
  botId: string;
  leadTelegramId: bigint;
  plan: DeliveryPlanLike;
  /** Canal/grupo-cofre de onde copiar a mensagem — resolvido pelo chamador
   * via `resolveEffectiveDelivery`. */
  deliveryTarget: string;
}): Promise<void> {
  const { botId, leadTelegramId, plan, deliveryTarget } = params;
  const telegraf = getTelegraf(botId);
  if (!telegraf) {
    throw new Error(`deliverPlanToLead: bot ${botId} não está registrado/ativo`);
  }
  const chatId = Number(leadTelegramId);

  if (plan.deliveryType === "LINK") {
    if (!plan.externalLink) {
      throw new Error(`Plano ${plan.id} é do tipo LINK mas não tem externalLink configurado`);
    }
    await telegraf.telegram.sendMessage(chatId, `Aqui está seu acesso:\n${plan.externalLink}`);
    return;
  }

  if (plan.deliveryType === "MESSAGE") {
    if (!plan.messageContent) {
      throw new Error(`Plano ${plan.id} é do tipo MESSAGE mas não tem messageContent configurado`);
    }
    await telegraf.telegram.sendMessage(chatId, plan.messageContent);
    return;
  }

  if (plan.deliveryType === "CHANNEL") {
    if (!plan.subscriptionChannelId) {
      throw new Error(`Plano ${plan.id} é do tipo CHANNEL mas não tem subscriptionChannelId configurado`);
    }
    const channelId = Number(plan.subscriptionChannelId);
    if (!Number.isFinite(channelId)) {
      throw new Error(`subscriptionChannelId inválido pro plano ${plan.id}: "${plan.subscriptionChannelId}"`);
    }
    // Convite de uso único, expira em 1h — evita que o link vaze e seja
    // reaproveitado por quem não pagou (member_limit garante 1 entrada só).
    const invite = await telegraf.telegram.createChatInviteLink(channelId, {
      member_limit: 1,
      expire_date: Math.floor(Date.now() / 1000) + 3600,
    });
    await telegraf.telegram.sendMessage(chatId, `Aqui está seu acesso:\n${invite.invite_link}`);
    return;
  }

  if (!plan.fileTelegramId) {
    throw new Error(`Plano ${plan.id} é do tipo FILE mas não tem fileTelegramId (message_id) configurado`);
  }
  const messageId = Number(plan.fileTelegramId);
  if (!Number.isFinite(messageId)) {
    throw new Error(
      `fileTelegramId inválido para o plano ${plan.id}: "${plan.fileTelegramId}" (esperado um message_id numérico)`
    );
  }
  const vaultChatId = Number(deliveryTarget);
  if (!Number.isFinite(vaultChatId)) {
    throw new Error(`deliveryTarget inválido pro plano ${plan.id}: "${deliveryTarget}"`);
  }

  await telegraf.telegram.copyMessage(chatId, vaultChatId, messageId, {
    protect_content: plan.protectContent,
  });
}

const ITEM_KIND_LABELS: Record<OrderItemKind, string> = {
  BASE: "Plano Base",
  ORDER_BUMP: "Order Bump",
  UPSELL: "Upsell",
  DOWNSELL: "Downsell",
};

/**
 * Envia o alerta de venda aprovada — um por OrderItem (Order Bump/Upsell
 * viram "vendas" próprias, cada uma com sua Categoria). Vai pro canal
 * configurado em Settings.salesChannelId (painel /admin/settings); se não
 * configurado ainda, cai no DM antigo pro TELEGRAM_ADMIN_USER_ID.
 * `order.originId` é resolvido aqui (via Prisma) porque o contrato de
 * `notifyAdminOfSale` não inclui a Origin diretamente.
 */
export async function notifyAdminOfSale(params: {
  botId: string;
  order: Order;
  item: OrderItem;
  plan: Plan;
  lead: Lead;
}): Promise<void> {
  const { botId, order, item, plan, lead } = params;
  const telegraf = getTelegraf(botId);
  if (!telegraf) {
    throw new Error(`notifyAdminOfSale: bot ${botId} não está registrado/ativo`);
  }

  const [botRow, settings, origin] = await Promise.all([
    prisma.bot.findUniqueOrThrow({ where: { id: botId } }),
    prisma.settings.findUnique({ where: { id: "singleton" } }),
    order.originId ? prisma.origin.findUnique({ where: { id: order.originId } }) : Promise.resolve(null),
  ]);

  const target: number | string = settings?.salesChannelId ?? config.TELEGRAM_ADMIN_USER_ID;
  const displayName = [lead.firstName, lead.lastName].filter(Boolean).join(" ") || "—";
  // Do momento em que ESTE PIX foi gerado até ser pago — não de
  // lead.createdAt (primeiro contato do lead, pode ser de dias/horas atrás
  // pra um cliente recorrente, o que gerava um "Tempo Conversão" absurdo).
  const conversionTime = order.paidAt
    ? formatConversionDuration(order.createdAt, order.paidAt)
    : "—";

  const lines = [
    "🎉 Pagamento Aprovado!",
    `🤖 Bot: @${botRow.telegramUsername ?? "—"}`,
    `⚙️ ID Bot: ${botRow.id}`,
    `🆔 ID Cliente: ${lead.telegramId.toString()}`,
    `🔗 Username: ${lead.username ? `@${lead.username}` : "—"}`,
    `👤 Nome de Perfil: ${displayName}`,
    `🌐 Idioma: ${lead.languageCode ?? "—"}`,
    `⭐️ Telegram Premium: ${lead.isPremium ? "Sim" : "Não"}`,
    `📦 Categoria: ${ITEM_KIND_LABELS[item.kind]}`,
    `🎁 Plano: ${plan.name}`,
    `📅 Duração: ${plan.durationDays ? `${plan.durationDays} dias` : "Avulso"}`,
    `💰 Valor: ${formatBRL(item.unitPriceCents)}`,
    `⏳ Tempo Conversão: ${conversionTime}`,
    `🔖 Código de Venda: ${origin?.param ?? "start"}`,
    `🔑 ID Transação Interna: ${order.id}`,
    `🏷️ ID Transação Gateway: ${order.syncpayChargeId}`,
    `💱 Tipo Moeda: BRL`,
    `💳 Método Pagamento: pix`,
    `🏦 Plataforma Pagamento: syncpay`,
  ];

  await telegraf.telegram.sendMessage(target, lines.join("\n"));
}

/**
 * Envia a mensagem de "pagamento aprovado" pro comprador (PaymentMessages.
 * pixApprovedMessage do funil), se configurada — senão não manda nada extra
 * (a entrega em si, via `deliverPlanToLead`, já é a confirmação visível).
 */
export async function notifyLeadOfApproval(params: {
  botId: string;
  leadTelegramId: bigint;
  lead: Lead;
  plan: Plan;
  order: Order;
  pixApprovedMessage: string | null | undefined;
}): Promise<void> {
  const { botId, leadTelegramId, lead, plan, order, pixApprovedMessage } = params;
  if (!pixApprovedMessage) return;

  const telegraf = getTelegraf(botId);
  if (!telegraf) {
    throw new Error(`notifyLeadOfApproval: bot ${botId} não está registrado/ativo`);
  }
  const botRow = await prisma.bot.findUniqueOrThrow({ where: { id: botId } });
  const prepared = prepareRichText(pixApprovedMessage, {
    lead,
    bot: botRow,
    extra: { valor: formatBRL(order.amountCents), plano: plan.name },
  });

  const chatId = Number(leadTelegramId);
  const sent = await telegraf.telegram.sendMessage(chatId, prepared.text, {
    parse_mode: "HTML",
    message_effect_id: prepared.effectId,
  } as never);
  await registerCountdownIfNeeded(prepared, { botId, chatId, messageId: sent.message_id });
}
