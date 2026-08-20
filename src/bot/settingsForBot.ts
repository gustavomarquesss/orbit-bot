import type { Settings } from "@prisma/client";
import { prisma } from "../db/client.js";

/** `Settings` é 1 linha por usuário (Fase 3) — resolve a partir do `botId`
 * (o dono do bot), usado tanto pra notificação de venda (delivery.ts)
 * quanto pra biblioteca de mídia (mediaUpload.ts). */
export async function getSettingsForBot(botId: string): Promise<Settings | null> {
  const bot = await prisma.bot.findUnique({ where: { id: botId }, select: { ownerId: true } });
  if (!bot) return null;
  return prisma.settings.findUnique({ where: { ownerId: bot.ownerId } });
}
