import type { Context } from "telegraf";
import type { Lead, Origin } from "@prisma/client";
import { prisma } from "../db/client.js";

export interface DeepLinkResult {
  lead: Lead;
  origin: Origin | null;
  isNewLead: boolean;
}

/**
 * Decisão: um `start` payload que não bate com nenhuma `Origin.param`
 * existente gera uma Origin nova automaticamente (kind OTHER, label = param),
 * em vez de só logar como desconhecida e descartar. O objetivo do produto é
 * rastrear toda fonte de tráfego (ARCHITECTURE.md); silenciosamente ignorar
 * um param novo perderia atribuição de forma permanente na primeira vez que
 * o link fosse usado. O trade-off é que qualquer pessoa pode "inventar" um
 * `?start=xyz` e criar uma Origin — aceitável aqui porque é um bot pessoal,
 * de baixo volume, com um único operador olhando a lista periodicamente.
 */
async function resolveOrigin(startPayload: string | undefined): Promise<Origin | null> {
  const param = startPayload?.trim();
  if (!param) return null;

  const existing = await prisma.origin.findUnique({ where: { param } });
  if (existing) return existing;

  console.warn(`[deepLink] origem desconhecida "${param}" — criando automaticamente`);
  return prisma.origin.create({
    data: { param, label: param, kind: "OTHER" },
  });
}

/**
 * Chamado no `/start`. Resolve a Origin do deep link (se houver) e cria ou
 * atualiza o Lead pelo par (`telegramId`, `botId`) — o mesmo usuário do
 * Telegram é um Lead distinto em cada Bot (funis/vendas separados por bot).
 * A Origin só é gravada no primeiro contato — leads já existentes nunca têm
 * sua origem sobrescrita, mesmo que voltem por um `start` payload diferente.
 */
export async function resolveOriginAndUpsertLead(
  ctx: Context,
  botId: string,
  startPayload: string | undefined
): Promise<DeepLinkResult | null> {
  const from = ctx.from;
  if (!from) return null;

  const telegramId = BigInt(from.id);
  const origin = await resolveOrigin(startPayload);

  const existingLead = await prisma.lead.findUnique({
    where: { telegramId_botId: { telegramId, botId } },
  });

  if (existingLead) {
    const lead = await prisma.lead.update({
      where: { id: existingLead.id },
      data: {
        username: from.username ?? null,
        firstName: from.first_name ?? null,
        lastName: from.last_name ?? null,
        languageCode: from.language_code ?? null,
        isPremium: from.is_premium ?? false,
        lastSeenAt: new Date(),
      },
    });

    const firstTouchOrigin = lead.originId
      ? await prisma.origin.findUnique({ where: { id: lead.originId } })
      : null;

    return { lead, origin: firstTouchOrigin, isNewLead: false };
  }

  const lead = await prisma.lead.create({
    data: {
      telegramId,
      botId,
      username: from.username ?? null,
      firstName: from.first_name ?? null,
      lastName: from.last_name ?? null,
      languageCode: from.language_code ?? null,
      isPremium: from.is_premium ?? false,
      originId: origin?.id,
    },
  });

  return { lead, origin, isNewLead: true };
}

/**
 * Atualiza `lastSeenAt`/dados básicos do Lead em qualquer interação que não
 * seja um `/start` (ex: clique em botão), sem mexer na Origin já atribuída.
 */
export async function touchLead(ctx: Context, botId: string): Promise<Lead | null> {
  const from = ctx.from;
  if (!from) return null;

  const telegramId = BigInt(from.id);

  return prisma.lead.upsert({
    where: { telegramId_botId: { telegramId, botId } },
    update: {
      username: from.username ?? null,
      firstName: from.first_name ?? null,
      lastName: from.last_name ?? null,
      languageCode: from.language_code ?? null,
      isPremium: from.is_premium ?? false,
      lastSeenAt: new Date(),
    },
    create: {
      telegramId,
      botId,
      username: from.username ?? null,
      firstName: from.first_name ?? null,
      lastName: from.last_name ?? null,
      languageCode: from.language_code ?? null,
      isPremium: from.is_premium ?? false,
    },
  });
}
