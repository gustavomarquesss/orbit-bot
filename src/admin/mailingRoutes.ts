import { Router } from "express";
import { prisma } from "../db/client.js";
import { sendBroadcast } from "../bot/broadcast.js";
import { withSuccess } from "./toastUtil.js";

export function createMailingRouter(): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    const [bots, broadcasts] = await Promise.all([
      prisma.bot.findMany({ orderBy: { createdAt: "asc" } }),
      prisma.broadcast.findMany({ orderBy: { createdAt: "desc" }, include: { bot: true }, take: 50 }),
    ]);
    res.render("mailing", { bots, broadcasts, error: null });
  });

  router.post("/", async (req, res) => {
    const botId = String(req.body.botId ?? "").trim();
    const segment = String(req.body.segment ?? "ALL");
    const message = String(req.body.message ?? "").trim();

    if (!botId || !message) {
      const [bots, broadcasts] = await Promise.all([
        prisma.bot.findMany({ orderBy: { createdAt: "asc" } }),
        prisma.broadcast.findMany({ orderBy: { createdAt: "desc" }, include: { bot: true }, take: 50 }),
      ]);
      return res.status(400).render("mailing", { bots, broadcasts, error: "Bot e mensagem são obrigatórios." });
    }

    const broadcast = await prisma.broadcast.create({
      data: { botId, segment: segment as never, message },
    });

    // Disparado sem `await` de propósito — a lista de Leads pode ser grande
    // o bastante pra não valer a pena segurar a resposta HTTP esperando.
    // O admin acompanha sentCount/failedCount dando refresh em /admin/mailing.
    sendBroadcast(broadcast.id).catch((err) => console.error("[mailing] falha no broadcast", broadcast.id, err));

    res.redirect(withSuccess("/admin/mailing", "Disparo iniciado com sucesso!"));
  });

  return router;
}
