import { Markup, type Telegraf, type Context } from "telegraf";
import type { InlineKeyboardButton } from "telegraf/types";
import type { Lead, Plan, WelcomeConfig, WelcomeMedia, RedirectButton, Bot, OrderItemKind } from "@prisma/client";
import { prisma } from "../db/client.js";
import { createOrderAndCharge, type OrderItemInput } from "../payments/orders.js";
import { resolveOriginAndUpsertLead, touchLead } from "./deepLink.js";
import { renderTemplate } from "./templating.js";
import { buildOfferKeyboard, buildOfferText, parseOfferAcceptId, parseOfferDeclineId } from "./offerMessage.js";

type WelcomeWithRelations = WelcomeConfig & { media: WelcomeMedia[]; redirectButtons: RedirectButton[] };

const CTA_CALLBACK = "cta";
const PLAN_CALLBACK_PREFIX = "plan:";
export const BUMP_TOGGLE_PREFIX = "bmp:";
export const BUMP_CONFIRM_PREFIX = "bmpgo:";
const OFFER_ACCEPT_PREFIX = "ofYes:";
const OFFER_DECLINE_PREFIX = "ofNo:";

async function getFlowForBot(botId: string) {
  const flowBot = await prisma.flowBot.findFirst({
    where: { botId },
    include: {
      flow: {
        include: {
          welcomeConfig: { include: { media: true, redirectButtons: true } },
          plans: { where: { active: true }, orderBy: { order: "asc" } },
        },
      },
    },
  });
  return flowBot?.flow ?? null;
}

