import { describe, it, expect } from "vitest";
import { applyDiscount, buildDownsellBuyCallbackData, parseDownsellBuyCallback, DOWNSELL_BUY_PREFIX } from "./downsellMessage.js";

describe("applyDiscount", () => {
  it("aplica desconto percentual", () => {
    expect(applyDiscount(1000, "PERCENT", 10)).toBe(900);
    expect(applyDiscount(1990, "PERCENT", 5)).toBe(1891); // 1990 * 0.95 = 1890.5 -> arredonda pra 1891
  });

  it("aplica desconto fixo (centavos)", () => {
    expect(applyDiscount(1000, "FIXED", 300)).toBe(700);
  });

  it("nunca fica negativo", () => {
    expect(applyDiscount(100, "FIXED", 500)).toBe(0);
  });

  it("percentual é limitado a 0-100 mesmo com valor absurdo configurado", () => {
    expect(applyDiscount(1000, "PERCENT", 150)).toBe(0);
    expect(applyDiscount(1000, "PERCENT", -10)).toBe(1000);
  });
});

describe("buildDownsellBuyCallbackData / parseDownsellBuyCallback", () => {
  it("faz round-trip sequenceId + planId", () => {
    const data = buildDownsellBuyCallbackData("seq-abc123", "plan-xyz789");
    expect(data).toBe(`${DOWNSELL_BUY_PREFIX}seq-abc123:plan-xyz789`);
    expect(parseDownsellBuyCallback(data)).toEqual({ sequenceId: "seq-abc123", planId: "plan-xyz789" });
  });

  it("retorna null se não começar com o prefixo esperado", () => {
    expect(parseDownsellBuyCallback("plan:abc")).toBeNull();
  });

  it("retorna null se faltar o planId", () => {
    expect(parseDownsellBuyCallback(`${DOWNSELL_BUY_PREFIX}seq-abc123:`)).toBeNull();
  });

  it("cabe dentro do limite de 64 bytes do callback_data do Telegram com cuids reais", () => {
    const cuid = "cmo11x82vc283nz0kbsn7psnb"; // 25 chars, tamanho real de cuid gerado pelo Prisma
    const data = buildDownsellBuyCallbackData(cuid, cuid);
    expect(Buffer.byteLength(data, "utf8")).toBeLessThanOrEqual(64);
  });
});
