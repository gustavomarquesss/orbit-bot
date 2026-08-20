import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { Router } from "express";
import multer from "multer";
import { Prisma } from "@prisma/client";
import { prisma } from "../db/client.js";
import { encryptSecret, decryptSecret } from "../lib/crypto.js";
import { validateBotToken, registerBot, unregisterBot, getTelegraf } from "../bot/botManager.js";
import { uploadMediaToLibrary } from "../bot/mediaUpload.js";
import { withSuccess } from "./toastUtil.js";

// Memória (não disco) — arquivo some depois do request, já foi repassado
// pro Telegram nesse meio tempo (ver uploadMediaToLibrary). 50MB é o limite
// real de upload da Bot API (sendPhoto/sendVideo/etc) — um limite menor
// cortava vídeo de celular em silêncio (bug real encontrado pelo usuário,
// 2026-08-20, corrigido também em flowsRoutes.ts).
const mediaUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const COMMAND_DEFAULTS: Record<"START" | "SUPORTE" | "STATUS", { emoji: string; label: string; order: number }> = {
  START: { emoji: "🚀", label: "Iniciar o bot", order: 0 },
  SUPORTE: { emoji: "💬", label: "Falar com suporte", order: 1 },
  STATUS: { emoji: "📊", label: "Ver minha assinatura", order: 2 },
};

