import type { DiscountType } from "@prisma/client";

/**
 * Módulo sem dependências de botManager/flows/downsellScheduler — usado
 * pelos dois lados (src/bot/flows.ts registra o handler do botão de
 * compra, src/bot/downsellScheduler.ts monta o botão que dispara o
 * callback) sem criar import circular entre eles, mesmo padrão de
 * src/bot/offerMessage.ts.
 */
export const DOWNSELL_BUY_PREFIX = "dsBuy:";

export interface DownsellBuyCallback {
  sequenceId: string;
  planId: string;
}

export function buildDownsellBuyCallbackData(sequenceId: string, planId: string): string {
  return `${DOWNSELL_BUY_PREFIX}${sequenceId}:${planId}`;
}

export function parseDownsellBuyCallback(data: string): DownsellBuyCallback | null {
  if (!data.startsWith(DOWNSELL_BUY_PREFIX)) return null;
  const [sequenceId, planId] = data.slice(DOWNSELL_BUY_PREFIX.length).split(":");
  if (!sequenceId || !planId) return null;
  return { sequenceId, planId };
}

/** PERCENT: discountValue de 0 a 100. FIXED: discountValue em centavos. */
export function applyDiscount(priceCents: number, discountType: DiscountType, discountValue: number): number {
  if (discountType === "PERCENT") {
    const pct = Math.min(Math.max(discountValue, 0), 100);
    return Math.max(0, Math.round((priceCents * (100 - pct)) / 100));
  }
  return Math.max(0, priceCents - discountValue);
}
