import type { BroadcastSegment } from "@prisma/client";
import { prisma } from "../db/client.js";
import { getTelegraf } from "./botManager.js";
import { renderTemplate } from "./templating.js";

// Lote de mensagens entre pausas — o limite real da Bot API é ~30 msg/s
// (chats diferentes); 25 por segundo fica com folga sem exigir controle fino.
const BATCH_SIZE = 25;
const BATCH_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveRecipients(botId: string, segment: BroadcastSegment) {
  if (segment === "BUYERS") {
    return prisma.lead.findMany({ where: { botId, orders: { some: { status: "PAID" } } } });
  }
  if (segment === "NON_BUYERS") {
    return prisma.lead.findMany({ where: { botId, orders: { none: { status: "PAID" } } } });
  }
  return prisma.lead.findMany({ where: { botId } });
}

/**
 * Processa um Broadcast já criado (status SENDING) — chamado pela rota do
 * painel sem `await`, pra não bloquear a resposta HTTP enquanto envia pra
 * uma lista potencialmente grande de Leads. Falha de mensagem individual
 * (bloqueou o bot, conta deletada, etc) incrementa `failedCount` e segue
 * pro próximo — não aborta o broadcast inteiro. Só marca `status: FAILED`
 * se o bot nem estiver registrado (nada pôde ser mandado).
 */
export async function sendBroadcast(broadcastId: string): Promise<void> {
  const broadcast = await prisma.broadcast.findUniqueOrThrow({ where: { id: broadcastId } });
  const botRow = await prisma.bot.findUniqueOrThrow({ where: { id: broadcast.botId } });
  const telegraf = getTelegraf(broadcast.botId);

  if (!telegraf) {
    await prisma.broadcast.update({
      where: { id: broadcastId },
      data: { status: "FAILED", startedAt: new Date(), finishedAt: new Date() },
    });
    return;
  }

  const recipients = await resolveRecipients(broadcast.botId, broadcast.segment);
  await prisma.broadcast.update({
    where: { id: broadcastId },
    data: { startedAt: new Date(), totalRecipients: recipients.length },
  });

  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    const batch = recipients.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (lead) => {
        try {
          const text = renderTemplate(broadcast.message, { lead, bot: botRow });
          await telegraf.telegram.sendMessage(Number(lead.telegramId), text, { parse_mode: "HTML" });
          await prisma.broadcast.update({ where: { id: broadcastId }, data: { sentCount: { increment: 1 } } });
        } catch (err) {
          console.error(`[broadcast] falha ao mandar pra lead ${lead.id}`, err);
          await prisma.broadcast.update({ where: { id: broadcastId }, data: { failedCount: { increment: 1 } } });
        }
      })
    );
    if (i + BATCH_SIZE < recipients.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  await prisma.broadcast.update({
    where: { id: broadcastId },
    data: { status: "DONE", finishedAt: new Date() },
  });
}
