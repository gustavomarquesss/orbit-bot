import { Markup, type Telegraf, type Context } from "telegraf";
import type { InlineKeyboardButton } from "telegraf/types";
import type {
  Lead,
  Offer,
  Plan,
  WelcomeConfig,
  WelcomeMedia,
  RedirectButton,
  Bot,
  PackConfig,
  PreviewConfig,
  PreviewMedia,
  PaymentGeneratedMedia,
  SocialProofMessage,
  PaymentButtonStyle,
  PixCodeFormat,
} from "@prisma/client";
import { prisma } from "../db/client.js";
import { createOrderAndCharge, type OrderItemInput } from "../payments/orders.js";
import { resolveOriginAndUpsertLead, touchLead } from "./deepLink.js";
import { prepareRichText, registerCountdownIfNeeded, styledCallbackButton, styledUrlButton, type PreparedText } from "./richSend.js";
import { offerRawTemplate, offerExtraVars, defaultAcceptLabel, defaultDeclineLabel } from "./offerMessage.js";
import { applyDiscount, parseDownsellBuyCallback, DOWNSELL_BUY_PREFIX } from "./downsellMessage.js";
import { scheduleGeneralDownsell, scheduleDownsellForOrder } from "./downsellScheduler.js";
import { registerSocialProof } from "./socialProofScheduler.js";
// `checkOrderStatusNow` (payments/reconciliation.js) e `resolveEffectiveDelivery`/
// `deliverPlanToLead` (./delivery.js) são importados dinamicamente onde são
// usados (ver handlers pmCheck:/pmAccess: abaixo) — um import estático aqui
// fecharia um ciclo real (delivery.js -> botManager.js -> flows.js), que
// funciona em runtime (as chamadas só acontecem depois de tudo inicializado)
// mas quebra o `importOriginal()` do vi.mock nos testes de pagamento.

type WelcomeWithRelations = WelcomeConfig & { media: WelcomeMedia[]; redirectButtons: RedirectButton[] };

const CTA_CALLBACK = "cta";
/** Também usado pelos botões BUY_PLAN do Upsell (src/bot/upsellScheduler.ts) — reaproveita este mesmo handler. */
export const PLAN_CALLBACK_PREFIX = "plan:";
export const BUMP_ACCEPT_PREFIX = "bmpA:";
export const BUMP_DECLINE_PREFIX = "bmpD:";
/** Fase 2, Milestone 8 — Packs. */
const PACKS_CALLBACK = "packs";
const PACK_DETAIL_PREFIX = "packDetail:";
/** Fase 2, Milestone 9 — Prévias que somem. */
const PREVIEW_CALLBACK = "preview";
/** Fase 2, Milestone 10 — botões da seção Pagamentos redesenhada. */
const CHECK_STATUS_PREFIX = "pmCheck:";
const COPY_CODE_PREFIX = "pmCopy:";
const ACCESS_CONTENT_PREFIX = "pmAccess:";

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
          previewConfig: { include: { media: { orderBy: { order: "asc" } } } },
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

type PreviewConfigWithMedia = PreviewConfig & { media: PreviewMedia[] };

