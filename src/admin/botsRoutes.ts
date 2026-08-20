import { randomBytes } from "node:crypto";
import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../db/client.js";
import { encryptSecret } from "../lib/crypto.js";
import { validateBotToken, registerBot, unregisterBot, getTelegraf } from "../bot/botManager.js";

const COMMAND_DEFAULTS: Record<"START" | "SUPORTE" | "STATUS", { emoji: string; label: string; order: number }> = {
  START: { emoji: "🚀", label: "Iniciar o bot", order: 0 },
  SUPORTE: { emoji: "💬", label: "Falar com suporte", order: 1 },
  STATUS: { emoji: "📊", label: "Ver minha assinatura", order: 2 },
};

export function createBotsRouter(): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    const bots = await prisma.bot.findMany({
      orderBy: { createdAt: "asc" },
      include: {
        _count: { select: { leads: true, orders: true } },
      },
    });
    const revenueByBot = await prisma.order.groupBy({
      by: ["botId"],
      where: { status: "PAID" },
      _sum: { amountCents: true },
    });
    const revenueMap = new Map(revenueByBot.map((r) => [r.botId, r._sum.amountCents ?? 0]));
    res.render("bots/list", { bots, revenueMap, error: null });
  });

  router.get("/new", async (_req, res) => {
    res.render("bots/new", { error: null });
  });

  router.post("/", async (req, res) => {
    const token = String(req.body.token ?? "").trim();
    const label = String(req.body.label ?? "").trim();
    if (!token || !label) {
      return res.status(400).render("bots/new", { error: "Nome e token são obrigatórios." });
    }

    let me: Awaited<ReturnType<typeof validateBotToken>>;
    try {
      me = await validateBotToken(token);
    } catch (err) {
      return res.status(400).render("bots/new", {
        error: "Token inválido — o Telegram recusou a autenticação. Confira se copiou certo do @BotFather.",
      });
    }

    const bot = await prisma.bot.create({
      data: {
        label,
        telegramBotTokenEncrypted: encryptSecret(token),
        telegramUsername: me.username ?? null,
        telegramUserId: BigInt(me.id),
        displayName: me.first_name,
        webhookSecret: randomBytes(20).toString("hex"),
        commands: {
          create: (Object.entries(COMMAND_DEFAULTS) as [keyof typeof COMMAND_DEFAULTS, (typeof COMMAND_DEFAULTS)["START"]][]).map(
            ([kind, def]) => ({ kind, emoji: def.emoji, label: def.label, order: def.order })
          ),
        },
      },
    });

    try {
      await registerBot(bot.id);
    } catch (err) {
      console.error(`[bots] falha ao subir a instância do bot ${bot.id} recém-criado`, err);
    }

    res.redirect(`/admin/bots/${bot.id}/edit`);
  });

  router.get("/:id/edit", async (req, res) => {
    const bot = await prisma.bot.findUnique({
      where: { id: req.params.id },
      include: { commands: { orderBy: { order: "asc" } } },
    });
    if (!bot) return res.status(404).send("Bot não encontrado.");
    res.render("bots/edit", { bot, live: !!getTelegraf(bot.id), error: null });
  });

  router.post("/:id", async (req, res) => {
    const bot = await prisma.bot.findUnique({ where: { id: req.params.id } });
    if (!bot) return res.status(404).send("Bot não encontrado.");

    const displayName = String(req.body.displayName ?? "").trim() || null;
    const description = String(req.body.description ?? "").trim() || null;
    const shortDescription = String(req.body.shortDescription ?? "").trim() || null;

    await prisma.bot.update({
      where: { id: bot.id },
      data: { displayName, description, shortDescription },
    });

    const telegraf = getTelegraf(bot.id);
    if (telegraf) {
      try {
        if (displayName) await telegraf.telegram.setMyName(displayName);
        await telegraf.telegram.setMyDescription(description ?? "");
        await telegraf.telegram.setMyShortDescription(shortDescription ?? "");
      } catch (err) {
        console.error(`[bots] falha ao sincronizar perfil com o Telegram (bot ${bot.id})`, err);
      }
    }

    res.redirect(`/admin/bots/${bot.id}/edit`);
  });

  router.post("/:id/commands", async (req, res) => {
    const bot = await prisma.bot.findUnique({ where: { id: req.params.id } });
    if (!bot) return res.status(404).send("Bot não encontrado.");

    const kinds = ["START", "SUPORTE", "STATUS"] as const;
    for (const kind of kinds) {
      const emoji = String(req.body[`${kind}_emoji`] ?? "").trim();
      const label = String(req.body[`${kind}_label`] ?? "").trim();
      if (!emoji || !label) continue;
      await prisma.botCommand.upsert({
        where: { botId_kind: { botId: bot.id, kind } },
        update: { emoji, label },
        create: { botId: bot.id, kind, emoji, label, order: COMMAND_DEFAULTS[kind].order },
      });
    }

    const telegraf = getTelegraf(bot.id);
    if (telegraf) {
      const commands = await prisma.botCommand.findMany({
        where: { botId: bot.id },
        orderBy: { order: "asc" },
      });
      try {
        await telegraf.telegram.setMyCommands(
          commands.map((c) => ({
            command: c.kind.toLowerCase(),
            description: `${c.emoji} ${c.label}`,
          }))
        );
      } catch (err) {
        console.error(`[bots] falha ao sincronizar comandos com o Telegram (bot ${bot.id})`, err);
      }
    }

    res.redirect(`/admin/bots/${bot.id}/edit`);
  });

  router.post("/:id/delete", async (req, res) => {
    // Deleta do banco ANTES de mexer no Telegram — se o bot tiver Orders
    // (histórico financeiro), o delete falha por causa da foreign key
    // (de propósito: não cascateia venda paga junto com o bot) e não queremos
    // ter já removido o webhook de um bot que continua existindo no painel.
    try {
      await prisma.bot.delete({ where: { id: req.params.id } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") {
        const bots = await prisma.bot.findMany({
          orderBy: { createdAt: "asc" },
          include: { _count: { select: { leads: true, orders: true } } },
        });
        const revenueByBot = await prisma.order.groupBy({
          by: ["botId"],
          where: { status: "PAID" },
          _sum: { amountCents: true },
        });
        const revenueMap = new Map(revenueByBot.map((r) => [r.botId, r._sum.amountCents ?? 0]));
        return res.status(400).render("bots/list", {
          bots,
          revenueMap,
          error: "Esse bot já tem vendas registradas — não dá pra excluir sem perder o histórico. Desative-o em vez de excluir.",
        });
      }
      throw err;
    }

    try {
      await unregisterBot(req.params.id);
    } catch (err) {
      console.error(`[bots] falha ao remover webhook do Telegram (bot ${req.params.id})`, err);
    }

    res.redirect("/admin/bots");
  });

  return router;
}
