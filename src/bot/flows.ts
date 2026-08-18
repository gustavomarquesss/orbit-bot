import { Markup, type Telegraf, type Context } from "telegraf";
import type { Button, FlowStep, Lead } from "@prisma/client";
import { prisma } from "../db/client.js";
import { createOrderAndCharge } from "../payments/orders.js";
import { resolveOriginAndUpsertLead, touchLead } from "./deepLink.js";
import { buildButtonCallbackData, parseButtonCallbackData } from "./util.js";

async function getEntryFlow() {
  return prisma.flow.findFirst({
    where: { isEntryPoint: true },
    orderBy: { createdAt: "asc" },
  });
}

async function getFlowByKey(key: string) {
  return prisma.flow.findUnique({ where: { key } });
}

type StepWithButtons = FlowStep & { buttons: Button[] };

async function getFirstStep(flowId: string): Promise<StepWithButtons | null> {
  return prisma.flowStep.findFirst({
    where: { flowId },
    orderBy: { order: "asc" },
    include: { buttons: { orderBy: { order: "asc" } } },
  });
}

async function upsertFlowExecution(leadId: string, flowId: string, currentStep: number) {
  const existing = await prisma.flowExecution.findFirst({ where: { leadId, flowId } });
  if (existing) {
    return prisma.flowExecution.update({
      where: { id: existing.id },
      data: { currentStep },
    });
  }
  return prisma.flowExecution.create({ data: { leadId, flowId, currentStep } });
}

function buildKeyboard(buttons: Button[]) {
  if (buttons.length === 0) return undefined;

  const rows = buttons.map((button) => {
    if (button.action === "OPEN_LINK" || button.action === "REDIRECT_CHANNEL") {
      return [Markup.button.url(button.label, button.url ?? "https://t.me")];
    }
    return [Markup.button.callback(button.label, buildButtonCallbackData(button.id))];
  });

  return Markup.inlineKeyboard(rows);
}

async function renderStep(ctx: Context, step: StepWithButtons): Promise<void> {
  const keyboard = buildKeyboard(step.buttons);
  const replyMarkup = keyboard?.reply_markup;
  const caption = step.text ?? undefined;

  try {
    if (step.mediaType !== "NONE" && step.mediaFileId) {
      switch (step.mediaType) {
        case "PHOTO":
          await ctx.replyWithPhoto(step.mediaFileId, { caption, reply_markup: replyMarkup });
          return;
        case "VIDEO":
          await ctx.replyWithVideo(step.mediaFileId, { caption, reply_markup: replyMarkup });
          return;
        case "AUDIO":
          await ctx.replyWithAudio(step.mediaFileId, { caption, reply_markup: replyMarkup });
          return;
        case "DOCUMENT":
          await ctx.replyWithDocument(step.mediaFileId, { caption, reply_markup: replyMarkup });
          return;
      }
    }
  } catch (err) {
    console.error(`[flows] falha ao enviar mídia do step ${step.id}, caindo para texto`, err);
  }

  const text = step.text?.trim();
  if (!text) {
    console.warn(`[flows] step ${step.id} não tem texto nem mídia utilizável`);
    if (!replyMarkup) return;
  }
  await ctx.reply(text || "​", { reply_markup: replyMarkup });
}

async function startFlow(ctx: Context, leadId: string, flowId: string, flowKey: string): Promise<void> {
  const firstStep = await getFirstStep(flowId);
  if (!firstStep) {
    console.warn(`[flows] flow "${flowKey}" não tem nenhum FlowStep configurado`);
    await ctx.reply("Esse fluxo ainda está sendo configurado. Volte em breve.");
    return;
  }
  await upsertFlowExecution(leadId, flowId, firstStep.order);
  await renderStep(ctx, firstStep);
}

async function handleGotoFlow(ctx: Context, lead: Lead, button: Button): Promise<void> {
  if (!button.targetFlowKey) {
    await ctx.reply("Esse botão não tem um destino configurado.");
    return;
  }
  const targetFlow = await getFlowByKey(button.targetFlowKey);
  if (!targetFlow) {
    console.warn(`[flows] botão ${button.id} aponta para flow inexistente "${button.targetFlowKey}"`);
    await ctx.reply("Esse destino não está mais disponível.");
    return;
  }
  await startFlow(ctx, lead.id, targetFlow.id, targetFlow.key);
}

const DATA_URI_PREFIX = /^data:image\/[a-zA-Z0-9.+-]+;base64,/;

// A SyncPay devolve o QR code como imagem base64 (src/payments/syncpay.ts
// converte pra data URI); `replyWithPhoto` do Telegraf não aceita uma string
// `data:` — só file_id, URL http(s), ou `{ source: Buffer }`. Decodifica o
// base64 pra Buffer quando for o caso; se um dia vier uma URL http(s) de
// verdade, passa direto.
function buildPhotoInput(qrCodeUrl: string): string | { source: Buffer } {
  const match = qrCodeUrl.match(DATA_URI_PREFIX);
  if (!match) return qrCodeUrl;
  const base64 = qrCodeUrl.slice(match[0].length);
  return { source: Buffer.from(base64, "base64") };
}

async function handleBuyProduct(ctx: Context, lead: Lead, button: Button): Promise<void> {
  if (!button.productId) {
    await ctx.reply("Esse botão não tem um produto configurado.");
    return;
  }

  try {
    const { pixCopyPaste, qrCodeUrl } = await createOrderAndCharge({
      leadId: lead.id,
      productId: button.productId,
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
    // Esperado até feature/pagamento-pix ser mesclada: createOrderAndCharge
    // é um stub que sempre lança "implementação pendente".
    console.error("[flows] falha ao gerar cobrança", err);
    await ctx.reply("Pagamento temporariamente indisponível. Tente novamente em instantes.");
  }
}

export function registerFlowHandlers(bot: Telegraf): void {
  bot.start(async (ctx) => {
    const result = await resolveOriginAndUpsertLead(ctx, ctx.startPayload);
    if (!result) return;

    const entryFlow = await getEntryFlow();
    if (!entryFlow) {
      console.warn("[flows] nenhum Flow com isEntryPoint=true configurado");
      await ctx.reply(
        "Olá! Ainda não configurei minhas mensagens de boas-vindas. Tente novamente em breve."
      );
      return;
    }

    await startFlow(ctx, result.lead.id, entryFlow.id, entryFlow.key);
  });

  bot.action(/^btn:.+/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});

    const callbackQuery = ctx.callbackQuery;
    const data = callbackQuery && "data" in callbackQuery ? callbackQuery.data : undefined;
    const buttonId = data ? parseButtonCallbackData(data) : null;
    if (!buttonId) return;

    const lead = await touchLead(ctx);
    if (!lead) return;

    const button = await prisma.button.findUnique({ where: { id: buttonId } });
    if (!button) {
      await ctx.reply("Esse botão não existe mais.");
      return;
    }

    switch (button.action) {
      case "GOTO_FLOW":
        await handleGotoFlow(ctx, lead, button);
        break;
      case "BUY_PRODUCT":
        await handleBuyProduct(ctx, lead, button);
        break;
      default:
        // OPEN_LINK / REDIRECT_CHANNEL são botões `url` nativos do Telegram —
        // o clique é tratado pelo próprio cliente Telegram, nunca chega aqui.
        break;
    }
  });
}
