import type { Telegraf, Context } from "telegraf";
import { prisma } from "../db/client.js";
import { config } from "../config.js";
import { formatBRL } from "./format.js";

/**
 * Cadastro de conteúdo (bots/boas-vindas/planos) passou a ser feito pelo
 * painel web (/admin) — ver PROJECT_STATE.md e o plano em
 * C:\Users\gusta\.claude\plans\rippling-rolling-castle.md. Os comandos de
 * CRUD via chat (/novofluxo, /novoproduto, /novobotao) que existiam aqui
 * foram removidos junto com o modelo genérico de Flow/FlowStep/Button que
 * eles editavam. Só resta o que é intrinsecamente "no bot" (consulta rápida).
 */

function isAdmin(ctx: Context): boolean {
  return ctx.from?.id === config.TELEGRAM_ADMIN_USER_ID;
}

const ORDER_STATUS_LABELS: Record<string, string> = {
  PENDING: "Pendentes",
  PAID: "Pagas",
  REFUSED: "Recusadas",
  EXPIRED: "Expiradas",
};

export function registerAdminCommands(bot: Telegraf, botId: string): void {
  bot.command("vendas", async (ctx) => {
    if (!isAdmin(ctx)) return;

    const [statusCounts, revenueAgg] = await Promise.all([
      prisma.order.groupBy({ by: ["status"], where: { botId }, _count: { _all: true } }),
      prisma.order.aggregate({ where: { botId, status: "PAID" }, _sum: { amountCents: true } }),
    ]);

    const counts: Record<string, number> = { PENDING: 0, PAID: 0, REFUSED: 0, EXPIRED: 0 };
    for (const row of statusCounts) counts[row.status] = row._count._all;

    const lines = ["Resumo de vendas:"];
    for (const [status, label] of Object.entries(ORDER_STATUS_LABELS)) {
      lines.push(`${label}: ${counts[status] ?? 0}`);
    }
    lines.push(`Receita aprovada: ${formatBRL(revenueAgg._sum.amountCents ?? 0)}`);

    await ctx.reply(lines.join("\n"));
  });
}
