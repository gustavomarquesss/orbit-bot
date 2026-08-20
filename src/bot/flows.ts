import { Markup, type Telegraf, type Context } from "telegraf";
import type { InlineKeyboardButton } from "telegraf/types";
import type { Lead, Offer, Plan, WelcomeConfig, WelcomeMedia, RedirectButton, Bot, PackConfig } from "@prisma/client";
import { prisma } from "../db/client.js";
import { createOrderAndCharge, type OrderItemInput } from "../payments/orders.js";
import { resolveOriginAndUpsertLead, touchLead } from "./deepLink.js";
import { prepareRichText, registerCountdownIfNeeded, styledCallbackButton, styledUrlButton, type PreparedText } from "./richSend.js";
import { offerRawTemplate, offerExtraVars, defaultAcceptLabel, defaultDeclineLabel } from "./offerMessage.js";
import { applyDiscount, parseDownsellBuyCallback, DOWNSELL_BUY_PREFIX } from "./downsellMessage.js";
import { scheduleGeneralDownsell, scheduleDownsellForOrder } from "./downsellScheduler.js";

type WelcomeWithRelations = WelcomeConfig & { media: WelcomeMedia[]; redirectButtons: RedirectButton[] };

const CTA_CALLBACK = "cta";
/** Também usado pelos botões BUY_PLAN do Upsell (src/bot/upsellScheduler.ts) — reaproveita este mesmo handler. */
export const PLAN_CALLBACK_PREFIX = "plan:";
export const BUMP_ACCEPT_PREFIX = "bmpA:";
export const BUMP_DECLINE_PREFIX = "bmpD:";
/** Fase 2, Milestone 8 — Packs. */
const PACKS_CALLBACK = "packs";
const PACK_DETAIL_PREFIX = "packDetail:";

async function getFlowForBot(botId: string) {
  const flowBot = await prisma.flowBot.findFirst({
    where: { botId },
    include: {
      flow: {
        include: {
          welcomeConfig: { include: { media: true, redirectButtons: true } },
          // `Flow.plans` é a única relação Flow -> Plan no schema, cobre
          // tanto Plan (productType PLAN) quanto Pack (productType PACK) —
          // separados abaixo em vez de dois includes na mesma relação
          // (Fase 2, Milestone 8).
          plans: { where: { active: true }, orderBy: { order: "asc" }, include: { previewMedia: { orderBy: { order: "asc" } } } },
          packConfig: true,
        },
      },
    },
  });
  if (!flowBot) return null;
  const { plans: allProducts, ...flow } = flowBot.flow;
  return {
    ...flow,
    plans: allProducts.filter((p) => p.productType === "PLAN"),
    packs: allProducts.filter((p) => p.productType === "PACK"),
  };
}

function buildWelcomeKeyboard(
  welcome: WelcomeWithRelations,
  plans: Plan[],
  packConfig: PackConfig | null,
  packs: Plan[]
) {
  const rows: InlineKeyboardButton[][] = [];
  const hasPlans = plans.length > 0;

  if (welcome.ctaButtonEnabled && hasPlans) {
    rows.push([styledCallbackButton(welcome.ctaLabel || "Ver planos", CTA_CALLBACK)]);
  } else if (hasPlans) {
    // Sem CTA, os botões de plano já vão direto na própria mensagem de
    // boas-vindas — evita mandar uma segunda mensagem só com o texto
    // "Escolha um plano:" pra repetir os mesmos botões (pedido do usuário,
    // 2026-08-20).
    rows.push(...buildPlansKeyboard(plans).reply_markup.inline_keyboard);
  }
  // Botão de Packs (Fase 2, Milestone 8) — sempre visível quando ativo e
  // com pack cadastrado, independente do CTA estar ligado ou desligado
  // (diferente do botão de Prévias, condicional ao CTA desligado): Pack é
  // uma linha de produto à parte, não um substituto da lista de planos.
  if (packConfig?.active && packs.length > 0) {
    rows.push([Markup.button.callback(packConfig.buttonLabel || "📦 Packs Disponíveis", PACKS_CALLBACK)]);
  }
  for (const rb of welcome.redirectButtons) {
    rows.push([styledUrlButton(rb.label, rb.url)]);
  }
  if (welcome.miniAppEnabled && welcome.miniAppUrl) {
    rows.push([Markup.button.url("Abrir", welcome.miniAppUrl)]);
  }

  return rows.length > 0 ? Markup.inlineKeyboard(rows) : undefined;
}

