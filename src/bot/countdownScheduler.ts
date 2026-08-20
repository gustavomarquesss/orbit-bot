import type { Telegraf } from "telegraf";
import type { ScheduledCountdownEdit } from "@prisma/client";
import { prisma } from "../db/client.js";
import { getTelegraf } from "./botManager.js";
import { COUNTDOWN_MARKER, formatCountdownValue, type CountdownDirective } from "./templating.js";

/** `editMessageText` falha (Bad Request) numa mensagem cujo conteúdo é uma
 * legenda de mídia — precisa de `editMessageCaption` nesse caso, ver
 * `ScheduledCountdownEdit.isCaption`. */
async function editCountdownMessage(telegraf: Telegraf, row: ScheduledCountdownEdit, text: string): Promise<void> {
  if (row.isCaption) {
    await telegraf.telegram.editMessageCaption(Number(row.chatId), row.messageId, undefined, text, { parse_mode: "HTML" });
  } else {
    await telegraf.telegram.editMessageText(Number(row.chatId), row.messageId, undefined, text, { parse_mode: "HTML" });
  }
}

/**
 * Chamado logo depois de enviar uma mensagem cujo template continha
 * `{countdown:...}` (marker já substituído no texto enviado) — agenda o
 * primeiro tick pra daqui `directive.intervalSeconds`. O valor inicial já
 * apareceu no texto do envio (renderTemplate cuida disso), então o primeiro
 * tick do poller é sempre uma atualização, nunca o valor inicial de novo.
 */
export async function registerCountdown(params: {
  botId: string;
  chatId: bigint | number;
  messageId: number;
  markerTemplate: string;
  directive: CountdownDirective;
  isCaption?: boolean;
}): Promise<void> {
  const now = Date.now();
  await prisma.scheduledCountdownEdit.create({
    data: {
      botId: params.botId,
      chatId: BigInt(params.chatId),
      messageId: params.messageId,
      markerTemplate: params.markerTemplate,
      isCaption: params.isCaption ?? false,
      totalSeconds: params.directive.totalSeconds,
      intervalSeconds: params.directive.intervalSeconds,
      deleteOnZero: params.directive.deleteOnZero,
      nextTickAt: new Date(now + params.directive.intervalSeconds * 1000),
    },
  });
}

/**
 * Varre `ScheduledCountdownEdit` vencidos e edita a mensagem com o tempo
 * restante. Ao chegar em zero: apaga a mensagem (deleteOnZero) ou deixa
 * "00:00" fixo — em ambos os casos marca `finishedAt` pra parar de
 * processar essa linha. Mesmo padrão de poller de
 * src/bot/upsellScheduler.ts / downsellScheduler.ts.
 */
export async function processCountdownTicks(): Promise<void> {
  const due = await prisma.scheduledCountdownEdit.findMany({
    where: { finishedAt: null, nextTickAt: { lte: new Date() } },
    take: 50,
  });

  for (const row of due) {
    try {
      const telegraf = getTelegraf(row.botId);
      if (!telegraf) {
        await prisma.scheduledCountdownEdit.update({ where: { id: row.id }, data: { finishedAt: new Date() } });
        continue;
      }

      const elapsedSeconds = Math.floor((Date.now() - row.startedAt.getTime()) / 1000);
      const remainingSeconds = row.totalSeconds - elapsedSeconds;

      if (remainingSeconds <= 0) {
        if (row.deleteOnZero) {
          await telegraf.telegram.deleteMessage(Number(row.chatId), row.messageId);
        } else {
          const finalText = row.markerTemplate.replace(COUNTDOWN_MARKER, formatCountdownValue(0));
          await editCountdownMessage(telegraf, row, finalText);
        }
        await prisma.scheduledCountdownEdit.update({ where: { id: row.id }, data: { finishedAt: new Date() } });
        continue;
      }

      const text = row.markerTemplate.replace(COUNTDOWN_MARKER, formatCountdownValue(remainingSeconds));
      await editCountdownMessage(telegraf, row, text);
      await prisma.scheduledCountdownEdit.update({
        where: { id: row.id },
        data: { nextTickAt: new Date(Date.now() + row.intervalSeconds * 1000) },
      });
    } catch (err) {
      // Mensagem apagada pelo usuário, chat bloqueado, "message not
      // modified" etc — encerra essa linha em vez de martelar o mesmo erro
      // pra sempre (mesma lógica de idempotência dos outros schedulers).
      console.error(`[countdown-scheduler] falha ao processar ${row.id}`, err);
      await prisma.scheduledCountdownEdit.update({ where: { id: row.id }, data: { finishedAt: new Date() } });
    }
  }
}

let pollInFlight = false;

export function startCountdownScheduler(intervalMs: number): NodeJS.Timeout {
  return setInterval(() => {
    if (pollInFlight) return;
    pollInFlight = true;
    processCountdownTicks()
      .catch((err) => console.error("[countdown-scheduler] falha na varredura", err))
      .finally(() => {
        pollInFlight = false;
      });
  }, intervalMs);
}
