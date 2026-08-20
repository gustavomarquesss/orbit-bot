import { Router } from "express";
import multer from "multer";
import { prisma } from "../db/client.js";
import { nextOrder } from "../bot/util.js";
import { uploadMediaToLibrary } from "../bot/mediaUpload.js";

// 50MB é o limite real de upload da Bot API do Telegram (sendPhoto/sendVideo/
// etc) — usar o mesmo aqui em vez de um número arbitrário menor, que cortava
// vídeo de celular em silêncio (bug real encontrado pelo usuário, 2026-08-20).
const mediaUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

function multerErrorMessage(err: unknown): string {
  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
    return "Arquivo maior que o limite de 50MB da Bot API do Telegram.";
  }
  return "Falha ao processar o arquivo enviado.";
}

export function createFlowsRouter(): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    const flows = await prisma.flow.findMany({
      orderBy: { createdAt: "asc" },
      include: { _count: { select: { bots: true, plans: true } } },
    });
    res.render("flows/list", { flows });
  });

  router.get("/new", async (_req, res) => {
    res.render("flows/new", { error: null });
  });

  router.post("/", async (req, res) => {
    const key = String(req.body.key ?? "").trim();
    const name = String(req.body.name ?? "").trim();
    const description = String(req.body.description ?? "").trim() || null;

    if (!key || !name) {
      return res.status(400).render("flows/new", { error: "Chave e nome são obrigatórios." });
    }

    try {
      const flow = await prisma.flow.create({
        data: { key, name, description, welcomeConfig: { create: {} } },
      });
      res.redirect(`/admin/flows/${flow.id}/bots`);
    } catch (err) {
      res.status(400).render("flows/new", { error: `Não foi possível criar o fluxo (chave "${key}" já existe?).` });
    }
  });

  router.get("/:id", async (req, res) => {
    res.redirect(`/admin/flows/${req.params.id}/bots`);
  });

  async function loadFlow(flowId: string) {
    return prisma.flow.findUnique({
      where: { id: flowId },
      include: {
        bots: { include: { bot: true } },
        welcomeConfig: { include: { media: { orderBy: { order: "asc" } }, redirectButtons: { orderBy: { order: "asc" } } } },
        paymentMessages: true,
        plans: { orderBy: { order: "asc" } },
      },
    });
  }

  /** Mídia já capturada (ver src/bot/mediaCapture.ts) pelos bots vinculados
   * a este Flow — alimenta o seletor "Escolher da biblioteca" nos forms de
   * mídia de Boas-vindas/Downsell, poupando colar file_id à mão. */
  async function loadMediaAssetsForFlow(flow: { bots: { botId: string }[] }) {
    const botIds = flow.bots.map((fb) => fb.botId);
    if (botIds.length === 0) return [];
    return prisma.mediaAsset.findMany({ where: { botId: { in: botIds } }, orderBy: { createdAt: "desc" } });
  }

  // --- Bots vinculados ---

  router.get("/:id/bots", async (req, res) => {
    const flow = await loadFlow(req.params.id);
    if (!flow) return res.status(404).send("Fluxo não encontrado.");
    const allBots = await prisma.bot.findMany({ orderBy: { createdAt: "asc" } });
    const linkedIds = new Set(flow.bots.map((fb) => fb.botId));
    res.render("flows/bots", { flow, allBots, linkedIds });
  });

  router.post("/:id/bots", async (req, res) => {
    const flow = await prisma.flow.findUnique({ where: { id: req.params.id } });
    if (!flow) return res.status(404).send("Fluxo não encontrado.");

    const rawBotIds: unknown = req.body.botIds;
    const selected = new Set<string>(
      Array.isArray(rawBotIds) ? rawBotIds.map(String) : rawBotIds ? [String(rawBotIds)] : []
    );
    const current = await prisma.flowBot.findMany({ where: { flowId: flow.id } });
    const currentIds = new Set(current.map((c) => c.botId));

    const toAdd = [...selected].filter((id) => !currentIds.has(id));
    const toRemove = [...currentIds].filter((id) => !selected.has(id));

    await prisma.$transaction([
      ...toAdd.map((botId) => prisma.flowBot.create({ data: { flowId: flow.id, botId } })),
      ...toRemove.map((botId) =>
        prisma.flowBot.delete({ where: { flowId_botId: { flowId: flow.id, botId } } })
      ),
    ]);

    res.redirect(`/admin/flows/${flow.id}/bots`);
  });

  // --- Boas-vindas ---

  router.get("/:id/welcome", async (req, res) => {
    const flow = await loadFlow(req.params.id);
    if (!flow) return res.status(404).send("Fluxo não encontrado.");
    const mediaAssets = await loadMediaAssetsForFlow(flow);
    const mediaError = typeof req.query.mediaError === "string" ? req.query.mediaError : null;
    res.render("flows/welcome", { flow, mediaAssets, mediaError });
  });

  router.post("/:id/welcome", async (req, res) => {
    const flowId = req.params.id;
    const text = String(req.body.text ?? "").trim() || null;
    const secondaryMessageEnabled = req.body.secondaryMessageEnabled === "on";
    const ctaButtonEnabled = req.body.ctaButtonEnabled === "on";
    const ctaLabel = String(req.body.ctaLabel ?? "").trim() || null;
    const miniAppEnabled = req.body.miniAppEnabled === "on";
    const miniAppUrl = String(req.body.miniAppUrl ?? "").trim() || null;
    const defaultDeliveryTarget = String(req.body.defaultDeliveryTarget ?? "").trim() || null;

    await prisma.welcomeConfig.upsert({
      where: { flowId },
      update: { text, secondaryMessageEnabled, ctaButtonEnabled, ctaLabel, miniAppEnabled, miniAppUrl, defaultDeliveryTarget },
      create: { flowId, text, secondaryMessageEnabled, ctaButtonEnabled, ctaLabel, miniAppEnabled, miniAppUrl, defaultDeliveryTarget },
    });

    res.redirect(`/admin/flows/${flowId}/welcome`);
  });

  router.post("/:id/welcome/media", async (req, res) => {
    const flowId = req.params.id;
    const mediaType = String(req.body.mediaType ?? "");
    const fileId = String(req.body.fileId ?? "").trim();
    if (!mediaType || !fileId) return res.redirect(`/admin/flows/${flowId}/welcome`);

    const welcome = await prisma.welcomeConfig.upsert({
      where: { flowId },
      update: {},
      create: { flowId },
    });
    const existing = await prisma.welcomeMedia.findMany({ where: { welcomeConfigId: welcome.id } });
    if (existing.length >= 3) return res.redirect(`/admin/flows/${flowId}/welcome`);

    const last = existing.reduce((max, m) => Math.max(max, m.order), -1);
    await prisma.welcomeMedia.create({
      data: { welcomeConfigId: welcome.id, order: nextOrder(last === -1 ? null : last), mediaType: mediaType as never, fileId },
    });
    res.redirect(`/admin/flows/${flowId}/welcome`);
  });

  router.post("/:id/welcome/media/upload", (req, res, next) => {
    mediaUpload.single("file")(req, res, (err) => {
      if (!err) return next();
      console.error(`[flows] falha no upload de mídia de boas-vindas (flow ${req.params.id})`, err);
      res.redirect(`/admin/flows/${req.params.id}/welcome?mediaError=${encodeURIComponent(multerErrorMessage(err))}`);
    });
  }, async (req, res) => {
    const flowId = req.params.id;
    const flow = await loadFlow(flowId);
    if (!flow) return res.status(404).send("Fluxo não encontrado.");
    const botId = flow.bots[0]?.botId;
    if (!req.file) return res.redirect(`/admin/flows/${flowId}/welcome`);
    if (!botId) {
      return res.redirect(`/admin/flows/${flowId}/welcome?mediaError=${encodeURIComponent("Vincule um bot a este fluxo (aba Bots) antes de enviar mídia.")}`);
    }

    const welcome = await prisma.welcomeConfig.upsert({ where: { flowId }, update: {}, create: { flowId } });
    const existing = await prisma.welcomeMedia.findMany({ where: { welcomeConfigId: welcome.id } });
    if (existing.length >= 3) return res.redirect(`/admin/flows/${flowId}/welcome`);

    try {
      const asset = await uploadMediaToLibrary({
        botId,
        buffer: req.file.buffer,
        mimeType: req.file.mimetype,
        filename: req.file.originalname,
      });
      const last = existing.reduce((max, m) => Math.max(max, m.order), -1);
      await prisma.welcomeMedia.create({
        data: { welcomeConfigId: welcome.id, order: nextOrder(last === -1 ? null : last), mediaType: asset.mediaType, fileId: asset.fileId },
      });
    } catch (err) {
      console.error(`[flows] falha ao subir mídia de boas-vindas (flow ${flowId})`, err);
      const message = err instanceof Error ? err.message : "Falha ao enviar o arquivo.";
      return res.redirect(`/admin/flows/${flowId}/welcome?mediaError=${encodeURIComponent(message)}`);
    }
    res.redirect(`/admin/flows/${flowId}/welcome`);
  });

  router.post("/:id/welcome/media/:mediaId/delete", async (req, res) => {
    await prisma.welcomeMedia.delete({ where: { id: req.params.mediaId } });
    res.redirect(`/admin/flows/${req.params.id}/welcome`);
  });

  router.post("/:id/welcome/redirect-buttons", async (req, res) => {
    const flowId = req.params.id;
    const label = String(req.body.label ?? "").trim();
    const url = String(req.body.url ?? "").trim();
    if (!label || !url) return res.redirect(`/admin/flows/${flowId}/welcome`);

    const welcome = await prisma.welcomeConfig.upsert({ where: { flowId }, update: {}, create: { flowId } });
    const existing = await prisma.redirectButton.findMany({ where: { welcomeConfigId: welcome.id } });
    if (existing.length >= 3) return res.redirect(`/admin/flows/${flowId}/welcome`);

    const last = existing.reduce((max, b) => Math.max(max, b.order), -1);
    await prisma.redirectButton.create({
      data: { welcomeConfigId: welcome.id, order: nextOrder(last === -1 ? null : last), label, url },
    });
    res.redirect(`/admin/flows/${flowId}/welcome`);
  });

  router.post("/:id/welcome/redirect-buttons/:buttonId/delete", async (req, res) => {
    await prisma.redirectButton.delete({ where: { id: req.params.buttonId } });
    res.redirect(`/admin/flows/${req.params.id}/welcome`);
  });

  // --- Planos ---

  router.get("/:id/plans", async (req, res) => {
    const flow = await loadFlow(req.params.id);
    if (!flow) return res.status(404).send("Fluxo não encontrado.");
    res.render("flows/plans", { flow, editingPlan: null, error: null });
  });

  router.get("/:id/plans/:planId/edit", async (req, res) => {
    const flow = await loadFlow(req.params.id);
    if (!flow) return res.status(404).send("Fluxo não encontrado.");
    const editingPlan = flow.plans.find((p) => p.id === req.params.planId) ?? null;
    res.render("flows/plans", { flow, editingPlan, error: null });
  });

  function parsePriceToCents(input: string): number | null {
    const normalized = input.trim().replace(/\./g, "").replace(",", ".");
    const value = Number(normalized);
    if (!Number.isFinite(value) || value <= 0) return null;
    return Math.round(value * 100);
  }

  router.post("/:id/plans", async (req, res) => {
    const flowId = req.params.id;
    const name = String(req.body.name ?? "").trim();
    const priceCents = parsePriceToCents(String(req.body.price ?? ""));
    const durationDays = String(req.body.durationDays ?? "").trim();
    const buttonColor = String(req.body.buttonColor ?? "PADRAO");
    const deliveryType = String(req.body.deliveryType ?? "LINK");
    const fileTelegramId = String(req.body.fileTelegramId ?? "").trim() || null;
    const externalLink = String(req.body.externalLink ?? "").trim() || null;
    const subscriptionChannelId = String(req.body.subscriptionChannelId ?? "").trim() || null;
    const customDeliveryTarget = String(req.body.customDeliveryTarget ?? "").trim() || null;
    const protectContent = req.body.protectContent === "on";
    const active = req.body.active === "on";

    if (!name || priceCents === null) {
      const flow = await loadFlow(flowId);
      return res.status(400).render("flows/plans", {
        flow,
        editingPlan: null,
        error: "Nome e preço (maior que zero) são obrigatórios.",
      });
    }

    const last = await prisma.plan.findFirst({ where: { flowId }, orderBy: { order: "desc" }, select: { order: true } });

    await prisma.plan.create({
      data: {
        flowId,
        name,
        priceCents,
        durationDays: durationDays ? Number(durationDays) : null,
        buttonColor: buttonColor as never,
        deliveryType: deliveryType as never,
        fileTelegramId: deliveryType === "FILE" ? fileTelegramId : null,
        externalLink: deliveryType === "LINK" ? externalLink : null,
        subscriptionChannelId: deliveryType === "CHANNEL" ? subscriptionChannelId : null,
        customDeliveryTarget,
        protectContent,
        active,
        order: nextOrder(last?.order),
      },
    });

    res.redirect(`/admin/flows/${flowId}/plans`);
  });

  router.post("/:id/plans/:planId", async (req, res) => {
    const flowId = req.params.id;
    const name = String(req.body.name ?? "").trim();
    const priceCents = parsePriceToCents(String(req.body.price ?? ""));
    const durationDays = String(req.body.durationDays ?? "").trim();
    const buttonColor = String(req.body.buttonColor ?? "PADRAO");
    const deliveryType = String(req.body.deliveryType ?? "LINK");
    const fileTelegramId = String(req.body.fileTelegramId ?? "").trim() || null;
    const externalLink = String(req.body.externalLink ?? "").trim() || null;
    const subscriptionChannelId = String(req.body.subscriptionChannelId ?? "").trim() || null;
    const customDeliveryTarget = String(req.body.customDeliveryTarget ?? "").trim() || null;
    const protectContent = req.body.protectContent === "on";
    const active = req.body.active === "on";

    if (!name || priceCents === null) {
      const flow = await loadFlow(flowId);
      const editingPlan = flow?.plans.find((p) => p.id === req.params.planId) ?? null;
      return res.status(400).render("flows/plans", { flow, editingPlan, error: "Nome e preço (maior que zero) são obrigatórios." });
    }

    await prisma.plan.update({
      where: { id: req.params.planId },
      data: {
        name,
        priceCents,
        durationDays: durationDays ? Number(durationDays) : null,
        buttonColor: buttonColor as never,
        deliveryType: deliveryType as never,
        fileTelegramId: deliveryType === "FILE" ? fileTelegramId : null,
        externalLink: deliveryType === "LINK" ? externalLink : null,
        subscriptionChannelId: deliveryType === "CHANNEL" ? subscriptionChannelId : null,
        customDeliveryTarget,
        protectContent,
        active,
      },
    });

    res.redirect(`/admin/flows/${flowId}/plans`);
  });

  router.post("/:id/plans/:planId/delete", async (req, res) => {
    await prisma.plan.delete({ where: { id: req.params.planId } });
    res.redirect(`/admin/flows/${req.params.id}/plans`);
  });

  // --- Pagamentos ---

  router.get("/:id/payments", async (req, res) => {
    const flow = await loadFlow(req.params.id);
    if (!flow) return res.status(404).send("Fluxo não encontrado.");
    res.render("flows/payments", { flow });
  });

  router.post("/:id/payments", async (req, res) => {
    const flowId = req.params.id;
    const pixGeneratedMessage = String(req.body.pixGeneratedMessage ?? "").trim() || null;
    const pixApprovedMessage = String(req.body.pixApprovedMessage ?? "").trim() || null;
    const renewalMessage = String(req.body.renewalMessage ?? "").trim() || null;
    const buttonStyle = String(req.body.buttonStyle ?? "PADRAO");
    const showConfirmationStep = req.body.showConfirmationStep === "on";

    await prisma.paymentMessages.upsert({
      where: { flowId },
      update: { pixGeneratedMessage, pixApprovedMessage, renewalMessage, buttonStyle: buttonStyle as never, showConfirmationStep },
      create: { flowId, pixGeneratedMessage, pixApprovedMessage, renewalMessage, buttonStyle: buttonStyle as never, showConfirmationStep },
    });

    res.redirect(`/admin/flows/${flowId}/payments`);
  });

  // --- Order Bump ---

  async function loadOffers(flowId: string) {
    return prisma.offer.findMany({
      where: { triggerPlan: { flowId }, kind: "ORDER_BUMP" },
      include: { triggerPlan: true, offeredPlan: true },
      orderBy: { order: "asc" },
    });
  }

  router.get("/:id/offers", async (req, res) => {
    const flow = await loadFlow(req.params.id);
    if (!flow) return res.status(404).send("Fluxo não encontrado.");
    const offers = await loadOffers(flow.id);
    res.render("flows/offers", { flow, offers, error: null });
  });

  router.post("/:id/offers", async (req, res) => {
    const flowId = req.params.id;
    const triggerPlanId = String(req.body.triggerPlanId ?? "").trim();
    const offeredPlanId = String(req.body.offeredPlanId ?? "").trim();
    const message = String(req.body.message ?? "").trim() || null;
    const acceptLabel = String(req.body.acceptLabel ?? "").trim() || null;
    const declineLabel = String(req.body.declineLabel ?? "").trim() || null;

    if (!triggerPlanId || !offeredPlanId) {
      const flow = await loadFlow(flowId);
      const offers = flow ? await loadOffers(flow.id) : [];
      return res.status(400).render("flows/offers", {
        flow,
        offers,
        error: "Plano-gatilho e plano oferecido são obrigatórios.",
      });
    }

    const last = await prisma.offer.findFirst({
      where: { triggerPlan: { flowId }, kind: "ORDER_BUMP" },
      orderBy: { order: "desc" },
      select: { order: true },
    });

    await prisma.offer.create({
      data: {
        triggerPlanId,
        offeredPlanId,
        kind: "ORDER_BUMP",
        message,
        acceptLabel,
        declineLabel,
        order: nextOrder(last?.order),
      },
    });

    res.redirect(`/admin/flows/${flowId}/offers`);
  });

  router.post("/:id/offers/:offerId/toggle", async (req, res) => {
    const offer = await prisma.offer.findUnique({ where: { id: req.params.offerId } });
    if (offer) {
      await prisma.offer.update({ where: { id: offer.id }, data: { active: !offer.active } });
    }
    res.redirect(`/admin/flows/${req.params.id}/offers`);
  });

  router.post("/:id/offers/:offerId/delete", async (req, res) => {
    await prisma.offer.delete({ where: { id: req.params.offerId } });
    res.redirect(`/admin/flows/${req.params.id}/offers`);
  });

  // --- Upsell (sequência de mensagens após qualquer compra do funil) ---

  async function loadUpsellSequence(flowId: string) {
    const sequence = await prisma.upsellSequence.upsert({
      where: { flowId },
      update: {},
      create: { flowId },
      include: {
        messages: {
          orderBy: { order: "asc" },
          include: {
            plans: { orderBy: { order: "asc" }, include: { plan: true } },
            buttons: { orderBy: { order: "asc" }, include: { targetPlan: true } },
          },
        },
      },
    });
    return sequence;
  }

  router.get("/:id/upsell", async (req, res) => {
    const flow = await loadFlow(req.params.id);
    if (!flow) return res.status(404).send("Fluxo não encontrado.");
    const sequence = await loadUpsellSequence(flow.id);
    res.render("flows/upsell", { flow, sequence, error: null });
  });

  router.post("/:id/upsell", async (req, res) => {
    const flowId = req.params.id;
    const active = req.body.active === "on";
    await prisma.upsellSequence.upsert({
      where: { flowId },
      update: { active },
      create: { flowId, active },
    });
    res.redirect(`/admin/flows/${flowId}/upsell`);
  });

  router.post("/:id/upsell/messages", async (req, res) => {
    const flowId = req.params.id;
    const sequence = await prisma.upsellSequence.upsert({
      where: { flowId },
      update: {},
      create: { flowId },
    });
    const last = await prisma.upsellMessage.findFirst({
      where: { sequenceId: sequence.id },
      orderBy: { order: "desc" },
      select: { order: true },
    });
    await prisma.upsellMessage.create({
      data: { sequenceId: sequence.id, order: nextOrder(last?.order) },
    });
    res.redirect(`/admin/flows/${flowId}/upsell`);
  });

  router.post("/:id/upsell/messages/:messageId", async (req, res) => {
    const text = String(req.body.text ?? "").trim() || null;
    const delayMinutes = Math.max(0, Number(req.body.delayMinutes ?? 0) || 0);
    await prisma.upsellMessage.update({
      where: { id: req.params.messageId },
      data: { text, delayMinutes },
    });
    res.redirect(`/admin/flows/${req.params.id}/upsell`);
  });

  router.post("/:id/upsell/messages/:messageId/delete", async (req, res) => {
    await prisma.upsellMessage.delete({ where: { id: req.params.messageId } });
    res.redirect(`/admin/flows/${req.params.id}/upsell`);
  });

  router.post("/:id/upsell/messages/:messageId/plans", async (req, res) => {
    const messageId = req.params.messageId;
    const planId = String(req.body.planId ?? "").trim();
    if (planId) {
      const last = await prisma.upsellMessagePlan.findFirst({
        where: { messageId },
        orderBy: { order: "desc" },
        select: { order: true },
      });
      await prisma.upsellMessagePlan
        .create({ data: { messageId, planId, order: nextOrder(last?.order) } })
        .catch(() => {}); // unique[messageId,planId] -- ignora se já estava anexado
    }
    res.redirect(`/admin/flows/${req.params.id}/upsell`);
  });

  router.post("/:id/upsell/messages/:messageId/plans/:linkId/delete", async (req, res) => {
    await prisma.upsellMessagePlan.delete({ where: { id: req.params.linkId } });
    res.redirect(`/admin/flows/${req.params.id}/upsell`);
  });

  router.post("/:id/upsell/messages/:messageId/buttons", async (req, res) => {
    const messageId = req.params.messageId;
    const text = String(req.body.text ?? "").trim();
    const type = String(req.body.type ?? "BUY_PLAN");
    const targetPlanId = String(req.body.targetPlanId ?? "").trim() || null;
    const url = String(req.body.url ?? "").trim() || null;

    if (text && ((type === "BUY_PLAN" && targetPlanId) || (type === "OPEN_LINK" && url))) {
      const last = await prisma.upsellMessageButton.findFirst({
        where: { messageId },
        orderBy: { order: "desc" },
        select: { order: true },
      });
      await prisma.upsellMessageButton.create({
        data: {
          messageId,
          text,
          type: type as never,
          targetPlanId: type === "BUY_PLAN" ? targetPlanId : null,
          url: type === "OPEN_LINK" ? url : null,
          order: nextOrder(last?.order),
        },
      });
    }
    res.redirect(`/admin/flows/${req.params.id}/upsell`);
  });

  router.post("/:id/upsell/messages/:messageId/buttons/:buttonId/delete", async (req, res) => {
    await prisma.upsellMessageButton.delete({ where: { id: req.params.buttonId } });
    res.redirect(`/admin/flows/${req.params.id}/upsell`);
  });

  // --- Downsell (Geral: pós-/start sem compra · PIX Gerado: PIX abandonado) ---

  const DOWNSELL_SEQUENCE_INCLUDE = {
    media: { orderBy: { order: "asc" as const } },
    plans: { orderBy: { order: "asc" as const }, include: { plan: true } },
  };

  async function loadDownsellConfig(flowId: string) {
    return prisma.downsellConfig.upsert({
      where: { flowId },
      update: {},
      create: { flowId },
      include: {
        sequences: {
          orderBy: { order: "asc" },
          include: DOWNSELL_SEQUENCE_INCLUDE,
        },
      },
    });
  }

  router.get("/:id/downsell", async (req, res) => {
    const flow = await loadFlow(req.params.id);
    if (!flow) return res.status(404).send("Fluxo não encontrado.");
    const config = await loadDownsellConfig(flow.id);
    const mediaAssets = await loadMediaAssetsForFlow(flow);
    const activeTab = req.query.tab === "pix" ? "pix" : "geral";
    const error = typeof req.query.mediaError === "string" ? req.query.mediaError : null;
    res.render("flows/downsell", { flow, config, mediaAssets, activeTab, error });
  });

  router.post("/:id/downsell", async (req, res) => {
    const flowId = req.params.id;
    const active = req.body.active === "on";
    await prisma.downsellConfig.upsert({
      where: { flowId },
      update: { active },
      create: { flowId, active },
    });
    res.redirect(`/admin/flows/${flowId}/downsell`);
  });

  const DOWNSELL_SEQUENCE_LIMIT = 20;

  router.post("/:id/downsell/sequences", async (req, res) => {
    const flowId = req.params.id;
    const trigger = req.body.trigger === "PIX_GENERATED" ? "PIX_GENERATED" : "GENERAL";
    const config = await loadDownsellConfig(flowId);

    const forTrigger = config.sequences.filter((s) => s.trigger === trigger);
    if (forTrigger.length < DOWNSELL_SEQUENCE_LIMIT) {
      const last = forTrigger.reduce((max, s) => Math.max(max, s.order), -1);
      await prisma.downsellSequence.create({
        data: {
          configId: config.id,
          trigger,
          order: nextOrder(last === -1 ? null : last),
          message: "Não conseguiu pagar? Temos uma oferta especial...",
        },
      });
    }
    res.redirect(`/admin/flows/${flowId}/downsell?tab=${trigger === "PIX_GENERATED" ? "pix" : "geral"}`);
  });

  router.post("/:id/downsell/sequences/:seqId", async (req, res) => {
    const message = String(req.body.message ?? "").trim() || "Não conseguiu pagar? Temos uma oferta especial...";
    const delayMinutes = Math.max(0, Number(req.body.delayMinutes ?? 5) || 0);
    const discountType = req.body.discountType === "FIXED" ? "FIXED" : "PERCENT";
    const discountValue = Math.max(0, Number(req.body.discountValue ?? 0) || 0);

    const sequence = await prisma.downsellSequence.update({
      where: { id: req.params.seqId },
      data: { message, delayMinutes, discountType, discountValue },
    });
    res.redirect(`/admin/flows/${req.params.id}/downsell?tab=${sequence.trigger === "PIX_GENERATED" ? "pix" : "geral"}`);
  });

  router.post("/:id/downsell/sequences/:seqId/toggle", async (req, res) => {
    const sequence = await prisma.downsellSequence.findUnique({ where: { id: req.params.seqId } });
    if (sequence) {
      await prisma.downsellSequence.update({ where: { id: sequence.id }, data: { active: !sequence.active } });
    }
    res.redirect(`/admin/flows/${req.params.id}/downsell?tab=${sequence?.trigger === "PIX_GENERATED" ? "pix" : "geral"}`);
  });

  router.post("/:id/downsell/sequences/:seqId/duplicate", async (req, res) => {
    const original = await prisma.downsellSequence.findUnique({
      where: { id: req.params.seqId },
      include: DOWNSELL_SEQUENCE_INCLUDE,
    });
    if (original) {
      const siblings = await prisma.downsellSequence.findMany({
        where: { configId: original.configId, trigger: original.trigger },
        orderBy: { order: "desc" },
        take: 1,
      });
      await prisma.downsellSequence.create({
        data: {
          configId: original.configId,
          trigger: original.trigger,
          order: nextOrder(siblings[0]?.order),
          delayMinutes: original.delayMinutes,
          discountType: original.discountType,
          discountValue: original.discountValue,
          message: original.message,
          active: original.active,
          media: { create: original.media.map((m) => ({ order: m.order, mediaType: m.mediaType, fileId: m.fileId })) },
          plans: { create: original.plans.map((p) => ({ planId: p.planId, order: p.order })) },
        },
      });
    }
    res.redirect(`/admin/flows/${req.params.id}/downsell?tab=${original?.trigger === "PIX_GENERATED" ? "pix" : "geral"}`);
  });

  router.post("/:id/downsell/sequences/:seqId/delete", async (req, res) => {
    const sequence = await prisma.downsellSequence.findUnique({ where: { id: req.params.seqId } });
    await prisma.downsellSequence.delete({ where: { id: req.params.seqId } });
    res.redirect(`/admin/flows/${req.params.id}/downsell?tab=${sequence?.trigger === "PIX_GENERATED" ? "pix" : "geral"}`);
  });

  router.post("/:id/downsell/sequences/:seqId/media", async (req, res) => {
    const seqId = req.params.seqId;
    const mediaType = String(req.body.mediaType ?? "");
    const fileId = String(req.body.fileId ?? "").trim();
    const sequence = await prisma.downsellSequence.findUnique({ where: { id: seqId } });
    if (mediaType && fileId && sequence) {
      const existing = await prisma.downsellSequenceMedia.findMany({ where: { sequenceId: seqId } });
      if (existing.length < 3) {
        const last = existing.reduce((max, m) => Math.max(max, m.order), -1);
        await prisma.downsellSequenceMedia.create({
          data: { sequenceId: seqId, order: nextOrder(last === -1 ? null : last), mediaType: mediaType as never, fileId },
        });
      }
    }
    res.redirect(`/admin/flows/${req.params.id}/downsell?tab=${sequence?.trigger === "PIX_GENERATED" ? "pix" : "geral"}`);
  });

  router.post("/:id/downsell/sequences/:seqId/media/upload", (req, res, next) => {
    mediaUpload.single("file")(req, res, (err) => {
      if (!err) return next();
      console.error(`[flows] falha no upload de mídia de downsell (seq ${req.params.seqId})`, err);
      res.redirect(`/admin/flows/${req.params.id}/downsell?mediaError=${encodeURIComponent(multerErrorMessage(err))}`);
    });
  }, async (req, res) => {
    const seqId = req.params.seqId;
    const sequence = await prisma.downsellSequence.findUnique({
      where: { id: seqId },
      include: { config: { include: { flow: { include: { bots: true } } } } },
    });
    const tab = sequence?.trigger === "PIX_GENERATED" ? "pix" : "geral";
    const redirectUrl = `/admin/flows/${req.params.id}/downsell?tab=${tab}`;
    const botId = sequence?.config.flow.bots[0]?.botId;
    if (!sequence || !req.file) return res.redirect(redirectUrl);
    if (!botId) {
      const message = encodeURIComponent("Vincule um bot a este fluxo (aba Bots) antes de enviar mídia.");
      return res.redirect(`${redirectUrl}&mediaError=${message}`);
    }

    const existing = await prisma.downsellSequenceMedia.findMany({ where: { sequenceId: seqId } });
    if (existing.length >= 3) return res.redirect(redirectUrl);

    try {
      const asset = await uploadMediaToLibrary({
        botId,
        buffer: req.file.buffer,
        mimeType: req.file.mimetype,
        filename: req.file.originalname,
      });
      const last = existing.reduce((max, m) => Math.max(max, m.order), -1);
      await prisma.downsellSequenceMedia.create({
        data: { sequenceId: seqId, order: nextOrder(last === -1 ? null : last), mediaType: asset.mediaType, fileId: asset.fileId },
      });
    } catch (err) {
      console.error(`[flows] falha ao subir mídia de downsell (seq ${seqId})`, err);
      const message = err instanceof Error ? err.message : "Falha ao enviar o arquivo.";
      return res.redirect(`${redirectUrl}&mediaError=${encodeURIComponent(message)}`);
    }
    res.redirect(redirectUrl);
  });

  router.post("/:id/downsell/sequences/:seqId/media/:mediaId/delete", async (req, res) => {
    const media = await prisma.downsellSequenceMedia.findUnique({
      where: { id: req.params.mediaId },
      include: { sequence: true },
    });
    if (media) await prisma.downsellSequenceMedia.delete({ where: { id: media.id } });
    res.redirect(`/admin/flows/${req.params.id}/downsell?tab=${media?.sequence.trigger === "PIX_GENERATED" ? "pix" : "geral"}`);
  });

  router.post("/:id/downsell/sequences/:seqId/plans", async (req, res) => {
    const seqId = req.params.seqId;
    const planId = String(req.body.planId ?? "").trim();
    const sequence = await prisma.downsellSequence.findUnique({ where: { id: seqId } });
    if (planId && sequence) {
      const last = await prisma.downsellSequencePlan.findFirst({
        where: { sequenceId: seqId },
        orderBy: { order: "desc" },
        select: { order: true },
      });
      await prisma.downsellSequencePlan
        .create({ data: { sequenceId: seqId, planId, order: nextOrder(last?.order) } })
        .catch(() => {}); // unique[sequenceId,planId] -- ignora se já estava anexado
    }
    res.redirect(`/admin/flows/${req.params.id}/downsell?tab=${sequence?.trigger === "PIX_GENERATED" ? "pix" : "geral"}`);
  });

  router.post("/:id/downsell/sequences/:seqId/plans/:linkId/delete", async (req, res) => {
    const link = await prisma.downsellSequencePlan.findUnique({
      where: { id: req.params.linkId },
      include: { sequence: true },
    });
    if (link) await prisma.downsellSequencePlan.delete({ where: { id: link.id } });
    res.redirect(`/admin/flows/${req.params.id}/downsell?tab=${link?.sequence.trigger === "PIX_GENERATED" ? "pix" : "geral"}`);
  });

  router.post("/:id/delete", async (req, res) => {
    await prisma.flow.delete({ where: { id: req.params.id } });
    res.redirect("/admin/flows");
  });

  return router;
}