export function createBotsRouter(): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    const ownerId = req.session.userId!;
    const bots = await prisma.bot.findMany({
      where: { ownerId },
      orderBy: { createdAt: "asc" },
      include: {
        _count: { select: { leads: true, orders: true } },
      },
    });
    const revenueByBot = await prisma.order.groupBy({
      by: ["botId"],
      where: { status: "PAID", bot: { ownerId } },
      _sum: { amountCents: true },
    });
    const revenueMap = new Map(revenueByBot.map((r) => [r.botId, r._sum.amountCents ?? 0]));
    res.render("bots/list", { bots, revenueMap, error: null });
  });

  router.get("/new", async (_req, res) => {
    res.render("bots/new", { error: null });
  });

  router.post("/", async (req, res) => {
    const ownerId = req.session.userId!;
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
        ownerId,
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

    res.redirect(withSuccess(`/admin/bots/${bot.id}/edit`, "Bot criado com sucesso!"));
  });

  router.get("/:id/edit", async (req, res) => {
    const bot = await prisma.bot.findFirst({
      where: { id: req.params.id, ownerId: req.session.userId! },
      include: { commands: { orderBy: { order: "asc" } } },
    });
    if (!bot) return res.status(404).send("Bot não encontrado.");
    res.render("bots/edit", { bot, live: !!getTelegraf(bot.id), error: null });
  });

  router.post("/:id", async (req, res) => {
    const bot = await prisma.bot.findFirst({ where: { id: req.params.id, ownerId: req.session.userId! } });
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

    res.redirect(withSuccess(`/admin/bots/${bot.id}/edit`, "Perfil salvo com sucesso!"));
  });

  router.post("/:id/commands", async (req, res) => {
    const bot = await prisma.bot.findFirst({ where: { id: req.params.id, ownerId: req.session.userId! } });
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

    res.redirect(withSuccess(`/admin/bots/${bot.id}/edit`, "Comandos salvos com sucesso!"));
  });

  // --- Biblioteca de mídia (captura automática via canal, ver src/bot/mediaCapture.ts) ---

  router.get("/:id/media", async (req, res) => {
    const bot = await prisma.bot.findFirst({ where: { id: req.params.id, ownerId: req.session.userId! } });
    if (!bot) return res.status(404).send("Bot não encontrado.");
    const assets = await prisma.mediaAsset.findMany({ where: { botId: bot.id }, orderBy: { createdAt: "desc" } });
    res.render("bots/media", { bot, assets, error: null });
  });

  router.post("/:id/media/upload", (req, res, next) => {
    // multer chama next(err) ANTES do handler abaixo rodar (ex: arquivo
    // maior que o limite) — sem esse wrapper, o erro cairia no handler
    // genérico do Express (página de erro feia) em vez da tela normal com
    // a mensagem certa.
    mediaUpload.single("file")(req, res, async (err) => {
      if (!err) return next();
      const bot = await prisma.bot.findFirst({ where: { id: req.params.id, ownerId: req.session.userId! } });
      if (!bot) return res.status(404).send("Bot não encontrado.");
      const assets = await prisma.mediaAsset.findMany({ where: { botId: bot.id }, orderBy: { createdAt: "desc" } });
      const message = err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE"
        ? "Arquivo maior que o limite de 50MB da Bot API do Telegram."
        : "Falha ao processar o arquivo enviado.";
      res.status(400).render("bots/media", { bot, assets, error: message });
    });
  }, async (req, res) => {
    const bot = await prisma.bot.findFirst({ where: { id: req.params.id, ownerId: req.session.userId! } });
    if (!bot) return res.status(404).send("Bot não encontrado.");

    if (!req.file) {
      const assets = await prisma.mediaAsset.findMany({ where: { botId: bot.id }, orderBy: { createdAt: "desc" } });
      return res.status(400).render("bots/media", { bot, assets, error: "Nenhum arquivo selecionado." });
    }

    try {
      await uploadMediaToLibrary({
        botId: bot.id,
        buffer: req.file.buffer,
        mimeType: req.file.mimetype,
        filename: req.file.originalname,
      });
    } catch (err) {
      console.error(`[bots] falha ao subir mídia (bot ${bot.id})`, err);
      const assets = await prisma.mediaAsset.findMany({ where: { botId: bot.id }, orderBy: { createdAt: "desc" } });
      return res.status(400).render("bots/media", {
        bot,
        assets,
        error: err instanceof Error ? err.message : "Falha ao enviar o arquivo.",
      });
    }

    res.redirect(withSuccess(`/admin/bots/${bot.id}/media`, "Mídia enviada com sucesso!"));
  });

  router.post("/:id/media/:mediaId/delete", async (req, res) => {
    await prisma.mediaAsset.deleteMany({
      where: { id: req.params.mediaId, botId: req.params.id, bot: { ownerId: req.session.userId! } },
    });
    res.redirect(withSuccess(`/admin/bots/${req.params.id}/media`, "Mídia removida com sucesso!"));
  });

  // Proxy autenticado (sessão admin, mesmo middleware do resto de /admin) —
  // busca o arquivo real no Telegram no servidor e repassa os bytes, pra
  // nunca expor o token do bot no HTML/rede do navegador do admin (a URL
  // direta https://api.telegram.org/file/bot<token>/... carrega o token).
  router.get("/:id/media/:mediaId/file", async (req, res) => {
    const asset = await prisma.mediaAsset.findUnique({
      where: { id: req.params.mediaId },
      include: { bot: true },
    });
    if (!asset || asset.botId !== req.params.id || asset.bot.ownerId !== req.session.userId) {
      return res.status(404).send("Mídia não encontrada.");
    }

    const telegraf = getTelegraf(asset.botId);
    if (!telegraf) return res.status(503).send("Bot offline — não é possível buscar a mídia agora.");

    try {
      const file = await telegraf.telegram.getFile(asset.fileId);
      const token = decryptSecret(asset.bot.telegramBotTokenEncrypted);
      const upstream = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
      if (!upstream.ok || !upstream.body) {
        return res.status(502).send("Falha ao buscar o arquivo no Telegram.");
      }
      res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "application/octet-stream");
      res.setHeader("Cache-Control", "private, max-age=3600");
      Readable.fromWeb(upstream.body as never).pipe(res);
    } catch (err) {
      console.error(`[bots] falha ao servir mídia ${asset.id}`, err);
      res.status(502).send("Falha ao buscar a mídia.");
    }
  });

  router.post("/:id/delete", async (req, res) => {
    const ownerId = req.session.userId!;
    const bot = await prisma.bot.findFirst({ where: { id: req.params.id, ownerId } });
    if (!bot) return res.status(404).send("Bot não encontrado.");

    // Deleta do banco ANTES de mexer no Telegram — se o bot tiver Orders
    // (histórico financeiro), o delete falha por causa da foreign key
    // (de propósito: não cascateia venda paga junto com o bot) e não queremos
    // ter já removido o webhook de um bot que continua existindo no painel.
    try {
      await prisma.bot.delete({ where: { id: req.params.id } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") {
        const bots = await prisma.bot.findMany({
          where: { ownerId },
          orderBy: { createdAt: "asc" },
          include: { _count: { select: { leads: true, orders: true } } },
        });
        const revenueByBot = await prisma.order.groupBy({
          by: ["botId"],
          where: { status: "PAID", bot: { ownerId } },
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

    res.redirect(withSuccess("/admin/bots", "Bot excluído com sucesso!"));
  });

  return router;
}
