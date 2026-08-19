import { Router } from "express";
import { prisma } from "../db/client.js";
import { nextOrder } from "../bot/util.js";

export function createFlowsRouter(): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    const flows = await prisma.flow.findMany({
      orderBy: { createdAt: "asc" },
      include: { _count: { select: { steps: true } } },
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
    const isEntryPoint = req.body.isEntryPoint === "on";

    if (!key || !name) {
      return res.status(400).render("flows/new", { error: "Chave e nome são obrigatórios." });
    }

    try {
      if (isEntryPoint) {
        // Só um fluxo pode ser o ponto de entrada (o que roda no /start) —
        // desmarca qualquer outro antes de marcar este.
        await prisma.flow.updateMany({ where: { isEntryPoint: true }, data: { isEntryPoint: false } });
      }
      const flow = await prisma.flow.create({ data: { key, name, description, isEntryPoint } });
      res.redirect(`/admin/flows/${flow.id}`);
    } catch (err) {
      res.status(400).render("flows/new", { error: `Não foi possível criar o fluxo (chave "${key}" já existe?).` });
    }
  });

  router.get("/:id", async (req, res) => {
    const flow = await prisma.flow.findUnique({
      where: { id: req.params.id },
      include: { steps: { orderBy: { order: "asc" }, include: { buttons: { orderBy: { order: "asc" } } } } },
    });
    if (!flow) return res.status(404).send("Fluxo não encontrado.");

    const [allFlows, products] = await Promise.all([
      prisma.flow.findMany({ select: { id: true, key: true, name: true }, orderBy: { name: "asc" } }),
      prisma.product.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    ]);

    res.render("flows/detail", { flow, allFlows, products, error: null });
  });

  router.post("/:id", async (req, res) => {
    const name = String(req.body.name ?? "").trim();
    const description = String(req.body.description ?? "").trim() || null;
    const isEntryPoint = req.body.isEntryPoint === "on";

    if (isEntryPoint) {
      await prisma.flow.updateMany({
        where: { isEntryPoint: true, NOT: { id: req.params.id } },
        data: { isEntryPoint: false },
      });
    }
    await prisma.flow.update({ where: { id: req.params.id }, data: { name, description, isEntryPoint } });
    res.redirect(`/admin/flows/${req.params.id}`);
  });

  router.post("/:id/delete", async (req, res) => {
    await prisma.flow.delete({ where: { id: req.params.id } });
    res.redirect("/admin/flows");
  });

  // --- Steps ---

  router.post("/:flowId/steps", async (req, res) => {
    const text = String(req.body.text ?? "").trim() || null;
    const mediaType = String(req.body.mediaType ?? "NONE");
    const mediaFileId = String(req.body.mediaFileId ?? "").trim() || null;

    const last = await prisma.flowStep.findFirst({
      where: { flowId: req.params.flowId },
      orderBy: { order: "desc" },
      select: { order: true },
    });

    await prisma.flowStep.create({
      data: {
        flowId: req.params.flowId,
        order: nextOrder(last?.order),
        text,
        mediaType: mediaType as never,
        mediaFileId,
      },
    });
    res.redirect(`/admin/flows/${req.params.flowId}`);
  });

  router.post("/:flowId/steps/:stepId", async (req, res) => {
    const text = String(req.body.text ?? "").trim() || null;
    const mediaType = String(req.body.mediaType ?? "NONE");
    const mediaFileId = String(req.body.mediaFileId ?? "").trim() || null;

    await prisma.flowStep.update({
      where: { id: req.params.stepId },
      data: { text, mediaType: mediaType as never, mediaFileId },
    });
    res.redirect(`/admin/flows/${req.params.flowId}`);
  });

  router.post("/:flowId/steps/:stepId/delete", async (req, res) => {
    await prisma.flowStep.delete({ where: { id: req.params.stepId } });
    res.redirect(`/admin/flows/${req.params.flowId}`);
  });

  // --- Buttons ---

  router.post("/:flowId/steps/:stepId/buttons", async (req, res) => {
    const label = String(req.body.label ?? "").trim();
    const action = String(req.body.action ?? "");
    const target = String(req.body.target ?? "").trim();
    if (!label || !action) return res.redirect(`/admin/flows/${req.params.flowId}`);

    const last = await prisma.button.findFirst({
      where: { flowStepId: req.params.stepId },
      orderBy: { order: "desc" },
      select: { order: true },
    });

    await prisma.button.create({
      data: {
        flowStepId: req.params.stepId,
        order: nextOrder(last?.order),
        label,
        action: action as never,
        targetFlowKey: action === "GOTO_FLOW" ? target : null,
        productId: action === "BUY_PRODUCT" ? target : null,
        url: action === "OPEN_LINK" || action === "REDIRECT_CHANNEL" ? target : null,
      },
    });
    res.redirect(`/admin/flows/${req.params.flowId}`);
  });

  router.post("/:flowId/steps/:stepId/buttons/:buttonId/delete", async (req, res) => {
    await prisma.button.delete({ where: { id: req.params.buttonId } });
    res.redirect(`/admin/flows/${req.params.flowId}`);
  });

  return router;
}
