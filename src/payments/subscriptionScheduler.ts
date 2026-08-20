import { Markup } from "telegraf";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db/client.js";
import { getTelegraf } from "../bot/botManager.js";
import { prepareRichText, registerCountdownIfNeeded, styledCallbackButton } from "../bot/richSend.js";
import { formatBRL } from "../bot/format.js";
import { PLAN_CALLBACK_PREFIX } from "../bot/flows.js";

// A quanto tempo do vencimento mandar o lembrete de renovação.
const REMINDER_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;

const ITEM_INCLUDE = {
  order: { include: { lead: true } },
  plan: { include: { flow: { include: { paymentMessages: true } } } },
} satisfies Prisma.OrderItemInclude;

/**
 * Manda o lembrete de renovação (botão gera um PIX novo pro mesmo plano,
 * reaproveitando o callback `plan:<id>` já existente — mesma compra normal,
 * inclusive engatilha Order Bump se o plano tiver) pra todo OrderItem de
 * assinatura a até REMINDER_WINDOW_MS do vencimento, ainda sem lembrete
 * mandado. Chamado pelo poller (startSubscriptionScheduler).
 */
export async function sendRenewalReminders(): Promise<void> {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + REMINDER_WINDOW_MS);

  const dueItems = await prisma.orderItem.findMany({
    where: {
      accessExpiresAt: { not: null, lte: windowEnd, gt: now },
      renewalReminderSentAt: null,
      revokedAt: null,
    },
    include: ITEM_INCLUDE,
  });

  for (const item of dueItems) {
    try {
      const telegraf = getTelegraf(item.order.botId);
      if (telegraf) {
        const botRow = await prisma.bot.findUniqueOrThrow({ where: { id: item.order.botId } });
        const template = item.plan.flow.paymentMessages?.renewalMessage;
        const prepared = template
          ? prepareRichText(template, {
              lead: item.order.lead,
              bot: botRow,
              extra: { valor: formatBRL(item.plan.priceCents), plano: item.plan.name },
            })
          : { text: `Seu acesso a "${item.plan.name}" está prestes a expirar. Renove agora para não perder o acesso!` };
        const keyboard = Markup.inlineKeyboard([
          [styledCallbackButton("Renovar agora", `${PLAN_CALLBACK_PREFIX}${item.planId}`)],
        ]);
        const chatId = Number(item.order.lead.telegramId);
        const sent = await telegraf.telegram.sendMessage(chatId, prepared.text, {
          parse_mode: "HTML",
          reply_markup: keyboard.reply_markup,
          message_effect_id: prepared.effectId,
        } as never);
        await registerCountdownIfNeeded(prepared, { botId: item.order.botId, chatId, messageId: sent.message_id });
      }
    } catch (err) {
      console.error(`[subscription-scheduler] falha ao mandar lembrete de renovação (item ${item.id})`, err);
    }
    await prisma.orderItem.update({ where: { id: item.id }, data: { renewalReminderSentAt: new Date() } });
  }
}

/**
 * Revoga o acesso de todo OrderItem de assinatura já vencido e ainda não
 * revogado. Só faz alguma ação de verdade no Telegram pra planos
 * DeliveryType.CHANNEL (kick via ban+unban imediato do canal/grupo VIP,
 * sem banimento permanente — o assinante pode voltar com um convite novo se
 * renovar depois). Planos FILE/LINK não têm nada pra "tirar de volta" (o
 * arquivo/link já foi entregue) — `revokedAt` só marca o controle interno
 * (deixa de contar como assinante ativo no admin).
 */
export async function revokeExpiredAccess(): Promise<void> {
  const now = new Date();
  const expiredItems = await prisma.orderItem.findMany({
    where: { accessExpiresAt: { not: null, lte: now }, revokedAt: null },
    include: ITEM_INCLUDE,
  });

  for (const item of expiredItems) {
    try {
      if (item.plan.deliveryType === "CHANNEL" && item.plan.subscriptionChannelId) {
        const telegraf = getTelegraf(item.order.botId);
        const channelId = Number(item.plan.subscriptionChannelId);
        if (telegraf && Number.isFinite(channelId)) {
          const userId = Number(item.order.lead.telegramId);
          await telegraf.telegram.banChatMember(channelId, userId);
          await telegraf.telegram.unbanChatMember(channelId, userId, { only_if_banned: true });
        }
      }
    } catch (err) {
      console.error(`[subscription-scheduler] falha ao revogar acesso (item ${item.id})`, err);
    }
    await prisma.orderItem.update({ where: { id: item.id }, data: { revokedAt: new Date() } });
  }
}

let pollInFlight = false;

export function startSubscriptionScheduler(intervalMs: number): NodeJS.Timeout {
  return setInterval(() => {
    if (pollInFlight) return;
    pollInFlight = true;
    Promise.all([sendRenewalReminders(), revokeExpiredAccess()])
      .catch((err) => console.error("[subscription-scheduler] falha na varredura", err))
      .finally(() => {
        pollInFlight = false;
      });
  }, intervalMs);
}
