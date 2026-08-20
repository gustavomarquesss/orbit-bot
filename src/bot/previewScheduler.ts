import { Markup } from "telegraf";
import { prisma } from "../db/client.js";
import { getTelegraf } from "./botManager.js";

const PLANS_BUTTON_CALLBACK = "cta";
const DEFAULT_EXPIRED_MESSAGE = "As prévias expiraram... o conteúdo completo te espera!";

/**
 * Varre `ScheduledPreviewCleanup` vencidos: apaga cada mensagem de prévia
 * (uma por uma, sem abortar se alguma já tiver sido apagada manualmente
 * pelo usuário — mesma lógica de idempotência dos outros schedulers) e
 * manda a mensagem de conversão no lugar, com botão "Ver Planos" opcional
 * reaproveitando o callback `cta` já existente (bot.action(CTA_CALLBACK)
 * em src/bot/flows.ts não checa se o CTA está ligado, só lista os planos —
 * funciona igual aqui).
 */
export async function processPreviewCleanups(): Promise<void> {
  const due = await prisma.scheduledPreviewCleanup.findMany({
    where: { finishedAt: null, deleteAt: { lte: new Date() } },
    take: 50,
  });

  for (const row of due) {
    try {
      const telegraf = getTelegraf(row.botId);
      if (!telegraf) {
        await prisma.scheduledPreviewCleanup.update({ where: { id: row.id }, data: { finishedAt: new Date() } });
        continue;
      }

      const chatId = Number(row.chatId);
      for (const messageId of row.messageIds) {
        try {
          await telegraf.telegram.deleteMessage(chatId, messageId);
        } catch (err) {
          // Mensagem já apagada pelo usuário, chat bloqueado etc — segue
          // pras próximas em vez de abortar o lote inteiro.
          console.error(`[preview-scheduler] falha ao apagar mensagem ${messageId} (cleanup ${row.id})`, err);
        }
      }

      const keyboard = row.expiredShowPlansButton
        ? Markup.inlineKeyboard([[Markup.button.callback("💎 Ver Planos", PLANS_BUTTON_CALLBACK)]])
        : undefined;
      await telegraf.telegram.sendMessage(chatId, row.expiredMessage || DEFAULT_EXPIRED_MESSAGE, {
        reply_markup: keyboard?.reply_markup,
      });

      await prisma.scheduledPreviewCleanup.update({ where: { id: row.id }, data: { finishedAt: new Date() } });
    } catch (err) {
      console.error(`[preview-scheduler] falha ao processar ${row.id}`, err);
      await prisma.scheduledPreviewCleanup.update({ where: { id: row.id }, data: { finishedAt: new Date() } });
    }
  }
}

let pollInFlight = false;

export function startPreviewScheduler(intervalMs: number): NodeJS.Timeout {
  return setInterval(() => {
    if (pollInFlight) return;
    pollInFlight = true;
    processPreviewCleanups()
      .catch((err) => console.error("[preview-scheduler] falha na varredura", err))
      .finally(() => {
        pollInFlight = false;
      });
  }, intervalMs);
}
