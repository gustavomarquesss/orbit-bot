import { describe, expect, it } from "vitest";
import { buildButtonCallbackData, nextOrder, parseButtonCallbackData } from "./util.js";

describe("buildButtonCallbackData / parseButtonCallbackData", () => {
  it("faz round-trip com um id de botão", () => {
    const id = "clx1234567890abcdef";
    const data = buildButtonCallbackData(id);
    expect(data).toBe(`btn:${id}`);
    expect(parseButtonCallbackData(data)).toBe(id);
  });

  it("retorna null para callback_data sem o prefixo esperado", () => {
    expect(parseButtonCallbackData("outra:coisa")).toBeNull();
    expect(parseButtonCallbackData("")).toBeNull();
  });

  it("não confunde um id que por acaso contenha o prefixo em outro lugar", () => {
    // O prefixo só é removido do início da string.
    expect(parseButtonCallbackData("btn:btn:aninhado")).toBe("btn:aninhado");
  });
});

describe("nextOrder", () => {
  it("retorna 0 quando não há item anterior", () => {
    expect(nextOrder(null)).toBe(0);
    expect(nextOrder(undefined)).toBe(0);
  });

  it("retorna order + 1 quando há um último item", () => {
    expect(nextOrder(0)).toBe(1);
    expect(nextOrder(4)).toBe(5);
  });

  it("trata order 0 como um valor válido, não como ausência de item", () => {
    // Regressão: `lastOrder ? ... : 0` trataria erroneamente 0 como falsy.
    expect(nextOrder(0)).toBe(1);
  });
});