function buildWelcomeKeyboard(welcome: WelcomeWithRelations, hasPlans: boolean) {
  const rows: InlineKeyboardButton[][] = [];

  if (welcome.ctaButtonEnabled && hasPlans) {
    rows.push([Markup.button.callback(welcome.ctaLabel || "Ver planos", CTA_CALLBACK)]);
  }
  for (const rb of welcome.redirectButtons) {
    rows.push([Markup.button.url(rb.label, rb.url)]);
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
  hasPlans: boolean
): Promise<void> {
  const text = welcome.text ? renderTemplate(welcome.text, { lead, bot: botRow }) : "";
  const keyboard = buildWelcomeKeyboard(welcome, hasPlans);
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
        ? { caption: text || undefined, parse_mode: "HTML" as const, reply_markup: replyMarkup }
        : {};
      switch (m.mediaType) {
        case "PHOTO":
          await ctx.replyWithPhoto(m.fileId, opts);
          break;
        case "VIDEO":
          await ctx.replyWithVideo(m.fileId, opts);
          break;
        case "AUDIO":
          await ctx.replyWithAudio(m.fileId, opts);
          break;
        case "DOCUMENT":
          await ctx.replyWithDocument(m.fileId, opts);
          break;
      }
      if (useCaption) return;
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

  await ctx.reply(text || "​", { parse_mode: "HTML", reply_markup: replyMarkup });
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
    const botRow = await prisma.bot.findUniqueOrThrow({ where: { id: botId } });
    const template = plan?.flow.paymentMessages?.pixGeneratedMessage;
    const introText = template
      ? renderTemplate(template, {
          lead,
          bot: botRow,
          extra: { valor: formatBRL(order.amountCents), plano: plan?.name ?? "" },
        })
      : "Pagamento gerado! Copie o código PIX abaixo e cole no app do seu banco:";

    await ctx.reply(introText, { parse_mode: "HTML" });
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

// --- Order Bump (tela de confirmação antes do PIX) ---
//
// callback_data do Telegram tem limite de 64 bytes, então em vez de
// carregar a lista de bumps selecionados por id (cuid tem 25 chars — não
// cabe mais de um), cada bump ganha um ÍNDICE posicional (0, 1, 2...) na
// lista ordenada de Offers daquele plano-gatilho, e o estado "quais estão
// marcados" vira um bitmask (int) embutido no próprio callback_data.
// `bmp:<planId>:<bitmask>:<índice>` = alterna o bit `índice`;
// `bmpgo:<planId>:<bitmask>` = confirma a compra com os bits marcados.

function buildOrderBumpKeyboard(planId: string, bumpPlans: Plan[], bitmask: number) {
  const rows: InlineKeyboardButton[][] = bumpPlans.map((bump, i) => {
    const checked = (bitmask & (1 << i)) !== 0;
    const label = `${checked ? "☑" : "☐"} ${bump.name} — +${formatBRL(bump.priceCents)}`;
    return [Markup.button.callback(label, `${BUMP_TOGGLE_PREFIX}${planId}:${bitmask}:${i}`)];
  });
  rows.push([Markup.button.callback("Confirmar compra", `${BUMP_CONFIRM_PREFIX}${planId}:${bitmask}`)]);
  return Markup.inlineKeyboard(rows);
}

function buildOrderBumpText(plan: Plan): string {
  return `Você escolheu: ${plan.name} — ${formatBRL(plan.priceCents)}\n\nQuer adicionar algo antes de pagar?`;
}

function getCallbackData(ctx: Context): string | undefined {
  const cq = ctx.callbackQuery;
  return cq && "data" in cq ? cq.data : undefined;
}

export interface BumpCallback {
  planId: string;
  bitmask: number;
  index?: number;
}

export function parseBumpCallback(data: string, prefix: string): BumpCallback | null {
  const [planId, bitmaskStr, indexStr] = data.slice(prefix.length).split(":");
  const bitmask = Number(bitmaskStr);
  if (!planId || !Number.isFinite(bitmask)) return null;
  if (indexStr === undefined) return { planId, bitmask };
  const index = Number(indexStr);
  if (!Number.isFinite(index)) return null;
  return { planId, bitmask, index };
}

async function loadOrderBumpOffers(planId: string) {
  return prisma.offer.findMany({
    where: { kind: "ORDER_BUMP", triggerPlanId: planId, active: true },
    orderBy: { order: "asc" },
    include: { offeredPlan: true },
  });
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

    const botRow = await prisma.bot.findUniqueOrThrow({ where: { id: botId } });
    await renderWelcome(ctx, botRow, result.lead, flow.welcomeConfig, flow.plans.length > 0);
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

  bot.action(new RegExp(`^${PLAN_CALLBACK_PREFIX}.+`), async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const data = getCallbackData(ctx);
    const planId = data?.startsWith(PLAN_CALLBACK_PREFIX) ? data.slice(PLAN_CALLBACK_PREFIX.length) : null;
    if (!planId) return;

    const lead = await touchLead(ctx, botId);
    if (!lead) return;

    const bumpOffers = await loadOrderBumpOffers(planId);
    if (bumpOffers.length === 0) {
      await handleBuyItems(ctx, botId, lead, [{ planId, kind: "BASE" }]);
      return;
    }

    const plan = await prisma.plan.findUnique({ where: { id: planId } });
    if (!plan) return;

    const bumpPlans = bumpOffers.map((o) => o.offeredPlan);
    await ctx.reply(buildOrderBumpText(plan), {
      reply_markup: buildOrderBumpKeyboard(planId, bumpPlans, 0).reply_markup,
    });
  });

  bot.action(new RegExp(`^${BUMP_TOGGLE_PREFIX}.+`), async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const data = getCallbackData(ctx);
    const parsed = data ? parseBumpCallback(data, BUMP_TOGGLE_PREFIX) : null;
    if (!parsed || parsed.index === undefined) return;

    const bumpOffers = await loadOrderBumpOffers(parsed.planId);
    const bumpPlans = bumpOffers.map((o) => o.offeredPlan);
    const newBitmask = parsed.bitmask ^ (1 << parsed.index);

    try {
      await ctx.editMessageReplyMarkup(buildOrderBumpKeyboard(parsed.planId, bumpPlans, newBitmask).reply_markup);
    } catch (err) {
      console.error("[flows] falha ao atualizar teclado de order bump", err);
    }
  });

  bot.action(new RegExp(`^${BUMP_CONFIRM_PREFIX}.+`), async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const data = getCallbackData(ctx);
    const parsed = data ? parseBumpCallback(data, BUMP_CONFIRM_PREFIX) : null;
    if (!parsed) return;

    const lead = await touchLead(ctx, botId);
    if (!lead) return;

    const bumpOffers = await loadOrderBumpOffers(parsed.planId);
    const items: OrderItemInput[] = [{ planId: parsed.planId, kind: "BASE" }];
    bumpOffers.forEach((offer, i) => {
      if (parsed.bitmask & (1 << i)) {
        items.push({ planId: offer.offeredPlanId, kind: "ORDER_BUMP" });
      }
    });

    await handleBuyItems(ctx, botId, lead, items);
  });

  bot.action(new RegExp(`^${OFFER_ACCEPT_PREFIX}.+`), async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const data = getCallbackData(ctx);
    const offerId = data ? parseOfferAcceptId(data) : null;
    if (!offerId) return;

    const offer = await prisma.offer.findUnique({ where: { id: offerId } });
    if (!offer || !offer.active) {
      await ctx.reply("Essa oferta não está mais disponível.");
      return;
    }

    const lead = await touchLead(ctx, botId);
    if (!lead) return;

    const kind: OrderItemKind = offer.kind === "DOWNSELL" ? "DOWNSELL" : "UPSELL";
    await handleBuyItems(ctx, botId, lead, [{ planId: offer.offeredPlanId, kind }]);
  });

  bot.action(new RegExp(`^${OFFER_DECLINE_PREFIX}.+`), async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const data = getCallbackData(ctx);
    const offerId = data ? parseOfferDeclineId(data) : null;
    if (!offerId) return;

    // Downsell encadeado só existe pra recusa de Upsell (não pra recusa de
    // Downsell — evita corrente infinita de ofertas).
    const offer = await prisma.offer.findUnique({ where: { id: offerId } });
    if (offer?.kind === "UPSELL") {
      const downsell = await prisma.offer.findFirst({
        where: { kind: "DOWNSELL", parentOfferId: offer.id, active: true },
        include: { offeredPlan: true },
      });
      if (downsell) {
        const lead = await touchLead(ctx, botId);
        if (lead) {
          const botRow = await prisma.bot.findUniqueOrThrow({ where: { id: botId } });
          const text = buildOfferText(downsell, downsell.offeredPlan, lead, botRow);
          await ctx.reply(text, {
            parse_mode: "HTML",
            reply_markup: buildOfferKeyboard(downsell.id).reply_markup,
          });
        }
        return;
      }
    }

    await ctx.reply("Sem problemas!");
  });
}