async function renderWelcome(
  ctx: Context,
  botRow: Bot,
  lead: Lead,
  welcome: WelcomeWithRelations,
  plans: Plan[],
  packConfig: PackConfig | null,
  packs: Plan[]
): Promise<void> {
  const prepared = prepareRichText(welcome.text, { lead, bot: botRow });
  const keyboard = buildWelcomeKeyboard(welcome, plans, packConfig, packs);
  const replyMarkup = keyboard?.reply_markup;
  const media = welcome.media.slice(0, 3);
  // Legenda na própria mídia só quando faz sentido (1 mídia só, sem pedir
  // mensagem separada) — grupo de mídia (>1) não aceita reply_markup nem
  // parse_mode por item de forma confiável, então nesse caso o texto+botões
  // sempre vão numa mensagem à parte.
  const useCaption = media.length === 1 && !welcome.secondaryMessageEnabled;

  try {
    if (media.length === 1) {
      const m = media[0];
      const opts = useCaption
        ? ({
            caption: prepared.text || undefined,
            parse_mode: "HTML" as const,
            reply_markup: replyMarkup,
            message_effect_id: prepared.effectId,
          } as never)
        : {};
      let sent;
      switch (m.mediaType) {
        case "PHOTO":
          sent = await ctx.replyWithPhoto(m.fileId, opts);
          break;
        case "VIDEO":
          sent = await ctx.replyWithVideo(m.fileId, opts);
          break;
        case "AUDIO":
          sent = await ctx.replyWithAudio(m.fileId, opts);
          break;
        case "DOCUMENT":
          sent = await ctx.replyWithDocument(m.fileId, opts);
          break;
      }
      if (useCaption) {
        if (sent && ctx.chat) {
          await registerCountdownIfNeeded(prepared, { botId: botRow.id, chatId: ctx.chat.id, messageId: sent.message_id });
        }
        return;
      }
    } else if (media.length > 1) {
      await ctx.replyWithMediaGroup(
        media.map((m) => ({
          type: m.mediaType.toLowerCase() as "photo" | "video",
          media: m.fileId,
        }))
      );
    }
  } catch (err) {
    console.error("[flows] falha ao enviar mídia de boas-vindas, seguindo com o texto", err);
  }

  const sentText = await ctx.reply(
    prepared.text || "​",
    { parse_mode: "HTML", reply_markup: replyMarkup, message_effect_id: prepared.effectId } as never
  );
  if (ctx.chat) {
    await registerCountdownIfNeeded(prepared, { botId: botRow.id, chatId: ctx.chat.id, messageId: sentText.message_id });
  }
}

function buildPlansKeyboard(plans: Plan[]) {
  return Markup.inlineKeyboard(
    plans.map((p) => [
      Markup.button.callback(`${p.name} — ${formatBRL(p.priceCents)}`, `${PLAN_CALLBACK_PREFIX}${p.id}`),
    ])
  );
}

