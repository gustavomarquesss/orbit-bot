import { describe, expect, it } from "vitest";
import { nextOrder } from "./util.js";

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
