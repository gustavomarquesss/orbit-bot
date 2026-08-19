import type { Bot, Lead, Offer, Plan } from "@prisma/client";
import { renderTemplate } from "./templating.js";

/**
 * Usado pelo Order Bump (flows.ts) pro texto de convite de cada bump —
 * mesmo padrão de variável/HTML de `pixGeneratedMessage` etc.
 */

/** "Sim, adicionar" pra Order Bump — único kind de Offer ativo hoje (ver OfferKind no schema). */
export function defaultAcceptLabel(kind: Offer["kind"]): string {
  return kind === "ORDER_BUMP" ? "Sim, adicionar" : "Sim, quero";
}

export function defaultDeclineLabel(): string {
  return "Não, obrigado";
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
