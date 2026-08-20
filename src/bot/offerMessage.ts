import type { Offer, Plan } from "@prisma/client";

/**
 * Usado pelo Order Bump (flows.ts) pro texto de convite de cada bump —
 * mesmo padrão de variável/HTML de `pixGeneratedMessage` etc. O
 * render/effect/countdown de verdade é feito por src/bot/richSend.ts
 * (prepareRichText) em cima do template RAW retornado por
 * `offerRawTemplate` — não renderiza aqui pra manter {effect:...}/
 * {countdown:...} intactos até esse ponto.
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

export function offerRawTemplate(offer: Offer, offeredPlan: Plan): string {
  return offer.message ?? `Que tal levar também <b>${offeredPlan.name}</b> por ${formatBRL(offeredPlan.priceCents)}?`;
}

export function offerExtraVars(offeredPlan: Plan): Record<string, string> {
  return { valor: formatBRL(offeredPlan.priceCents), plano: offeredPlan.name };
}