function formatBRL(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

const DATA_URI_PREFIX = /^data:image\/[a-zA-Z0-9.+-]+;base64,/;

// A SyncPay devolve o QR code como imagem base64 (src/payments/syncpay.ts
// converte pra data URI); `replyWithPhoto` do Telegraf não aceita uma string
// `data:` — só file_id, URL http(s), ou `{ source: Buffer }`. Decodifica o
// base64 pra Buffer quando for o caso.
function buildPhotoInput(qrCodeUrl: string): string | { source: Buffer } {
  const match = qrCodeUrl.match(DATA_URI_PREFIX);
  if (!match) return qrCodeUrl;
  const base64 = qrCodeUrl.slice(match[0].length);
  return { source: Buffer.from(base64, "base64") };
}

/**
 * Gera a cobrança PIX pra 1+ itens (Plano base + Order Bumps marcados, ou
 * um Upsell/Downsell isolado) e manda pro comprador. Reaproveita o preview
 * (`pixGeneratedMessage`) do funil do plano BASE — ou do primeiro item, se
 * não houver BASE (caso de Upsell/Downsell gerando seu próprio PIX à parte).
 */
async function handleBuyItems(ctx: Context, botId: string, lead: Lead, items: OrderItemInput[]): Promise<void> {
  try {
    const { order, pixCopyPaste, qrCodeUrl } = await createOrderAndCharge({
      botId,
      leadId: lead.id,
      items,
      originId: lead.originId,
    });

    const primaryPlanId = items.find((i) => (i.kind ?? "BASE") === "BASE")?.planId ?? items[0].planId;
    const plan = await prisma.plan.findUnique({
      where: { id: primaryPlanId },
      include: { flow: { include: { paymentMessages: true } } },
    });
    if (plan) {
      try {
        await scheduleDownsellForOrder(botId, lead.id, order.id, plan.flowId);
      } catch (err) {
        console.error("[flows] falha ao agendar downsell de PIX gerado", err);
      }
    }

    const botRow = await prisma.bot.findUniqueOrThrow({ where: { id: botId } });
    const template = plan?.flow.paymentMessages?.pixGeneratedMessage;
    const prepared: PreparedText = template
      ? prepareRichText(template, { lead, bot: botRow, extra: { valor: formatBRL(order.amountCents), plano: plan?.name ?? "" } })
      : { text: "Pagamento gerado! Copie o código PIX abaixo e cole no app do seu banco:" };

    const sentIntro = await ctx.reply(prepared.text, { parse_mode: "HTML", message_effect_id: prepared.effectId } as never);
    if (ctx.chat) {
      await registerCountdownIfNeeded(prepared, { botId, chatId: ctx.chat.id, messageId: sentIntro.message_id });
    }
    // O código copia-e-cola sempre vai numa mensagem própria, sem depender
    // do texto customizado mencionar {qr_code}/etc — se o admin esquecer de
    // incluir alguma referência, o comprador ainda assim recebe o código.
    await ctx.reply(pixCopyPaste);

    if (qrCodeUrl) {
      try {
        await ctx.replyWithPhoto(buildPhotoInput(qrCodeUrl), {
          caption: "Ou escaneie o QR Code para pagar.",
        });
      } catch (err) {
        console.error("[flows] falha ao enviar QR code como imagem", err);
        if (!DATA_URI_PREFIX.test(qrCodeUrl)) {
          await ctx.reply(`QR Code: ${qrCodeUrl}`);
        }
      }
    }
  } catch (err) {
    console.error("[flows] falha ao gerar cobrança", err);
    await ctx.reply("Pagamento temporariamente indisponível. Tente novamente em instantes.");
  }
}

// --- Order Bump (aceita/recusa um de cada vez, antes do PIX) ---
//
// Cada bump é mostrado como oferta própria (mesmo texto+botões de
// aceitar/recusar do Upsell/Downsell), um de cada vez — clicar em
// qualquer um dos dois botões já avança pro próximo bump da fila, ou gera
// o PIX se não houver mais nenhum. callback_data do Telegram tem limite de
// 64 bytes, então em vez de carregar a lista de bumps já aceitos por id
// (cuid tem 25 chars — não cabe mais de um), cada bump ganha um ÍNDICE
// posicional (0, 1, 2...) na lista ordenada de Offers daquele
// plano-gatilho, e "quais foram aceitos até agora" vira um bitmask (int)
// embutido no próprio callback_data: `bmpA:<planId>:<bitmask>:<índice>` =
// aceita o bump `índice` (liga o bit correspondente); `bmpD:...` = recusa
// (bitmask não muda). Os dois avançam pro `índice + 1`.

function buildBumpStepKeyboard(offer: Offer, planId: string, bitmask: number, index: number) {
  const acceptLabel = offer.acceptLabel || defaultAcceptLabel(offer.kind);
  const declineLabel = offer.declineLabel || defaultDeclineLabel();
  return Markup.inlineKeyboard([
    [styledCallbackButton(acceptLabel, `${BUMP_ACCEPT_PREFIX}${planId}:${bitmask}:${index}`)],
    [styledCallbackButton(declineLabel, `${BUMP_DECLINE_PREFIX}${planId}:${bitmask}:${index}`)],
  ]);
}

function getCallbackData(ctx: Context): string | undefined {
  const cq = ctx.callbackQuery;
  return cq && "data" in cq ? cq.data : undefined;
}

export interface BumpCallback {
  planId: string;
  bitmask: number;
  index: number;
}

export function parseBumpCallback(data: string, prefix: string): BumpCallback | null {
  const [planId, bitmaskStr, indexStr] = data.slice(prefix.length).split(":");
  const bitmask = Number(bitmaskStr);
  const index = Number(indexStr);
  if (!planId || !Number.isFinite(bitmask) || !Number.isFinite(index)) return null;
  return { planId, bitmask, index };
}

async function loadOrderBumpOffers(planId: string) {
  return prisma.offer.findMany({
    where: { kind: "ORDER_BUMP", triggerPlanId: planId, active: true },
    orderBy: { order: "asc" },
    include: { offeredPlan: true },
  });
}

/**
 * Mostra o próximo Order Bump da fila (posição `index`) pro plano-gatilho
 * — ou, se não houver mais nenhum, gera a cobrança com o plano base + todos
 * os bumps aceitos até agora (marcados no `bitmask`).
 */
async function advanceOrderBumpFlow(
  ctx: Context,
  botId: string,
  lead: Lead,
  planId: string,
  bitmask: number,
  index: number
): Promise<void> {
  const bumpOffers = await loadOrderBumpOffers(planId);

  if (index >= bumpOffers.length) {
    const items: OrderItemInput[] = [{ planId, kind: "BASE" }];
    bumpOffers.forEach((offer, i) => {
      if (bitmask & (1 << i)) items.push({ planId: offer.offeredPlanId, kind: "ORDER_BUMP" });
    });
    await handleBuyItems(ctx, botId, lead, items);
    return;
  }

  const offer = bumpOffers[index];
  const botRow = await prisma.bot.findUniqueOrThrow({ where: { id: botId } });
  const prepared = prepareRichText(offerRawTemplate(offer, offer.offeredPlan), {
    lead,
    bot: botRow,
    extra: offerExtraVars(offer.offeredPlan),
  });
  const sent = await ctx.reply(prepared.text, {
    parse_mode: "HTML",
    reply_markup: buildBumpStepKeyboard(offer, planId, bitmask, index).reply_markup,
    message_effect_id: prepared.effectId,
  } as never);
  if (ctx.chat) {
    await registerCountdownIfNeeded(prepared, { botId, chatId: ctx.chat.id, messageId: sent.message_id });
  }
}

/**
 * Botão de compra de uma oferta de Downsell (src/bot/downsellScheduler.ts
 * monta o botão) — gera o PIX direto com o desconto da sequência aplicado
 * ao Plan escolhido, sem passar pela fila de Order Bump (a intenção do
 * Downsell é recuperar a venda a um preço menor, não empurrar mais itens).
 */
async function handleDownsellPurchase(
  ctx: Context,
  botId: string,
  lead: Lead,
  sequenceId: string,
  planId: string
): Promise<void> {
  const sequence = await prisma.downsellSequence.findUnique({ where: { id: sequenceId } });
  const plan = await prisma.plan.findUnique({ where: { id: planId } });
  if (!sequence || !plan) return;

  const unitPriceCentsOverride = applyDiscount(plan.priceCents, sequence.discountType, sequence.discountValue);
  await handleBuyItems(ctx, botId, lead, [{ planId, kind: "DOWNSELL", unitPriceCentsOverride }]);
}

export function registerFlowHandlers(bot: Telegraf, botId: string): void {
  bot.start(async (ctx) => {
    const result = await resolveOriginAndUpsertLead(ctx, botId, ctx.startPayload);
    if (!result) return;

    const flow = await getFlowForBot(botId);
    if (!flow || !flow.welcomeConfig) {
      await ctx.reply(
        "Olá! Ainda não configurei minhas mensagens de boas-vindas. Tente novamente em breve."
      );
      return;
    }

    if (result.isNewLead) {
      try {
        await scheduleGeneralDownsell(botId, result.lead.id, flow.id);
      } catch (err) {
        console.error("[flows] falha ao agendar downsell geral", err);
      }
    }

    const botRow = await prisma.bot.findUniqueOrThrow({ where: { id: botId } });
    // Sem CTA, os botões de plano já saem direto na própria mensagem de
    // boas-vindas (ver buildWelcomeKeyboard) — não precisa de um passo à
    // parte pro lead ver os planos.
    await renderWelcome(ctx, botRow, result.lead, flow.welcomeConfig, flow.plans, flow.packConfig, flow.packs);
  });

  bot.action(CTA_CALLBACK, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const lead = await touchLead(ctx, botId);
    if (!lead) return;

    const flow = await getFlowForBot(botId);
    if (!flow || flow.plans.length === 0) {
      await ctx.reply("Nenhum plano disponível no momento.");
      return;
    }
    await ctx.reply("Escolha um plano:", { reply_markup: buildPlansKeyboard(flow.plans).reply_markup });
  });

  // --- Packs (conteúdo avulso, Fase 2 Milestone 8) ---

  bot.action(PACKS_CALLBACK, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const lead = await touchLead(ctx, botId);
    if (!lead) return;

    const flow = await getFlowForBot(botId);
    if (!flow || flow.packs.length === 0) {
      await ctx.reply("Nenhum pack disponível no momento.");
      return;
    }
    const headerText = flow.packConfig?.headerMessage || "Veja abaixo os packs que você pode adquirir:";
    const keyboard = Markup.inlineKeyboard(
      flow.packs.map((p) => [Markup.button.callback(`${p.name} — ${formatBRL(p.priceCents)}`, `${PACK_DETAIL_PREFIX}${p.id}`)])
    );
    await ctx.reply(headerText, { reply_markup: keyboard.reply_markup });
  });

  bot.action(new RegExp(`^${PACK_DETAIL_PREFIX}.+`), async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const data = getCallbackData(ctx);
    const packId = data?.startsWith(PACK_DETAIL_PREFIX) ? data.slice(PACK_DETAIL_PREFIX.length) : null;
    if (!packId) return;

    const pack = await prisma.plan.findUnique({
      where: { id: packId },
      include: { previewMedia: { orderBy: { order: "asc" } } },
    });
    if (!pack || pack.productType !== "PACK") return;

    const buyKeyboard = Markup.inlineKeyboard([
      [Markup.button.callback(`🛒 Comprar — ${formatBRL(pack.priceCents)}`, `${PLAN_CALLBACK_PREFIX}${pack.id}`)],
    ]);

    const media = pack.previewMedia.slice(0, 3);
    try {
      if (media.length === 1) {
        const m = media[0];
        const opts = { caption: pack.description || undefined, reply_markup: buyKeyboard.reply_markup };
        switch (m.mediaType) {
          case "PHOTO":
            await ctx.replyWithPhoto(m.fileId, opts);
            return;
          case "VIDEO":
            await ctx.replyWithVideo(m.fileId, opts);
            return;
          case "AUDIO":
            await ctx.replyWithAudio(m.fileId, opts);
            return;
          case "DOCUMENT":
            await ctx.replyWithDocument(m.fileId, opts);
            return;
        }
      } else if (media.length > 1) {
        await ctx.replyWithMediaGroup(
          media.map((m) => ({ type: m.mediaType.toLowerCase() as "photo" | "video", media: m.fileId }))
        );
      }
    } catch (err) {
      console.error(`[flows] falha ao enviar mídia de preview do pack ${packId}, seguindo com o texto`, err);
    }

    await ctx.reply(pack.description || pack.name, { reply_markup: buyKeyboard.reply_markup });
  });

  bot.action(new RegExp(`^${PLAN_CALLBACK_PREFIX}.+`), async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const data = getCallbackData(ctx);
    const planId = data?.startsWith(PLAN_CALLBACK_PREFIX) ? data.slice(PLAN_CALLBACK_PREFIX.length) : null;
    if (!planId) return;

    const lead = await touchLead(ctx, botId);
    if (!lead) return;

    await advanceOrderBumpFlow(ctx, botId, lead, planId, 0, 0);
  });

  bot.action(new RegExp(`^${BUMP_ACCEPT_PREFIX}.+`), async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const data = getCallbackData(ctx);
    const parsed = data ? parseBumpCallback(data, BUMP_ACCEPT_PREFIX) : null;
    if (!parsed) return;

    const lead = await touchLead(ctx, botId);
    if (!lead) return;

    const newBitmask = parsed.bitmask | (1 << parsed.index);
    await advanceOrderBumpFlow(ctx, botId, lead, parsed.planId, newBitmask, parsed.index + 1);
  });

  bot.action(new RegExp(`^${BUMP_DECLINE_PREFIX}.+`), async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const data = getCallbackData(ctx);
    const parsed = data ? parseBumpCallback(data, BUMP_DECLINE_PREFIX) : null;
    if (!parsed) return;

    const lead = await touchLead(ctx, botId);
    if (!lead) return;

    await advanceOrderBumpFlow(ctx, botId, lead, parsed.planId, parsed.bitmask, parsed.index + 1);
  });

  bot.action(new RegExp(`^${DOWNSELL_BUY_PREFIX}.+`), async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const data = getCallbackData(ctx);
    const parsed = data ? parseDownsellBuyCallback(data) : null;
    if (!parsed) return;

    const lead = await touchLead(ctx, botId);
    if (!lead) return;

    await handleDownsellPurchase(ctx, botId, lead, parsed.sequenceId, parsed.planId);
  });
}
