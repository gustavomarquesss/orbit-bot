import { prisma } from "../db/client.js";
import { getTelegraf } from "./botManager.js";

/**
 * Chamado logo depois de enviar a primeira mensagem de Prova Social (PIX
 * gerado com `showSocialProof` ativo) — agenda a troca pro próximo texto da
 * lista daqui `intervalSeconds`.
 */
export async function registerSocialProof(params: {
  botId: string;
  chatId: bigint | number;
  messageId: number;
  orderId: string;
  messages: string[];
  intervalSeconds: number;
  firstIndex: number;
}): Promise<void> {
  await prisma.scheduledSocialProofEdit.create({
    data: {
      botId: params.botId,
      chatId: BigInt(params.chatId),
      messageId: params.messageId,
      orderId: params.orderId,
      messages: params.messages,
      lastIndex: params.firstIndex,
      intervalSeconds: params.intervalSeconds,
      nextTickAt: new Date(Date.now() + params.intervalSeconds * 1000),
    },
  });
}

/** Sorteia um índice diferente do último mostrado (sem-op se só houver 1 texto). */
export function pickNextSocialProofIndex(length: number, lastIndex: number): number {
  if (length <= 1) return 0;
  let next = Math.floor(Math.random() * length);
  while (next === lastIndex) next = Math.floor(Math.random() * length);
  return next;
}

/**
 * Varre `ScheduledSocialProofEdit` vencidos e troca o texto da mensagem.
 * Para (marca `finishedAt`) assim que o Order correspondente sai de
 * PENDING (pago, recusado ou expirado) — não faz sentido continuar
 * "provando socialmente" uma venda que já foi decidida. Mesmo padrão de
 * poller de src/bot/countdownScheduler.ts.
 */
export async function processSocialProofTicks(): Promise<void> {
  const due = await prisma.scheduledSocialProofEdit.findMany({
    where: { finishedAt: null, nextTickAt: { lte: new Date() } },
    take: 50,
  });

  for (const row of due) {
    try {
      const order = await prisma.order.findUnique({ where: { id: row.orderId }, select: { status: true } });
      if (!order || order.status !== "PENDING" || row.messages.length === 0) {
        await prisma.scheduledSocialProofEdit.update({ where: { id: row.id }, data: { finishedAt: new Date() } });
        continue;
      }

      const telegraf = getTelegraf(row.botId);
      if (!telegraf) {
        await prisma.scheduledSocialProofEdit.update({ where: { id: row.id }, data: { finishedAt: new Date() } });
        continue;
      }

      const nextIndex = pickNextSocialProofIndex(row.messages.length, row.lastIndex);
      await telegraf.telegram.editMessageText(Number(row.chatId), row.messageId, undefined, row.messages[nextIndex]);
      await prisma.scheduledSocialProofEdit.update({
        where: { id: row.id },
        data: { lastIndex: nextIndex, nextTickAt: new Date(Date.now() + row.intervalSeconds * 1000) },
      });
    } catch (err) {
      // Mensagem apagada, chat bloqueado, "message not modified" etc —
      // encerra essa linha em vez de martelar o mesmo erro pra sempre.
      console.error(`[social-proof-scheduler] falha ao processar ${row.id}`, err);
      await prisma.scheduledSocialProofEdit.update({ where: { id: row.id }, data: { finishedAt: new Date() } });
    }
  }
}

let pollInFlight = false;

export function startSocialProofScheduler(intervalMs: number): NodeJS.Timeout {
  return setInterval(() => {
    if (pollInFlight) return;
    pollInFlight = true;
    processSocialProofTicks()
      .catch((err) => console.error("[social-proof-scheduler] falha na varredura", err))
      .finally(() => {
        pollInFlight = false;
      });
  }, intervalMs);
}
