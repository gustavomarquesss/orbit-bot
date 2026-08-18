import { describe, expect, it } from "vitest";
import { formatBRL, parseBooleanFlag, parsePriceToCents } from "./format.js";

describe("formatBRL", () => {
  it("formata centavos como moeda brasileira", () => {
    expect(formatBRL(2990)).toBe("R$ 29,90");
  });

  it("formata valores inteiros sem casas decimais perdidas", () => {
    expect(formatBRL(10000)).toBe("R$ 100,00");
  });

  it("formata zero", () => {
    expect(formatBRL(0)).toBe("R$ 0,00");
  });
});

describe("parsePriceToCents", () => {
  it("aceita ponto como separador decimal", () => {
    expect(parsePriceToCents("29.90")).toBe(2990);
  });

  it("aceita vírgula como separador decimal", () => {
    expect(parsePriceToCents("29,90")).toBe(2990);
  });

  it("aceita valores inteiros", () => {
    expect(parsePriceToCents("30")).toBe(3000);
  });

  it("rejeita valores não numéricos", () => {
    expect(parsePriceToCents("abc")).toBeNull();
  });

  it("rejeita valores zero ou negativos", () => {
    expect(parsePriceToCents("0")).toBeNull();
    expect(parsePriceToCents("-10")).toBeNull();
  });

  it("arredonda corretamente para evitar erro de ponto flutuante", () => {
    // 0.1 + 0.2 em float puro dá 0.30000000000000004 — o Math.round precisa
    // absorver esse erro para não gerar priceCents fracionário.
    expect(parsePriceToCents("19.99")).toBe(1999);
  });
});

describe("parseBooleanFlag", () => {
  it("usa o default quando vazio ou indefinido", () => {
    expect(parseBooleanFlag(undefined, true)).toBe(true);
    expect(parseBooleanFlag("", false)).toBe(false);
    expect(parseBooleanFlag("   ", true)).toBe(true);
  });

  it("reconhece variações afirmativas em português", () => {
    for (const value of ["sim", "SIM", "s", "true", "1"]) {
      expect(parseBooleanFlag(value, false)).toBe(true);
    }
  });

  it("trata qualquer outro valor como negativo", () => {
    for (const value of ["nao", "não", "n", "false", "0", "qualquer coisa"]) {
      expect(parseBooleanFlag(value, true)).toBe(false);
    }
  });
});
