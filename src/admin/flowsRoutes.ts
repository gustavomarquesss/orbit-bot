import { Router } from "express";
import multer from "multer";
import { prisma } from "../db/client.js";
import { nextOrder } from "../bot/util.js";
import { uploadMediaToLibrary, uploadDeliverableFile } from "../bot/mediaUpload.js";
import { getTelegraf } from "../bot/botManager.js";
import { withSuccess } from "./toastUtil.js";

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
      res.redirect(withSuccess(`/admin/flows/${flow.id}/bots`, "Fluxo criado com sucesso!"));
    } catch (err) {
      res.status(400).render("flows/new", { error: `Não foi possível criar o fluxo (chave "${key}" já existe?).` });
    }
  });

  router.get("/:id", async (req, res) => {
    res.redirect(`/admin/flows/${req.params.id}/bots`);
  });

  // `Plan.flow` é a única relação de Flow -> Plan no schema — não dá pra
  // pedir `plans` (Plano) e `packs` (Pack, productType diferente) como dois
  // includes distintos na mesma query, mesmo filtrando por productType em
  // cada um; por isso Packs é buscado à parte e anexado ao objeto do flow.
  async function loadFlow(flowId: string) {
    const [flow, packs] = await Promise.all([
      prisma.flow.findUnique({
        where: { id: flowId },
        include: {
          bots: { include: { bot: true } },
          welcomeConfig: { include: { media: { orderBy: { order: "asc" } }, redirectButtons: { orderBy: { order: "asc" } } } },
          paymentMessages: true,
          // Só Plan de verdade — Pack (productType PACK) não pode vazar pros
          // seletores de Order Bump/Upsell/Downsell nem pra lista de Planos.
          plans: { where: { productType: "PLAN" }, orderBy: { order: "asc" } },
          delivery: true,
          packConfig: true,
          previewConfig: { include: { media: { orderBy: { order: "asc" } } } },
        },
      }),
      prisma.plan.findMany({
        where: { flowId, productType: "PACK" },
        orderBy: { order: "asc" },
        include: { previewMedia: { orderBy: { order: "asc" } } },
      }),
    ]);
    if (!flow) return null;
    return { ...flow, packs };
  }

  /** Mídia já enviada via upload (ver src/bot/mediaUpload.ts) pelos bots vinculados
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

    res.redirect(withSuccess(`/admin/flows/${flow.id}/bots`, "Bots vinculados salvos com sucesso!"));
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

    await prisma.welcomeConfig.upsert({
      where: { flowId },
      update: { text, secondaryMessageEnabled, ctaButtonEnabled, ctaLabel, miniAppEnabled, miniAppUrl },
      create: { flowId, text, secondaryMessageEnabled, ctaButtonEnabled, ctaLabel, miniAppEnabled, miniAppUrl },
    });

    res.redirect(withSuccess(`/admin/flows/${flowId}/welcome`, "Boas-vindas salvas com sucesso!"));
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
    res.redirect(withSuccess(`/admin/flows/${flowId}/welcome`, "Mídia adicionada com sucesso!"));
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
    res.redirect(withSuccess(`/admin/flows/${flowId}/welcome`, "Mídia enviada com sucesso!"));
  });

  router.post("/:id/welcome/media/:mediaId/delete", async (req, res) => {
    await prisma.welcomeMedia.delete({ where: { id: req.params.mediaId } });
    res.redirect(withSuccess(`/admin/flows/${req.params.id}/welcome`, "Mídia removida com sucesso!"));
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
    res.redirect(withSuccess(`/admin/flows/${flowId}/welcome`, "Botão adicionado com sucesso!"));
  });

  router.post("/:id/welcome/redirect-buttons/:buttonId/delete", async (req, res) => {
    await prisma.redirectButton.delete({ where: { id: req.params.buttonId } });
    res.redirect(withSuccess(`/admin/flows/${req.params.id}/welcome`, "Botão removido com sucesso!"));
  });

  // --- Planos ---

  router.get("/:id/plans", async (req, res) => {
    const flow = await loadFlow(req.params.id);
    if (!flow) return res.status(404).send("Fluxo não encontrado.");
    const fileError = typeof req.query.fileError === "string" ? req.query.fileError : null;
    const deliveryError = typeof req.query.deliveryError === "string" ? req.query.deliveryError : null;
    res.render("flows/plans", { flow, editingPlan: null, error: null, fileError, deliveryError });
  });

  router.get("/:id/plans/:planId/edit", async (req, res) => {
    const flow = await loadFlow(req.params.id);
    if (!flow) return res.status(404).send("Fluxo não encontrado.");
    const editingPlan = flow.plans.find((p) => p.id === req.params.planId) ?? null;
    const fileError = typeof req.query.fileError === "string" ? req.query.fileError : null;
    const deliveryError = typeof req.query.deliveryError === "string" ? req.query.deliveryError : null;
    res.render("flows/plans", { flow, editingPlan, error: null, fileError, deliveryError });
  });

  function parsePriceToCents(input: string): number | null {
    const normalized = input.trim().replace(/\./g, "").replace(",", ".");
    const value = Number(normalized);
    if (!Number.isFinite(value) || value <= 0) return null;
    return Math.round(value * 100);
  }

  /** "" (ou ausente) = usar padrão do fluxo (Plan.deliveryType nulo) — ver
   * FlowDelivery/resolveEffectiveDelivery em src/bot/delivery.ts. MESSAGE
   * (Fase 2, Milestone 8) vale tanto pra Plan quanto pra Pack. */
  function parseDeliveryType(raw: unknown): "FILE" | "LINK" | "CHANNEL" | "MESSAGE" | null {
    return raw === "FILE" || raw === "LINK" || raw === "CHANNEL" || raw === "MESSAGE" ? raw : null;
  }

  /** Campos de entrega compartilhados por Plan e Pack (mesma tabela por
   * baixo) — cada um só preenchido quando faz sentido pro deliveryType
   * escolhido, os outros ficam null (evita lixo de um tipo anterior). */
  function buildDeliveryFields(deliveryType: ReturnType<typeof parseDeliveryType>, body: Record<string, unknown>) {
    const externalLink = String(body.externalLink ?? "").trim() || null;
    const subscriptionChannelId = String(body.subscriptionChannelId ?? "").trim() || null;
    const messageContent = String(body.messageContent ?? "").trim() || null;
    const customDeliveryTarget = String(body.customDeliveryTarget ?? "").trim() || null;
    return {
      deliveryType,
      externalLink: deliveryType === "LINK" ? externalLink : null,
      subscriptionChannelId: deliveryType === "CHANNEL" ? subscriptionChannelId : null,
      messageContent: deliveryType === "MESSAGE" ? messageContent : null,
      customDeliveryTarget: deliveryType ? customDeliveryTarget : null,
    };
  }

  router.post("/:id/plans", async (req, res) => {
    const flowId = req.params.id;
    const name = String(req.body.name ?? "").trim();
    const priceCents = parsePriceToCents(String(req.body.price ?? ""));
    const durationDays = String(req.body.durationDays ?? "").trim();
    const buttonColor = String(req.body.buttonColor ?? "PADRAO");
    const deliveryType = parseDeliveryType(req.body.deliveryType);
    const protectContent = req.body.protectContent === "on";
    const active = req.body.active === "on";

    if (!name || priceCents === null) {
      const flow = await loadFlow(flowId);
      return res.status(400).render("flows/plans", {
        flow,
        editingPlan: null,
        error: "Nome e preço (maior que zero) são obrigatórios.",
        fileError: null,
      });
    }

    const last = await prisma.plan.findFirst({ where: { flowId }, orderBy: { order: "desc" }, select: { order: true } });

    // fileTelegramId NÃO entra aqui — é preenchido só via upload direto
    // (POST /:id/plans/:planId/file/upload), depois que o plano já existe.
    await prisma.plan.create({
      data: {
        flowId,
        name,
        priceCents,
        durationDays: durationDays ? Number(durationDays) : null,
        buttonColor: buttonColor as never,
        ...buildDeliveryFields(deliveryType, req.body),
        protectContent,
        active,
        order: nextOrder(last?.order),
      },
    });

    res.redirect(withSuccess(`/admin/flows/${flowId}/plans`, "Plano criado com sucesso!"));
  });

  router.post("/:id/plans/:planId", async (req, res) => {
    const flowId = req.params.id;
    const name = String(req.body.name ?? "").trim();
    const priceCents = parsePriceToCents(String(req.body.price ?? ""));
    const durationDays = String(req.body.durationDays ?? "").trim();
    const buttonColor = String(req.body.buttonColor ?? "PADRAO");
    const deliveryType = parseDeliveryType(req.body.deliveryType);
    const protectContent = req.body.protectContent === "on";
    const active = req.body.active === "on";

    if (!name || priceCents === null) {
      const flow = await loadFlow(flowId);
      const editingPlan = flow?.plans.find((p) => p.id === req.params.planId) ?? null;
      return res.status(400).render("flows/plans", { flow, editingPlan, error: "Nome e preço (maior que zero) são obrigatórios.", fileError: null });
    }

    // fileTelegramId propositalmente fora do "data" — trocar de tipo de
    // entrega ou salvar o resto do plano não pode apagar um arquivo já
    // enviado via upload; só a rota de upload mexe nesse campo.
    await prisma.plan.update({
      where: { id: req.params.planId },
      data: {
        name,
        priceCents,
        durationDays: durationDays ? Number(durationDays) : null,
        buttonColor: buttonColor as never,
        ...buildDeliveryFields(deliveryType, req.body),
        protectContent,
        active,
      },
    });

    res.redirect(withSuccess(`/admin/flows/${flowId}/plans`, "Plano salvo com sucesso!"));
  });

  router.post("/:id/plans/:planId/file/upload", (req, res, next) => {
    mediaUpload.single("file")(req, res, (err) => {
      if (!err) return next();
      console.error(`[flows] falha no upload de arquivo do plano (plano ${req.params.planId})`, err);
      res.redirect(`/admin/flows/${req.params.id}/plans/${req.params.planId}/edit?fileError=${encodeURIComponent(multerErrorMessage(err))}`);
    });
  }, async (req, res) => {
    const flowId = req.params.id;
    const planId = req.params.planId;
    const editUrl = `/admin/flows/${flowId}/plans/${planId}/edit`;
    const plan = await prisma.plan.findUnique({
      where: { id: planId },
      include: { flow: { include: { bots: true, delivery: true } } },
    });
    if (!plan) return res.status(404).send("Plano não encontrado.");
    if (!req.file) return res.redirect(editUrl);

    const botId = plan.flow.bots[0]?.botId;
    if (!botId) {
      return res.redirect(`${editUrl}?fileError=${encodeURIComponent("Vincule um bot a este fluxo (aba Bots) antes de enviar o arquivo.")}`);
    }
    const channelId = plan.customDeliveryTarget ?? plan.flow.delivery?.deliveryTarget;
    if (!channelId) {
      return res.redirect(`${editUrl}?fileError=${encodeURIComponent('Configure um canal de entrega (deste plano ou a Entrega Padrão do fluxo) antes de enviar o arquivo.')}`);
    }

    try {
      const { messageId } = await uploadDeliverableFile({
        botId,
        channelId,
        buffer: req.file.buffer,
        mimeType: req.file.mimetype,
        filename: req.file.originalname,
      });
      await prisma.plan.update({ where: { id: planId }, data: { fileTelegramId: String(messageId) } });
    } catch (err) {
      console.error(`[flows] falha ao subir arquivo do plano ${planId}`, err);
      const message = err instanceof Error ? err.message : "Falha ao enviar o arquivo.";
      return res.redirect(`${editUrl}?fileError=${encodeURIComponent(message)}`);
    }
    res.redirect(withSuccess(editUrl, "Arquivo enviado com sucesso!"));
  });

  router.post("/:id/plans/:planId/delete", async (req, res) => {
    await prisma.plan.delete({ where: { id: req.params.planId } });
    res.redirect(withSuccess(`/admin/flows/${req.params.id}/plans`, "Plano excluído com sucesso!"));
  });

  // --- Packs (conteúdo avulso, Fase 2 Milestone 8) ---
  // Um Pack é um Plan com productType=PACK — reaproveita todo o pipeline de
  // Order/pagamento/entrega já validado, só filtrado/apresentado diferente
  // aqui e no bot (src/bot/flows.ts). Mesmo padrão visual de /plans (lista
  // colapsada + "Adicionar" escondido até clicar).

  const PACK_MEDIA_LIMIT = 3;

  /** Busca o id + nome de verdade (via getChat, ao vivo — sem cache) do
   * canal já configurado em Settings.salesChannelId, pra oferecer como
   * opção pronta na "Entrega do Pack" em vez de exigir colar o ID à mão.
   * "Atualizar" no formulário é só um reload da página (GET de novo). */
  async function loadSalesChannel(flow: { bots: { botId: string }[] }) {
    const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
    if (!settings?.salesChannelId) return { salesChannelId: null, salesChannelName: null };
    const botId = flow.bots[0]?.botId;
    const telegraf = botId ? getTelegraf(botId) : null;
    if (!telegraf) return { salesChannelId: settings.salesChannelId, salesChannelName: null };
    try {
      const chat = await telegraf.telegram.getChat(settings.salesChannelId);
      return { salesChannelId: settings.salesChannelId, salesChannelName: "title" in chat ? chat.title : null };
    } catch (err) {
      console.error("[flows] falha ao buscar nome do canal de vendas", err);
      return { salesChannelId: settings.salesChannelId, salesChannelName: null };
    }
  }

  router.get("/:id/packs", async (req, res) => {
    const flow = await loadFlow(req.params.id);
    if (!flow) return res.status(404).send("Fluxo não encontrado.");
    const { salesChannelId, salesChannelName } = await loadSalesChannel(flow);
    const fileError = typeof req.query.fileError === "string" ? req.query.fileError : null;
    res.render("flows/packs", { flow, editingPack: null, error: null, fileError, salesChannelId, salesChannelName });
  });

  router.get("/:id/packs/:packId/edit", async (req, res) => {
    const flow = await loadFlow(req.params.id);
    if (!flow) return res.status(404).send("Fluxo não encontrado.");
    const editingPack = flow.packs.find((p) => p.id === req.params.packId) ?? null;
    const { salesChannelId, salesChannelName } = await loadSalesChannel(flow);
    const fileError = typeof req.query.fileError === "string" ? req.query.fileError : null;
    res.render("flows/packs", { flow, editingPack, error: null, fileError, salesChannelId, salesChannelName });
  });

  router.post("/:id/packs/config", async (req, res) => {
    const flowId = req.params.id;
    const active = req.body.active === "on";
    const buttonLabel = String(req.body.buttonLabel ?? "").trim() || null;
    const headerMessage = String(req.body.headerMessage ?? "").trim() || null;

    await prisma.packConfig.upsert({
      where: { flowId },
      update: { active, buttonLabel, headerMessage },
      create: { flowId, active, buttonLabel, headerMessage },
    });

    res.redirect(withSuccess(`/admin/flows/${flowId}/packs`, "Packs salvo com sucesso!"));
  });

  router.post("/:id/packs", async (req, res) => {
    const flowId = req.params.id;
    // Sem campo de emoji separado — mesma convenção já usada nos Planos
    // normais desta conta, onde o emoji já vem digitado dentro do próprio
    // nome (ex: "VÍDEOS COM FILHO 🔞😈" nos dados reais desta sessão).
    const name = String(req.body.name ?? "").trim();
    const priceCents = parsePriceToCents(String(req.body.price ?? ""));
    const description = String(req.body.description ?? "").trim() || null;
    const deliveryType = parseDeliveryType(req.body.deliveryType);
    const active = req.body.active === "on";

    if (!name || priceCents === null) {
      const flow = await loadFlow(flowId);
      return res.status(400).render("flows/packs", {
        flow,
        editingPack: null,
        error: "Nome e preço (maior que zero) são obrigatórios.",
        fileError: null,
        salesChannelId: null,
        salesChannelName: null,
      });
    }

    const last = await prisma.plan.findFirst({
      where: { flowId, productType: "PACK" },
      orderBy: { order: "desc" },
      select: { order: true },
    });

    // Pack não tem campo de canal manual — "Arquivo" sempre usa o canal já
    // configurado em Settings.salesChannelId (a opção "VENDAS APROVADAS" do
    // seletor), pra não pedir pro admin colar o ID de novo.
    const deliveryFields = buildDeliveryFields(deliveryType, req.body);
    if (deliveryType === "FILE") {
      const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
      deliveryFields.customDeliveryTarget = settings?.salesChannelId ?? null;
    }

    await prisma.plan.create({
      data: {
        flowId,
        productType: "PACK",
        name,
        priceCents,
        description,
        ...deliveryFields,
        protectContent: true,
        active,
        order: nextOrder(last?.order),
      },
    });

    res.redirect(withSuccess(`/admin/flows/${flowId}/packs`, "Pack criado com sucesso!"));
  });

  router.post("/:id/packs/:packId", async (req, res) => {
    const flowId = req.params.id;
    const name = String(req.body.name ?? "").trim();
    const priceCents = parsePriceToCents(String(req.body.price ?? ""));
    const description = String(req.body.description ?? "").trim() || null;
    const deliveryType = parseDeliveryType(req.body.deliveryType);
    const active = req.body.active === "on";

    if (!name || priceCents === null) {
      const flow = await loadFlow(flowId);
      const editingPack = flow?.packs.find((p) => p.id === req.params.packId) ?? null;
      return res.status(400).render("flows/packs", {
        flow,
        editingPack,
        error: "Nome e preço (maior que zero) são obrigatórios.",
        fileError: null,
        salesChannelId: null,
        salesChannelName: null,
      });
    }

    const deliveryFields = buildDeliveryFields(deliveryType, req.body);
    if (deliveryType === "FILE") {
      const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
      deliveryFields.customDeliveryTarget = settings?.salesChannelId ?? null;
    }

    // fileTelegramId propositalmente fora do "data" — mesmo motivo do Plano:
    // só a rota de upload mexe nesse campo.
    await prisma.plan.update({
      where: { id: req.params.packId },
      data: {
        name,
        priceCents,
        description,
        ...deliveryFields,
        active,
      },
    });

    res.redirect(withSuccess(`/admin/flows/${flowId}/packs`, "Pack salvo com sucesso!"));
  });

  router.post("/:id/packs/:packId/delete", async (req, res) => {
    await prisma.plan.delete({ where: { id: req.params.packId } });
    res.redirect(withSuccess(`/admin/flows/${req.params.id}/packs`, "Pack excluído com sucesso!"));
  });

  router.post("/:id/packs/:packId/file/upload", (req, res, next) => {
    mediaUpload.single("file")(req, res, (err) => {
      if (!err) return next();
      console.error(`[flows] falha no upload de arquivo do pack (pack ${req.params.packId})`, err);
      res.redirect(`/admin/flows/${req.params.id}/packs/${req.params.packId}/edit?fileError=${encodeURIComponent(multerErrorMessage(err))}`);
    });
  }, async (req, res) => {
    const flowId = req.params.id;
    const packId = req.params.packId;
    const editUrl = `/admin/flows/${flowId}/packs/${packId}/edit`;
    const pack = await prisma.plan.findUnique({ where: { id: packId }, include: { flow: { include: { bots: true } } } });
    if (!pack) return res.status(404).send("Pack não encontrado.");
    if (!req.file) return res.redirect(editUrl);

    const botId = pack.flow.bots[0]?.botId;
    if (!botId) {
      return res.redirect(`${editUrl}?fileError=${encodeURIComponent("Vincule um bot a este fluxo (aba Bots) antes de enviar o arquivo.")}`);
    }
    const channelId = pack.customDeliveryTarget;
    if (!channelId) {
      return res.redirect(`${editUrl}?fileError=${encodeURIComponent('Configure o Canal de vendas e mídias em /admin/settings antes de enviar o arquivo.')}`);
    }

    try {
      const { messageId } = await uploadDeliverableFile({
        botId,
        channelId,
        buffer: req.file.buffer,
        mimeType: req.file.mimetype,
        filename: req.file.originalname,
      });
      await prisma.plan.update({ where: { id: packId }, data: { fileTelegramId: String(messageId) } });
    } catch (err) {
      console.error(`[flows] falha ao subir arquivo do pack ${packId}`, err);
      const message = err instanceof Error ? err.message : "Falha ao enviar o arquivo.";
      return res.redirect(`${editUrl}?fileError=${encodeURIComponent(message)}`);
    }
    res.redirect(withSuccess(editUrl, "Arquivo enviado com sucesso!"));
  });

  router.post("/:id/packs/:packId/media/upload", (req, res, next) => {
    mediaUpload.single("file")(req, res, (err) => {
      if (!err) return next();
      console.error(`[flows] falha no upload de mídia de preview (pack ${req.params.packId})`, err);
      res.redirect(`/admin/flows/${req.params.id}/packs/${req.params.packId}/edit?fileError=${encodeURIComponent(multerErrorMessage(err))}`);
    });
  }, async (req, res) => {
    const flowId = req.params.id;
    const packId = req.params.packId;
    const editUrl = `/admin/flows/${flowId}/packs/${packId}/edit`;
    const pack = await prisma.plan.findUnique({
      where: { id: packId },
      include: { flow: { include: { bots: true } }, previewMedia: true },
    });
    if (!pack) return res.status(404).send("Pack não encontrado.");
    if (!req.file) return res.redirect(editUrl);
    if (pack.previewMedia.length >= PACK_MEDIA_LIMIT) return res.redirect(editUrl);

    const botId = pack.flow.bots[0]?.botId;
    if (!botId) {
      return res.redirect(`${editUrl}?fileError=${encodeURIComponent("Vincule um bot a este fluxo (aba Bots) antes de enviar mídia.")}`);
    }

    try {
      const asset = await uploadMediaToLibrary({
        botId,
        buffer: req.file.buffer,
        mimeType: req.file.mimetype,
        filename: req.file.originalname,
      });
      const last = pack.previewMedia.reduce((max, m) => Math.max(max, m.order), -1);
      await prisma.packPreviewMedia.create({
        data: { planId: packId, order: nextOrder(last === -1 ? null : last), mediaType: asset.mediaType, fileId: asset.fileId },
      });
    } catch (err) {
      console.error(`[flows] falha ao subir mídia de preview (pack ${packId})`, err);
      const message = err instanceof Error ? err.message : "Falha ao enviar o arquivo.";
      return res.redirect(`${editUrl}?fileError=${encodeURIComponent(message)}`);
    }
    res.redirect(withSuccess(editUrl, "Mídia enviada com sucesso!"));
  });

  router.post("/:id/packs/:packId/media/:mediaId/delete", async (req, res) => {
    await prisma.packPreviewMedia.delete({ where: { id: req.params.mediaId } });
    res.redirect(withSuccess(`/admin/flows/${req.params.id}/packs/${req.params.packId}/edit`, "Mídia removida com sucesso!"));
  });

  // --- Prévias que somem (Fase 2, Milestone 9) ---

  const PREVIEW_MEDIA_LIMIT = 8;
  const PREVIEW_DELAY_PRESETS = [5, 10, 15, 20, 30, 60];

  async function loadPreviewConfig(flowId: string) {
    return prisma.previewConfig.upsert({
      where: { flowId },
      update: {},
      create: { flowId },
      include: { media: { orderBy: { order: "asc" } } },
    });
  }

  router.get("/:id/previews", async (req, res) => {
    const flow = await loadFlow(req.params.id);
    if (!flow) return res.status(404).send("Fluxo não encontrado.");
    const config = await loadPreviewConfig(flow.id);
    const mediaAssets = await loadMediaAssetsForFlow(flow);
    const error = typeof req.query.mediaError === "string" ? req.query.mediaError : null;
    res.render("flows/previews", { flow, config, mediaAssets, error, delayPresets: PREVIEW_DELAY_PRESETS });
  });

  router.post("/:id/previews", async (req, res) => {
    const flowId = req.params.id;
    const active = req.body.active === "on";
    const buttonLabel = String(req.body.buttonLabel ?? "").trim() || null;
    const deleteAfterSeconds = Math.max(1, Number(req.body.deleteAfterSeconds ?? 15) || 15);
    const protectContent = req.body.protectContent === "on";
    const caption = String(req.body.caption ?? "").trim() || null;
    const expiredMessage = String(req.body.expiredMessage ?? "").trim() || null;
    const expiredShowPlansButton = req.body.expiredShowPlansButton === "on";

    await prisma.previewConfig.upsert({
      where: { flowId },
      update: { active, buttonLabel, deleteAfterSeconds, protectContent, caption, expiredMessage, expiredShowPlansButton },
      create: { flowId, active, buttonLabel, deleteAfterSeconds, protectContent, caption, expiredMessage, expiredShowPlansButton },
    });

    res.redirect(withSuccess(`/admin/flows/${flowId}/previews`, "Prévias salvas com sucesso!"));
  });

  router.post("/:id/previews/media", async (req, res) => {
    const flowId = req.params.id;
    const mediaType = String(req.body.mediaType ?? "");
    const fileId = String(req.body.fileId ?? "").trim();
    const config = await loadPreviewConfig(flowId);
    if (mediaType && fileId && config.media.length < PREVIEW_MEDIA_LIMIT) {
      const last = config.media.reduce((max, m) => Math.max(max, m.order), -1);
      await prisma.previewMedia.create({
        data: { previewConfigId: config.id, order: nextOrder(last === -1 ? null : last), mediaType: mediaType as never, fileId },
      });
    }
    res.redirect(`/admin/flows/${flowId}/previews`);
  });

  router.post("/:id/previews/media/upload", (req, res, next) => {
    mediaUpload.single("file")(req, res, (err) => {
      if (!err) return next();
      console.error(`[flows] falha no upload de mídia de prévia (flow ${req.params.id})`, err);
      res.redirect(`/admin/flows/${req.params.id}/previews?mediaError=${encodeURIComponent(multerErrorMessage(err))}`);
    });
  }, async (req, res) => {
    const flowId = req.params.id;
    const flow = await loadFlow(flowId);
    if (!flow) return res.status(404).send("Fluxo não encontrado.");
    const botId = flow.bots[0]?.botId;
    if (!req.file) return res.redirect(`/admin/flows/${flowId}/previews`);
    if (!botId) {
      return res.redirect(`/admin/flows/${flowId}/previews?mediaError=${encodeURIComponent("Vincule um bot a este fluxo (aba Bots) antes de enviar mídia.")}`);
    }

    const config = await loadPreviewConfig(flowId);
    if (config.media.length >= PREVIEW_MEDIA_LIMIT) return res.redirect(`/admin/flows/${flowId}/previews`);

    try {
      const asset = await uploadMediaToLibrary({
        botId,
        buffer: req.file.buffer,
        mimeType: req.file.mimetype,
        filename: req.file.originalname,
      });
      const last = config.media.reduce((max, m) => Math.max(max, m.order), -1);
      await prisma.previewMedia.create({
        data: { previewConfigId: config.id, order: nextOrder(last === -1 ? null : last), mediaType: asset.mediaType, fileId: asset.fileId },
      });
    } catch (err) {
      console.error(`[flows] falha ao subir mídia de prévia (flow ${flowId})`, err);
      const message = err instanceof Error ? err.message : "Falha ao enviar o arquivo.";
      return res.redirect(`/admin/flows/${flowId}/previews?mediaError=${encodeURIComponent(message)}`);
    }
    res.redirect(withSuccess(`/admin/flows/${flowId}/previews`, "Mídia enviada com sucesso!"));
  });

  router.post("/:id/previews/media/:mediaId/delete", async (req, res) => {
    await prisma.previewMedia.delete({ where: { id: req.params.mediaId } });
    res.redirect(withSuccess(`/admin/flows/${req.params.id}/previews`, "Mídia removida com sucesso!"));
  });

  // --- Entrega Padrão (Fallback) ---
  // Usada por todo Plano com deliveryType nulo ("usar padrão do fluxo") —
  // ver resolveEffectiveDelivery em src/bot/delivery.ts. Renomeado de
  // "canal-cofre" a pedido do usuário, 2026-08-20, espelhando a referência
  // ApexVips/SharkBot. Vive dentro da própria tela de Planos (não é mais uma
  // seção própria do menu) — pedido do usuário, 2026-08-20.

  router.post("/:id/delivery", async (req, res) => {
    const flowId = req.params.id;
    const deliveryType = parseDeliveryType(req.body.deliveryType) ?? "FILE";
    const deliveryTarget = String(req.body.deliveryTarget ?? "").trim() || null;
    const externalLink = String(req.body.externalLink ?? "").trim() || null;
    const subscriptionChannelId = String(req.body.subscriptionChannelId ?? "").trim() || null;

    // fileTelegramId propositalmente fora do "data" — mesmo motivo do Plano:
    // só a rota de upload mexe nesse campo.
    const data = {
      deliveryType,
      deliveryTarget: deliveryType === "FILE" ? deliveryTarget : null,
      externalLink: deliveryType === "LINK" ? externalLink : null,
      subscriptionChannelId: deliveryType === "CHANNEL" ? subscriptionChannelId : null,
    };
    await prisma.flowDelivery.upsert({
      where: { flowId },
      update: data,
      create: { flowId, ...data },
    });

    res.redirect(withSuccess(`/admin/flows/${flowId}/plans`, "Entrega Padrão salva com sucesso!"));
  });

  router.post("/:id/delivery/file/upload", (req, res, next) => {
    mediaUpload.single("file")(req, res, (err) => {
      if (!err) return next();
      console.error(`[flows] falha no upload da Entrega Padrão (flow ${req.params.id})`, err);
      res.redirect(`/admin/flows/${req.params.id}/plans?deliveryError=${encodeURIComponent(multerErrorMessage(err))}`);
    });
  }, async (req, res) => {
    const flowId = req.params.id;
    const editUrl = `/admin/flows/${flowId}/plans`;
    const flow = await prisma.flow.findUnique({ where: { id: flowId }, include: { bots: true, delivery: true } });
    if (!flow) return res.status(404).send("Fluxo não encontrado.");
    if (!req.file) return res.redirect(editUrl);

    const botId = flow.bots[0]?.botId;
    if (!botId) {
      return res.redirect(`${editUrl}?deliveryError=${encodeURIComponent("Vincule um bot a este fluxo (aba Bots) antes de enviar o arquivo.")}`);
    }
    const channelId = flow.delivery?.deliveryTarget;
    if (!channelId) {
      return res.redirect(`${editUrl}?deliveryError=${encodeURIComponent('Preencha o "Destino da Entrega" e salve antes de enviar o arquivo.')}`);
    }

    try {
      const { messageId } = await uploadDeliverableFile({
        botId,
        channelId,
        buffer: req.file.buffer,
        mimeType: req.file.mimetype,
        filename: req.file.originalname,
      });
      await prisma.flowDelivery.upsert({
        where: { flowId },
        update: { fileTelegramId: String(messageId) },
        create: { flowId, deliveryType: "FILE", deliveryTarget: channelId, fileTelegramId: String(messageId) },
      });
    } catch (err) {
      console.error(`[flows] falha ao subir arquivo da Entrega Padrão (flow ${flowId})`, err);
      const message = err instanceof Error ? err.message : "Falha ao enviar o arquivo.";
      return res.redirect(`${editUrl}?deliveryError=${encodeURIComponent(message)}`);
    }
    res.redirect(withSuccess(editUrl, "Arquivo enviado com sucesso!"));
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

    res.redirect(withSuccess(`/admin/flows/${flowId}/payments`, "Mensagens de pagamento salvas com sucesso!"));
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

    res.redirect(withSuccess(`/admin/flows/${flowId}/offers`, "Order Bump criado com sucesso!"));
  });

  router.post("/:id/offers/:offerId/toggle", async (req, res) => {
    const offer = await prisma.offer.findUnique({ where: { id: req.params.offerId } });
    if (offer) {
      await prisma.offer.update({ where: { id: offer.id }, data: { active: !offer.active } });
    }
    res.redirect(withSuccess(`/admin/flows/${req.params.id}/offers`, "Order Bump atualizado com sucesso!"));
  });

  router.post("/:id/offers/:offerId/delete", async (req, res) => {
    await prisma.offer.delete({ where: { id: req.params.offerId } });
    res.redirect(withSuccess(`/admin/flows/${req.params.id}/offers`, "Order Bump excluído com sucesso!"));
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
    res.redirect(withSuccess(`/admin/flows/${flowId}/upsell`, "Upsell salvo com sucesso!"));
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
    res.redirect(withSuccess(`/admin/flows/${flowId}/upsell`, "Upsell salvo com sucesso!"));
  });

  router.post("/:id/upsell/messages/:messageId", async (req, res) => {
    const text = String(req.body.text ?? "").trim() || null;
    const delayMinutes = Math.max(0, Number(req.body.delayMinutes ?? 0) || 0);
    await prisma.upsellMessage.update({
      where: { id: req.params.messageId },
      data: { text, delayMinutes },
    });
    res.redirect(withSuccess(`/admin/flows/${req.params.id}/upsell`, "Upsell salvo com sucesso!"));
  });

  router.post("/:id/upsell/messages/:messageId/delete", async (req, res) => {
    await prisma.upsellMessage.delete({ where: { id: req.params.messageId } });
    res.redirect(withSuccess(`/admin/flows/${req.params.id}/upsell`, "Upsell salvo com sucesso!"));
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
    res.redirect(withSuccess(`/admin/flows/${req.params.id}/upsell`, "Upsell salvo com sucesso!"));
  });

  router.post("/:id/upsell/messages/:messageId/plans/:linkId/delete", async (req, res) => {
    await prisma.upsellMessagePlan.delete({ where: { id: req.params.linkId } });
    res.redirect(withSuccess(`/admin/flows/${req.params.id}/upsell`, "Upsell salvo com sucesso!"));
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
    res.redirect(withSuccess(`/admin/flows/${req.params.id}/upsell`, "Upsell salvo com sucesso!"));
  });

  router.post("/:id/upsell/messages/:messageId/buttons/:buttonId/delete", async (req, res) => {
    await prisma.upsellMessageButton.delete({ where: { id: req.params.buttonId } });
    res.redirect(withSuccess(`/admin/flows/${req.params.id}/upsell`, "Upsell salvo com sucesso!"));
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
    res.redirect(withSuccess(`/admin/flows/${flowId}/downsell`, "Downsell atualizado com sucesso!"));
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
    res.redirect(withSuccess(`/admin/flows/${flowId}/downsell?tab=${trigger === "PIX_GENERATED" ? "pix" : "geral"}`, "Sequência criada com sucesso!"));
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
    res.redirect(withSuccess(`/admin/flows/${req.params.id}/downsell?tab=${sequence.trigger === "PIX_GENERATED" ? "pix" : "geral"}`, "Sequência salva com sucesso!"));
  });

  router.post("/:id/downsell/sequences/:seqId/toggle", async (req, res) => {
    const sequence = await prisma.downsellSequence.findUnique({ where: { id: req.params.seqId } });
    if (sequence) {
      await prisma.downsellSequence.update({ where: { id: sequence.id }, data: { active: !sequence.active } });
    }
    res.redirect(withSuccess(`/admin/flows/${req.params.id}/downsell?tab=${sequence?.trigger === "PIX_GENERATED" ? "pix" : "geral"}`, "Sequência atualizada com sucesso!"));
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
    res.redirect(withSuccess(`/admin/flows/${req.params.id}/downsell?tab=${original?.trigger === "PIX_GENERATED" ? "pix" : "geral"}`, "Sequência duplicada com sucesso!"));
  });

  router.post("/:id/downsell/sequences/:seqId/delete", async (req, res) => {
    const sequence = await prisma.downsellSequence.findUnique({ where: { id: req.params.seqId } });
    await prisma.downsellSequence.delete({ where: { id: req.params.seqId } });
    res.redirect(withSuccess(`/admin/flows/${req.params.id}/downsell?tab=${sequence?.trigger === "PIX_GENERATED" ? "pix" : "geral"}`, "Sequência excluída com sucesso!"));
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
    res.redirect(withSuccess(`/admin/flows/${req.params.id}/downsell?tab=${sequence?.trigger === "PIX_GENERATED" ? "pix" : "geral"}`, "Mídia adicionada com sucesso!"));
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
    res.redirect(withSuccess(redirectUrl, "Mídia enviada com sucesso!"));
  });

  router.post("/:id/downsell/sequences/:seqId/media/:mediaId/delete", async (req, res) => {
    const media = await prisma.downsellSequenceMedia.findUnique({
      where: { id: req.params.mediaId },
      include: { sequence: true },
    });
    if (media) await prisma.downsellSequenceMedia.delete({ where: { id: media.id } });
    res.redirect(withSuccess(`/admin/flows/${req.params.id}/downsell?tab=${media?.sequence.trigger === "PIX_GENERATED" ? "pix" : "geral"}`, "Mídia removida com sucesso!"));
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
    res.redirect(withSuccess(`/admin/flows/${req.params.id}/downsell?tab=${sequence?.trigger === "PIX_GENERATED" ? "pix" : "geral"}`, "Plano anexado com sucesso!"));
  });

  router.post("/:id/downsell/sequences/:seqId/plans/:linkId/delete", async (req, res) => {
    const link = await prisma.downsellSequencePlan.findUnique({
      where: { id: req.params.linkId },
      include: { sequence: true },
    });
    if (link) await prisma.downsellSequencePlan.delete({ where: { id: link.id } });
    res.redirect(withSuccess(`/admin/flows/${req.params.id}/downsell?tab=${link?.sequence.trigger === "PIX_GENERATED" ? "pix" : "geral"}`, "Plano removido com sucesso!"));
  });

  router.post("/:id/delete", async (req, res) => {
    await prisma.flow.delete({ where: { id: req.params.id } });
    res.redirect(withSuccess("/admin/flows", "Fluxo excluído com sucesso!"));
  });

  return router;
}
