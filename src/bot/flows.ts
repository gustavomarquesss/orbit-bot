import { Markup, type Telegraf, type Context } from "telegraf";
import type { InlineKeyboardButton } from "telegraf/types";
import type { Lead, Plan, WelcomeConfig, WelcomeMedia, RedirectButton, Bot } from "@prisma/client";
import { prisma } from "../db/client.js";
import { createOrderAndCharge } from "../payments/orders.js";
import { resolveOriginAndUpsertLead, touchLead } from "./deepLink.js";
import { renderTemplate } from "./templating.js";

type WelcomeWithRelations = WelcomeConfig & { media: WelcomeMedia[]; redirectButtons: RedirectButton[] };

const CTA_CALLBACK = "cta";
const PLAN_CALLBACK_PREFIX = "plan:";

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

async function handleBuyPlan(ctx: Context, botId: string, lead: Lead, planId: string): Promise<void> {
  try {
    const { pixCopyPaste, qrCodeUrl } = await createOrderAndCharge({
      botId,
      leadId: lead.id,
      planId,
      originId: lead.originId,
    });

    await ctx.reply(
      `Pagamento gerado! Copie o código PIX abaixo e cole no app do seu banco:\n\n${pixCopyPaste}`
    );

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
    const callbackQuery = ctx.callbackQuery;
    const data = callbackQuery && "data" in callbackQuery ? callbackQuery.data : undefined;
    const planId = data?.startsWith(PLAN_CALLBACK_PREFIX) ? data.slice(PLAN_CALLBACK_PREFIX.length) : null;
    if (!planId) return;

    const lead = await touchLead(ctx, botId);
    if (!lead) return;

    await handleBuyPlan(ctx, botId, lead, planId);
  });
}
