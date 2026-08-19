import type { Order, Plan, Lead } from "@prisma/client";
import { getTelegraf } from "./botManager.js";
import { prisma } from "../db/client.js";
import { formatBRL } from "./format.js";
import { renderTemplate } from "./templating.js";
import { config } from "../config.js";

/**
 * `Plan.fileTelegramId` guarda o `message_id` (como string) da mensagem já
 * postada no canal-cofre — não um `file_id`. A entrega usa
 * `telegram.copyMessage(destino, canalCofre, message_id)`, que exige um
 * `message_id` dentro do canal de origem; não existe uma chamada da Bot API
 * que copie/reenvie uma mensagem a partir de um `file_id` isolado preservando
 * legenda/mídia originais.
 */
export async function deliverPlanToLead(params: {
  botId: string;
  leadTelegramId: bigint;
  plan: Plan;
  /** Canal/grupo-cofre de onde copiar a mensagem — resolvido pelo chamador
   * a partir de `Plan.customDeliveryTarget` ou `WelcomeConfig.defaultDeliveryTarget`. */
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

/**
 * Envia alerta de venda aprovada pro TELEGRAM_ADMIN_USER_ID. `order.originId`
 * é resolvido aqui (via Prisma) porque o contrato de `notifyAdminOfSale` não
 * inclui a Origin diretamente — mantém a assinatura estável para quem chama.
 */
export async function notifyAdminOfSale(params: {
  botId: string;
  order: Order;
  plan: Plan;
  lead: Lead;
}): Promise<void> {
  const { botId, order, plan, lead } = params;
  const telegraf = getTelegraf(botId);
  if (!telegraf) {
    throw new Error(`notifyAdminOfSale: bot ${botId} não está registrado/ativo`);
  }

  const leadLabel = lead.username
    ? `@${lead.username}`
    : [lead.firstName, lead.lastName].filter(Boolean).join(" ") || lead.telegramId.toString();

  const origin = order.originId
    ? await prisma.origin.findUnique({ where: { id: order.originId } })
    : null;

  const lines = [
    "Nova venda aprovada!",
    `Plano: ${plan.name}`,
    `Valor: ${formatBRL(order.amountCents)}`,
    `Cliente: ${leadLabel} (id ${lead.telegramId.toString()})`,
  ];
  if (origin) {
    lines.push(`Origem: ${origin.label} (${origin.param})`);
  }

  await telegraf.telegram.sendMessage(config.TELEGRAM_ADMIN_USER_ID, lines.join("\n"));
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
  const text = renderTemplate(pixApprovedMessage, {
    lead,
    bot: botRow,
    extra: { valor: formatBRL(order.amountCents), plano: plan.name },
  });

  await telegraf.telegram.sendMessage(Number(leadTelegramId), text, { parse_mode: "HTML" });
}
