import { Markup } from "telegraf";
import type { Telegraf } from "telegraf";
import type { InlineKeyboardButton } from "telegraf/types";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db/client.js";
import { getTelegraf } from "./botManager.js";
import { prepareRichText, registerCountdownIfNeeded, styledCallbackButton } from "./richSend.js";
import { formatBRL } from "./format.js";
import { applyDiscount, buildDownsellBuyCallbackData } from "./downsellMessage.js";

/**
 * Chamado no /start pra um lead recém-criado (src/bot/flows.ts). Agenda um
 * ScheduledDownsellSend por sequência GENERAL ativa — só roda uma vez na
 * vida do lead (não a cada /start), consistente com o gatilho real
 * ("após o /start pra leads que não geraram pagamento").
 */
export async function scheduleGeneralDownsell(botId: string, leadId: string, flowId: string): Promise<void> {
  const config = await prisma.downsellConfig.findUnique({
    where: { flowId },
    include: { sequences: { where: { trigger: "GENERAL", active: true } } },
  });
  if (!config || !config.active || config.sequences.length === 0) return;

  const now = Date.now();
  await prisma.scheduledDownsellSend.createMany({
    data: config.sequences.map((seq) => ({
      sequenceId: seq.id,
      leadId,
      botId,
      sendAt: new Date(now + seq.delayMinutes * 60_000),
    })),
  });
}

/**
 * Chamado quando um PIX é gerado (src/bot/flows.ts, handleBuyItems). Agenda
 * um ScheduledDownsellSend por sequência PIX_GENERATED ativa, vinculado a
 * este Order específico. Se existir pelo menos 1 sequência PIX_GENERATED
 * ativa, cancela de vez os envios GENERAL pendentes deste lead — "quando
 * ativo, substitui o downsell geral para esses leads" (confirmado com o
 * usuário: cancelamento definitivo, não pausa).
 */
export async function scheduleDownsellForOrder(
  botId: string,
  leadId: string,
  orderId: string,
  flowId: string
): Promise<void> {
  const config = await prisma.downsellConfig.findUnique({
    where: { flowId },
    include: { sequences: { where: { trigger: "PIX_GENERATED", active: true } } },
  });
  if (!config || !config.active || config.sequences.length === 0) return;

  const now = Date.now();
  await prisma.scheduledDownsellSend.createMany({
    data: config.sequences.map((seq) => ({
      sequenceId: seq.id,
      leadId,
      botId,
      orderId,
      sendAt: new Date(now + seq.delayMinutes * 60_000),
    })),
  });

  await prisma.scheduledDownsellSend.updateMany({
    where: { leadId, orderId: null, sentAt: null, canceledAt: null },
    data: { canceledAt: new Date() },
  });
}

/**
 * Chamado quando um Order é marcado PAID (src/payments/orderStatus.ts) —
 * o lead converteu, não faz mais sentido oferecer desconto de recuperação
 * de nenhum trigger (GENERAL ou PIX_GENERATED de qualquer outro Order
 * abandonado do mesmo lead).
 */
export async function cancelPendingDownsellsForLead(leadId: string): Promise<void> {
  await prisma.scheduledDownsellSend.updateMany({
    where: { leadId, sentAt: null, canceledAt: null },
    data: { canceledAt: new Date() },
  });
}

const DOWNSELL_SEND_INCLUDE = {
  sequence: {
    include: {
      config: true,
      media: { orderBy: { order: "asc" } },
      plans: { orderBy: { order: "asc" }, include: { plan: true } },
    },
  },
  lead: true,
  order: true,
} satisfies Prisma.ScheduledDownsellSendInclude;

type DueSend = Prisma.ScheduledDownsellSendGetPayload<{ include: typeof DOWNSELL_SEND_INCLUDE }>;

function buildDownsellKeyboard(seq: DueSend["sequence"]) {
  const rows: InlineKeyboardButton[][] = seq.plans.map((link) => {
    const discounted = applyDiscount(link.plan.priceCents, seq.discountType, seq.discountValue);
    return [
      styledCallbackButton(
        `${link.plan.name} — ${formatBRL(discounted)}`,
        buildDownsellBuyCallbackData(seq.id, link.planId)
      ),
    ];
  });
  return rows.length > 0 ? Markup.inlineKeyboard(rows) : undefined;
}

