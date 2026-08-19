import { Router } from "express";
import { prisma } from "../db/client.js";
import { nextOrder } from "../bot/util.js";

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
    res.render("flows/welcome", { flow });
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
    const buttonStyle = String(req.body.buttonStyle ?? "PADRAO");
    const showConfirmationStep = req.body.showConfirmationStep === "on";

    await prisma.paymentMessages.upsert({
      where: { flowId },
      update: { pixGeneratedMessage, pixApprovedMessage, buttonStyle: buttonStyle as never, showConfirmationStep },
      create: { flowId, pixGeneratedMessage, pixApprovedMessage, buttonStyle: buttonStyle as never, showConfirmationStep },
    });

    res.redirect(`/admin/flows/${flowId}/payments`);
  });

  // --- Ofertas (Order Bump / Upsell / Downsell) ---

  async function loadOffers(flowId: string) {
    return prisma.offer.findMany({
      where: { triggerPlan: { flowId } },
      include: { triggerPlan: true, offeredPlan: true, parentOffer: { include: { offeredPlan: true } } },
      orderBy: { order: "asc" },
    });
  }

  router.get("/:id/offers", async (req, res) => {
    const flow = await loadFlow(req.params.id);
    if (!flow) return res.status(404).send("Fluxo não encontrado.");
    const offers = await loadOffers(flow.id);
    res.render("flows/offers", {
      flow,
      offers,
      upsellOffers: offers.filter((o) => o.kind === "UPSELL"),
      error: null,
    });
  });

  router.post("/:id/offers", async (req, res) => {
    const flowId = req.params.id;
    const kind = String(req.body.kind ?? "ORDER_BUMP");
    const triggerPlanId = String(req.body.triggerPlanId ?? "").trim();
    const offeredPlanId = String(req.body.offeredPlanId ?? "").trim();
    const parentOfferId = String(req.body.parentOfferId ?? "").trim() || null;
    const message = String(req.body.message ?? "").trim() || null;

    if (!triggerPlanId || !offeredPlanId || (kind === "DOWNSELL" && !parentOfferId)) {
      const flow = await loadFlow(flowId);
      const offers = flow ? await loadOffers(flow.id) : [];
      return res.status(400).render("flows/offers", {
        flow,
        offers,
        upsellOffers: offers.filter((o) => o.kind === "UPSELL"),
        error:
          kind === "DOWNSELL"
            ? "Plano-gatilho, plano ofertado e o Upsell recusado são obrigatórios pra um Downsell."
            : "Plano-gatilho e plano ofertado são obrigatórios.",
      });
    }

    const last = await prisma.offer.findFirst({
      where: { triggerPlan: { flowId } },
      orderBy: { order: "desc" },
      select: { order: true },
    });

    await prisma.offer.create({
      data: {
        triggerPlanId,
        offeredPlanId,
        kind: kind as never,
        parentOfferId: kind === "DOWNSELL" ? parentOfferId : null,
        message,
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

  router.post("/:id/delete", async (req, res) => {
    await prisma.flow.delete({ where: { id: req.params.id } });
    res.redirect("/admin/flows");
  });

  return router;
}
