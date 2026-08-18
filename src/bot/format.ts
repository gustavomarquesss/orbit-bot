export function formatBRL(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

/**
 * Aceita "29.90" ou "29,90". Retorna `null` se não for um preço válido (>0).
 */
export function parsePriceToCents(raw: string): number | null {
  const normalized = raw.trim().replace(",", ".");
  const price = Number(normalized);
  if (!Number.isFinite(price) || price <= 0) return null;
  return Math.round(price * 100);
}

/**
 * Interpreta "sim/s/true/1" como true, qualquer outro valor não vazio como
 * false, e string vazia/undefined como `defaultValue`.
 */
export function parseBooleanFlag(raw: string | undefined, defaultValue: boolean): boolean {
  if (!raw || !raw.trim()) return defaultValue;
  return /^(sim|s|true|1)$/i.test(raw.trim());
}