function buildWelcomeKeyboard(
  welcome: WelcomeWithRelations,
  plans: Plan[],
  packConfig: PackConfig | null,
  packs: Plan[],
  previewConfig: PreviewConfigWithMedia | null,
  previewAlreadyUsed: boolean
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
  // Botão de Prévias (Fase 2, Milestone 9) — só quando o CTA está desligado
  // (mesma condição que embute os planos direto acima), e só se o lead
  // ainda não usou (1 visualização por lead, v1) — "o botão some do
  // teclado" do print de referência é implementado assim: nunca aparece de
  // novo pra quem já viu, em vez de reaparecer e falhar ao clicar.
  if (!welcome.ctaButtonEnabled && previewConfig?.active && previewConfig.media.length > 0 && !previewAlreadyUsed) {
    rows.push([Markup.button.callback(previewConfig.buttonLabel || "🔥 Prévias Grátis", PREVIEW_CALLBACK)]);
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
  packs: Plan[],
  previewConfig: PreviewConfigWithMedia | null,
  previewAlreadyUsed: boolean
): Promise<void> {
  const prepared = prepareRichText(welcome.text, { lead, bot: botRow });
  const keyboard = buildWelcomeKeyboard(welcome, plans, packConfig, packs, previewConfig, previewAlreadyUsed);
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
          await registerCountdownIfNeeded(prepared, { botId: botRow.id, chatId: ctx.chat.id, messageId: sent.message_id, isCaption: true });
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

function escapeHtmlForCode(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** `pixCodeFormat` CODE = `<code>` monoespaçado (o Telegram já deixa copiar
 * tocando, sem precisar de nenhum botão) — PLAIN = texto puro. */
function formatPixCodeMessage(code: string, format: PixCodeFormat): { text: string; parseMode?: "HTML" } {
  if (format === "PLAIN") return { text: code };
  return { text: `<code>${escapeHtmlForCode(code)}</code>`, parseMode: "HTML" };
}

/** Junta a "mensagem antes do código" (se houver) com o código formatado —
 * escapa a intro quando o resultado vai como HTML, já que os dois
 * compartilham o mesmo parse_mode nessa única mensagem. */
function buildCombinedCodeText(introLine: string | null, codeFormatted: { text: string; parseMode?: "HTML" }): string {
  const intro = introLine && codeFormatted.parseMode === "HTML" ? escapeHtmlForCode(introLine) : introLine;
  return [intro, codeFormatted.text].filter(Boolean).join("\n");
}

function buildPaymentButtonRows(
  pm: {
    showCheckStatusButton: boolean;
    checkStatusButtonLabel?: string | null;
    showCopyCodeButton: boolean;
    copyCodeButtonLabel?: string | null;
    buttonStyle: PaymentButtonStyle;
  },
  orderId: string
): InlineKeyboardButton[][] {
  const buttons: InlineKeyboardButton[] = [];
  if (pm.showCheckStatusButton) {
    buttons.push(styledCallbackButton(pm.checkStatusButtonLabel || "✅ Verificar Status", `${CHECK_STATUS_PREFIX}${orderId}`));
  }
  if (pm.showCopyCodeButton) {
    buttons.push(styledCallbackButton(pm.copyCodeButtonLabel || "📋 Copiar Código", `${COPY_CODE_PREFIX}${orderId}`));
  }
  if (buttons.length === 0) return [];
  return pm.buttonStyle === "COMPACTO" ? [buttons] : buttons.map((b) => [b]);
}

/** Manda a instrução de "Texto do PIX" — com até 3 mídias (1 = legenda,
 * 2-3 = grupo + texto à parte), mesmo padrão de `renderWelcome`. Retorna o
 * messageId e se o texto foi enviado como legenda (pro registro do
 * countdown ao vivo saber qual API de edição usar). */
async function sendPaymentInstruction(
  ctx: Context,
  prepared: PreparedText,
  media: PaymentGeneratedMedia[]
): Promise<{ messageId: number; isCaption: boolean } | null> {
  const items = media.slice(0, 3);
  try {
    if (items.length === 1) {
      const m = items[0];
      const opts = {
        caption: prepared.text || undefined,
        parse_mode: "HTML" as const,
        message_effect_id: prepared.effectId,
      } as never;
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
      if (sent) return { messageId: sent.message_id, isCaption: true };
    } else if (items.length > 1) {
      await ctx.replyWithMediaGroup(
        items.map((m) => ({ type: m.mediaType.toLowerCase() as "photo" | "video", media: m.fileId }))
      );
    }
  } catch (err) {
    console.error("[flows] falha ao enviar mídia da instrução de pagamento, seguindo com o texto", err);
  }
  const sentText = await ctx.reply(prepared.text || "​", { parse_mode: "HTML", message_effect_id: prepared.effectId } as never);
  return { messageId: sentText.message_id, isCaption: false };
}

/**
 * Gera a cobrança PIX pra 1+ itens (Plano base + Order Bumps marcados, ou
 * um Upsell/Downsell isolado) e manda pro comprador. Reaproveita a config
 * (`PaymentMessages`) do funil do plano BASE — ou do primeiro item, se não
 * houver BASE (caso de Upsell/Downsell gerando seu próprio PIX à parte).
 * Sequência de mensagens (Fase 2, Milestone 10 — paridade Shark Bot):
 * instrução (+ mídia) → [código PIX, junto ou em mensagem própria, com os
 * botões Verificar Status/Copiar Código anexados onde fizer sentido] →
 * mensagem "antes dos botões" (se configurada e houver algum botão) → QR
 * Code (se não estiver oculto) → Prova Social rotativa (se ativa).
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
      include: {
        flow: {
          include: {
            paymentMessages: {
              include: {
                generatedMedia: { orderBy: { order: "asc" } },
                socialProofMessages: { orderBy: { order: "asc" } },
              },
            },
          },
        },
      },
    });
    if (plan) {
      try {
        await scheduleDownsellForOrder(botId, lead.id, order.id, plan.flowId);
      } catch (err) {
        console.error("[flows] falha ao agendar downsell de PIX gerado", err);
      }
    }

    const botRow = await prisma.bot.findUniqueOrThrow({ where: { id: botId } });
    const pm = plan?.flow.paymentMessages;
    const template = pm?.pixGeneratedMessage;
    const prepared: PreparedText = template
      ? prepareRichText(template, { lead, bot: botRow, extra: { valor: formatBRL(order.amountCents), plano: plan?.name ?? "" } })
      : { text: "Pagamento gerado! Copie o código PIX abaixo e cole no app do seu banco:" };

    const instructionSent = await sendPaymentInstruction(ctx, prepared, pm?.generatedMedia ?? []);
    if (ctx.chat && instructionSent) {
      await registerCountdownIfNeeded(prepared, {
        botId,
        chatId: ctx.chat.id,
        messageId: instructionSent.messageId,
        isCaption: instructionSent.isCaption,
      });
    }

    const buttonRows = buildPaymentButtonRows(
      {
        showCheckStatusButton: pm?.showCheckStatusButton ?? true,
        checkStatusButtonLabel: pm?.checkStatusButtonLabel,
        showCopyCodeButton: pm?.showCopyCodeButton ?? true,
        copyCodeButtonLabel: pm?.copyCodeButtonLabel,
        buttonStyle: pm?.buttonStyle ?? "PADRAO",
      },
      order.id
    );
    const hasButtons = buttonRows.length > 0;
    const showButtonsIntro = pm?.showButtonsIntroMessage ?? true;
    // Os botões vão anexados na própria mensagem do código quando não há
    // (ou está desligada) a mensagem "antes dos botões" — nunca ficam sem
    // nenhuma mensagem pra grudar.
    const attachButtonsToCodeMessage = hasButtons && !showButtonsIntro;
    const codeFormatted = formatPixCodeMessage(pixCopyPaste, pm?.pixCodeFormat ?? "CODE");
    const introLine = (pm?.showPixCodeIntroMessage ?? true) ? pm?.pixCodeIntroMessage || "Copie o código abaixo:" : null;

    // O código copia-e-cola sempre vai pro comprador, sem depender do texto
    // customizado mencionar {qr_code}/etc.
    if (pm?.pixCodeInSameMessage) {
      await ctx.reply(buildCombinedCodeText(introLine, codeFormatted), {
        parse_mode: codeFormatted.parseMode,
        reply_markup: attachButtonsToCodeMessage ? Markup.inlineKeyboard(buttonRows).reply_markup : undefined,
      } as never);
    } else {
      if (introLine) await ctx.reply(introLine);
      await ctx.reply(codeFormatted.text, {
        parse_mode: codeFormatted.parseMode,
        reply_markup: attachButtonsToCodeMessage ? Markup.inlineKeyboard(buttonRows).reply_markup : undefined,
      } as never);
    }

    if (hasButtons && showButtonsIntro) {
      const introText = pm?.buttonsIntroMessage || "Após efetuar o pagamento, clique no botão abaixo 👇";
      await ctx.reply(introText, { reply_markup: Markup.inlineKeyboard(buttonRows).reply_markup } as never);
    }

    if ((pm?.qrCodeDisplay ?? "IMAGE") === "IMAGE" && qrCodeUrl) {
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

    if (pm?.showSocialProof && pm.socialProofMessages.length > 0 && ctx.chat) {
      try {
        const texts = pm.socialProofMessages.map((m: SocialProofMessage) => m.text);
        const firstIndex = Math.floor(Math.random() * texts.length);
        const sentProof = await ctx.reply(texts[firstIndex]);
        await registerSocialProof({
          botId,
          chatId: ctx.chat.id,
          messageId: sentProof.message_id,
          orderId: order.id,
          messages: texts,
          intervalSeconds: pm.socialProofIntervalSeconds,
          firstIndex,
        });
      } catch (err) {
        console.error("[flows] falha ao mandar prova social", err);
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
    const previewAlreadyUsed = flow.previewConfig
      ? (await prisma.previewView.findUnique({ where: { flowId_leadId: { flowId: flow.id, leadId: result.lead.id } } })) != null
      : false;
    // Sem CTA, os botões de plano já saem direto na própria mensagem de
    // boas-vindas (ver buildWelcomeKeyboard) — não precisa de um passo à
    // parte pro lead ver os planos.
    await renderWelcome(
      ctx,
      botRow,
      result.lead,
      flow.welcomeConfig,
      flow.plans,
      flow.packConfig,
      flow.packs,
      flow.previewConfig,
      previewAlreadyUsed
    );
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

  // --- Prévias que somem (Fase 2, Milestone 9) ---

  bot.action(PREVIEW_CALLBACK, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const lead = await touchLead(ctx, botId);
    if (!lead) return;

    const flow = await getFlowForBot(botId);
    const previewConfig = flow?.previewConfig;
    if (!flow || !previewConfig?.active || previewConfig.media.length === 0) return;

    // "1 visualização por lead" (única política implementada na v1) — cria
    // a marca ANTES de mandar, pra dois cliques quase simultâneos não
    // conseguirem passar os dois pela checagem (race condition benigna:
    // pior caso é um clique extra levar um "já usou", nunca dois envios).
    try {
      await prisma.previewView.create({ data: { flowId: flow.id, leadId: lead.id } });
    } catch (err) {
      // Unique[flowId,leadId] já existe — o lead já usou (ou clicou 2x
      // rápido); não reenviar.
      await ctx.answerCbQuery("Você já usou essa prévia.", { show_alert: true }).catch(() => {});
      return;
    }

    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const sentMessageIds: number[] = [];
    for (const m of previewConfig.media) {
      try {
        const opts = { protect_content: previewConfig.protectContent } as never;
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
        if (sent) sentMessageIds.push(sent.message_id);
      } catch (err) {
        console.error(`[flows] falha ao enviar mídia de prévia (flow ${flow.id})`, err);
      }
    }
    if (previewConfig.caption) {
      try {
        const sent = await ctx.reply(previewConfig.caption);
        sentMessageIds.push(sent.message_id);
      } catch (err) {
        console.error(`[flows] falha ao enviar legenda da prévia (flow ${flow.id})`, err);
      }
    }

    if (sentMessageIds.length > 0) {
      await prisma.scheduledPreviewCleanup.create({
        data: {
          botId,
          chatId: BigInt(chatId),
          messageIds: sentMessageIds,
          expiredMessage: previewConfig.expiredMessage,
          expiredShowPlansButton: previewConfig.expiredShowPlansButton,
          deleteAt: new Date(Date.now() + previewConfig.deleteAfterSeconds * 1000),
        },
      });
    }

    // "O botão some do teclado" — reconstrói o teclado da própria mensagem
    // de boas-vindas sem a linha de Prévias (previewAlreadyUsed=true agora
    // que o PreviewView foi criado acima).
    if (flow.welcomeConfig) {
      try {
        const rebuilt = buildWelcomeKeyboard(flow.welcomeConfig, flow.plans, flow.packConfig, flow.packs, previewConfig, true);
        await ctx.editMessageReplyMarkup(rebuilt?.reply_markup);
      } catch (err) {
        console.error(`[flows] falha ao remover o botão de prévias do teclado original (flow ${flow.id})`, err);
      }
    }
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

  // --- Botões da seção Pagamentos (Fase 2, Milestone 10) ---

  bot.action(new RegExp(`^${CHECK_STATUS_PREFIX}.+`), async (ctx) => {
    const data = getCallbackData(ctx);
    const orderId = data?.startsWith(CHECK_STATUS_PREFIX) ? data.slice(CHECK_STATUS_PREFIX.length) : null;
    if (!orderId) {
      await ctx.answerCbQuery().catch(() => {});
      return;
    }
    try {
      const { checkOrderStatusNow } = await import("../payments/reconciliation.js");
      const status = await checkOrderStatusNow(orderId);
      if (status === "PAID") {
        await ctx.answerCbQuery("✅ Pagamento confirmado! Confira as mensagens acima.", { show_alert: true }).catch(() => {});
      } else if (status === "PENDING") {
        await ctx
          .answerCbQuery("⏳ Ainda não identificamos seu pagamento. Assim que cair, avisamos automaticamente.", { show_alert: true })
          .catch(() => {});
      } else {
        await ctx.answerCbQuery("Não foi possível verificar agora. Tente novamente em instantes.", { show_alert: true }).catch(() => {});
      }
    } catch (err) {
      console.error("[flows] falha ao verificar status do pagamento", err);
      await ctx.answerCbQuery("Não foi possível verificar agora. Tente novamente em instantes.", { show_alert: true }).catch(() => {});
    }
  });

  bot.action(new RegExp(`^${COPY_CODE_PREFIX}.+`), async (ctx) => {
    const data = getCallbackData(ctx);
    const orderId = data?.startsWith(COPY_CODE_PREFIX) ? data.slice(COPY_CODE_PREFIX.length) : null;
    if (!orderId) {
      await ctx.answerCbQuery().catch(() => {});
      return;
    }
    const order = await prisma.order.findUnique({ where: { id: orderId }, select: { pixCopyPaste: true } });
    const code = order?.pixCopyPaste;
    if (!code) {
      await ctx.answerCbQuery("Código não encontrado.", { show_alert: true }).catch(() => {});
      return;
    }
    // O alerta de callback do Telegram tem limite de 200 caracteres — um
    // código PIX mais longo que isso não cabe; manda como mensagem nova
    // formatada em vez de truncar o código (inutilizável truncado).
    if (code.length <= 200) {
      await ctx.answerCbQuery(code, { show_alert: true }).catch(() => {});
    } else {
      await ctx.answerCbQuery("📋 Copiado! Veja a mensagem abaixo.").catch(() => {});
      await ctx.reply(`<code>${escapeHtmlForCode(code)}</code>`, { parse_mode: "HTML" } as never);
    }
  });

  bot.action(new RegExp(`^${ACCESS_CONTENT_PREFIX}.+`), async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const data = getCallbackData(ctx);
    const orderId = data?.startsWith(ACCESS_CONTENT_PREFIX) ? data.slice(ACCESS_CONTENT_PREFIX.length) : null;
    if (!orderId) return;

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { lead: true, items: { include: { plan: { include: { flow: { include: { delivery: true } } } } } } },
    });
    // Defesa: só reenvia se o pedido já está pago e quem clicou é o próprio
    // lead do pedido (callback_data não é secreto, mas escopado por chat).
    if (!order || order.status !== "PAID" || !ctx.from || BigInt(ctx.from.id) !== order.lead.telegramId) return;

    const { resolveEffectiveDelivery, deliverPlanToLead } = await import("./delivery.js");
    for (const item of order.items) {
      const resolved = resolveEffectiveDelivery(item.plan, item.plan.flow.delivery);
      if (!resolved || (!resolved.deliveryTarget && resolved.plan.deliveryType === "FILE")) continue;
      try {
        await deliverPlanToLead({
          botId,
          leadTelegramId: order.lead.telegramId,
          plan: resolved.plan,
          deliveryTarget: resolved.deliveryTarget ?? "",
        });
      } catch (err) {
        console.error("[flows] falha ao reenviar conteúdo via botão de acesso", err);
      }
    }
  });
}
