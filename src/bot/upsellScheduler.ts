import { Markup } from "telegraf";
import type { InlineKeyboardButton } from "telegraf/types";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db/client.js";
import { getTelegraf } from "./botManager.js";
import { prepareRichText, registerCountdownIfNeeded, styledCallbackButton, styledUrlButton } from "./richSend.js";
import { PLAN_CALLBACK_PREFIX } from "./flows.js";

/**
 * Chamado depois de uma compra confirmada (src/payments/orderStatus.ts, uma
 * vez por Flow distinto entre os itens do Order — não por item, pra não
 * agendar a mesma sequência duas vezes se base+bump forem do mesmo funil).
 * Cria um `ScheduledUpsellSend` por mensagem da sequência ativa do funil,
 * com `sendAt` = agora + `delayMinutes` de cada mensagem — o envio de
 * verdade é feito pelo poller (`processScheduledUpsells`), não aqui.
 */
export async function scheduleUpsellSequence(botId: string, leadId: string, flowId: string): Promise<void> {
  const sequence = await prisma.upsellSequence.findUnique({
    where: { flowId },
    include: { messages: true },
  });
  if (!sequence || !sequence.active || sequence.messages.length === 0) return;

  const now = Date.now();
  await prisma.scheduledUpsellSend.createMany({
    data: sequence.messages.map((message) => ({
      messageId: message.id,
      leadId,
      botId,
      sendAt: new Date(now + message.delayMinutes * 60_000),
    })),
  });
}

const UPSELL_MESSAGE_INCLUDE = {
  buttons: { orderBy: { order: "asc" } },
} satisfies Prisma.UpsellMessageInclude;

function buildUpsellKeyboard(buttons: { text: string; type: "BUY_PLAN" | "OPEN_LINK"; targetPlanId: string | null; url: string | null }[]) {
  const rows: InlineKeyboardButton[][] = [];
  for (const button of buttons) {
    if (button.type === "OPEN_LINK" && button.url) {
      rows.push([styledUrlButton(button.text, button.url)]);
    } else if (button.type === "BUY_PLAN" && button.targetPlanId) {
      rows.push([styledCallbackButton(button.text, `${PLAN_CALLBACK_PREFIX}${button.targetPlanId}`)]);
    }
  }
  return rows.length > 0 ? Markup.inlineKeyboard(rows) : undefined;
}

/**
 * Varre `ScheduledUpsellSend` vencidos (sendAt <= agora, ainda não enviados)
 * e manda cada um. Mesmo padrão de `src/payments/reconciliation.ts`
 * (poller via setInterval, sem dependência nova).
 */
export async function processScheduledUpsells(): Promise<void> {
  const due = await prisma.scheduledUpsellSend.findMany({
    where: { sentAt: null, sendAt: { lte: new Date() } },
    include: {
      message: { include: UPSELL_MESSAGE_INCLUDE },
      lead: true,
    },
    take: 50,
  });

  for (const send of due) {
    try {
      const telegraf = getTelegraf(send.botId);
      if (telegraf) {
        const botRow = await prisma.bot.findUniqueOrThrow({ where: { id: send.botId } });
        const prepared = prepareRichText(send.message.text, { lead: send.lead, bot: botRow });
        const keyboard = buildUpsellKeyboard(send.message.buttons);
        const chatId = Number(send.lead.telegramId);
        const sent = await telegraf.telegram.sendMessage(chatId, prepared.text || "​", {
          parse_mode: "HTML",
          reply_markup: keyboard?.reply_markup,
          message_effect_id: prepared.effectId,
        } as never);
        await registerCountdownIfNeeded(prepared, { botId: send.botId, chatId, messageId: sent.message_id });
      }
    } catch (err) {
      console.error(`[upsell-scheduler] falha ao enviar ${send.id}`, err);
    }
    // Marca como enviado mesmo em falha — não fica reenviando pro sempre um
    // envio que já quebrou uma vez (mesma lógica de idempotência do resto
    // do projeto: falha vira log pra investigação manual, não retry infinito).
    await prisma.scheduledUpsellSend.update({ where: { id: send.id }, data: { sentAt: new Date() } });
  }
}

let pollInFlight = false;

export function startUpsellScheduler(intervalMs: number): NodeJS.Timeout {
  return setInterval(() => {
    if (pollInFlight) return;
    pollInFlight = true;
    processScheduledUpsells()
      .catch((err) => console.error("[upsell-scheduler] falha na varredura", err))
      .finally(() => {
        pollInFlight = false;
      });
  }, intervalMs);
}
