import { Markup } from "telegraf";
import type { Bot, Lead, Offer, Plan } from "@prisma/client";
import { renderTemplate } from "./templating.js";

/**
 * Módulo deliberadamente sem dependência de botManager.ts nem de flows.ts —
 * é usado tanto por delivery.ts (push via getTelegraf, sem ctx — caso do
 * Upsell disparado depois da entrega) quanto por flows.ts (dentro de um
 * bot.action, com ctx — caso do Downsell disparado ao recusar um Upsell).
 * botManager.ts já importa flows.ts pra registrar os handlers; se flows.ts
 * importasse de volta algo que depende de botManager.ts, viraria um ciclo
 * de import (botManager -> flows -> algo -> botManager). Mantendo essas
 * funções puras aqui, os dois lados importam só isto, nunca um ao outro.
 */

const OFFER_ACCEPT_PREFIX = "ofYes:";
const OFFER_DECLINE_PREFIX = "ofNo:";

/** "Sim, adicionar" pra Order Bump, "Sim, quero" pra Upsell/Downsell — só o default quando o admin não customiza. */
export function defaultAcceptLabel(kind: Offer["kind"]): string {
  return kind === "ORDER_BUMP" ? "Sim, adicionar" : "Sim, quero";
}

export function defaultDeclineLabel(): string {
  return "Não, obrigado";
}

export function buildOfferKeyboard(offer: Pick<Offer, "id" | "kind" | "acceptLabel" | "declineLabel">) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(offer.acceptLabel || defaultAcceptLabel(offer.kind), `${OFFER_ACCEPT_PREFIX}${offer.id}`)],
    [Markup.button.callback(offer.declineLabel || defaultDeclineLabel(), `${OFFER_DECLINE_PREFIX}${offer.id}`)],
  ]);
}

export function parseOfferAcceptId(data: string): string | null {
  return data.startsWith(OFFER_ACCEPT_PREFIX) ? data.slice(OFFER_ACCEPT_PREFIX.length) : null;
}

export function parseOfferDeclineId(data: string): string | null {
  return data.startsWith(OFFER_DECLINE_PREFIX) ? data.slice(OFFER_DECLINE_PREFIX.length) : null;
}

function formatBRL(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export function buildOfferText(offer: Offer, offeredPlan: Plan, lead: Lead, bot: Bot): string {
  return offer.message
    ? renderTemplate(offer.message, {
        lead,
        bot,
        extra: { valor: formatBRL(offeredPlan.priceCents), plano: offeredPlan.name },
      })
    : `Que tal levar também <b>${offeredPlan.name}</b> por ${formatBRL(offeredPlan.priceCents)}?`;
}