async function sendSequenceMedia(telegraf: Telegraf, chatId: number, media: DueSend["sequence"]["media"]): Promise<void> {
  if (media.length === 0) return;
  try {
    if (media.length === 1) {
      const m = media[0];
      switch (m.mediaType) {
        case "PHOTO":
          await telegraf.telegram.sendPhoto(chatId, m.fileId);
          break;
        case "VIDEO":
          await telegraf.telegram.sendVideo(chatId, m.fileId);
          break;
        case "AUDIO":
          await telegraf.telegram.sendAudio(chatId, m.fileId);
          break;
        case "DOCUMENT":
          await telegraf.telegram.sendDocument(chatId, m.fileId);
          break;
      }
    } else {
      await telegraf.telegram.sendMediaGroup(
        chatId,
        media.map((m) => ({ type: m.mediaType.toLowerCase() as "photo" | "video", media: m.fileId }))
      );
    }
  } catch (err) {
    console.error("[downsell-scheduler] falha ao enviar mídia, seguindo com o texto", err);
  }
}

/**
 * Varre ScheduledDownsellSend vencidos e manda cada um — mesmo padrão de
 * poller de src/bot/upsellScheduler.ts / src/payments/reconciliation.ts.
 * Reavalia a condição de disparo em cima da hora (não só confia no que foi
 * decidido no agendamento): PIX_GENERATED cancela sem enviar se o Order já
 * foi pago nesse meio tempo; GENERAL cancela sem enviar se o lead pagou
 * QUALQUER Order (rede de segurança além do cancelamento feito na hora do
 * pagamento em cancelPendingDownsellsForLead).
 */
export async function processScheduledDownsells(): Promise<void> {
  const due = await prisma.scheduledDownsellSend.findMany({
    where: { sentAt: null, canceledAt: null, sendAt: { lte: new Date() } },
    include: DOWNSELL_SEND_INCLUDE,
    take: 50,
  });

  for (const send of due) {
    if (send.order && send.order.status === "PAID") {
      await prisma.scheduledDownsellSend.update({ where: { id: send.id }, data: { canceledAt: new Date() } });
      continue;
    }
    if (!send.orderId) {
      const paidOrder = await prisma.order.findFirst({ where: { leadId: send.leadId, status: "PAID" } });
      if (paidOrder) {
        await prisma.scheduledDownsellSend.update({ where: { id: send.id }, data: { canceledAt: new Date() } });
        continue;
      }
    }

    try {
      const telegraf = getTelegraf(send.botId);
      if (telegraf && send.sequence.active && send.sequence.config.active) {
        const botRow = await prisma.bot.findUniqueOrThrow({ where: { id: send.botId } });
        const chatId = Number(send.lead.telegramId);
        const prepared = prepareRichText(send.sequence.message, { lead: send.lead, bot: botRow });
        const keyboard = buildDownsellKeyboard(send.sequence);
        await sendSequenceMedia(telegraf, chatId, send.sequence.media);
        const sent = await telegraf.telegram.sendMessage(chatId, prepared.text || "​", {
          parse_mode: "HTML",
          reply_markup: keyboard?.reply_markup,
          message_effect_id: prepared.effectId,
        } as never);
        await registerCountdownIfNeeded(prepared, { botId: send.botId, chatId, messageId: sent.message_id });
      }
    } catch (err) {
      console.error(`[downsell-scheduler] falha ao enviar ${send.id}`, err);
    }
    await prisma.scheduledDownsellSend.update({ where: { id: send.id }, data: { sentAt: new Date() } });
  }
}

let pollInFlight = false;

export function startDownsellScheduler(intervalMs: number): NodeJS.Timeout {
  return setInterval(() => {
    if (pollInFlight) return;
    pollInFlight = true;
    processScheduledDownsells()
      .catch((err) => console.error("[downsell-scheduler] falha na varredura", err))
      .finally(() => {
        pollInFlight = false;
      });
  }, intervalMs);
}
