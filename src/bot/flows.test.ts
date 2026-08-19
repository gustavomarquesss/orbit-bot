import { describe, it, expect } from "vitest";
import { parseBumpCallback, BUMP_TOGGLE_PREFIX, BUMP_CONFIRM_PREFIX } from "./flows.js";

describe("parseBumpCallback", () => {
  it("faz parse de um callback de toggle (com índice)", () => {
    const data = `${BUMP_TOGGLE_PREFIX}plan-abc123:5:2`;
    expect(parseBumpCallback(data, BUMP_TOGGLE_PREFIX)).toEqual({
      planId: "plan-abc123",
      bitmask: 5,
      index: 2,
    });
  });

  it("faz parse de um callback de confirmação (sem índice)", () => {
    const data = `${BUMP_CONFIRM_PREFIX}plan-abc123:5`;
    expect(parseBumpCallback(data, BUMP_CONFIRM_PREFIX)).toEqual({
      planId: "plan-abc123",
      bitmask: 5,
    });
  });

  it("retorna null se o bitmask não é um número", () => {
    expect(parseBumpCallback(`${BUMP_TOGGLE_PREFIX}plan-abc123:xyz:2`, BUMP_TOGGLE_PREFIX)).toBeNull();
  });

  it("retorna null se o índice não é um número", () => {
    expect(parseBumpCallback(`${BUMP_TOGGLE_PREFIX}plan-abc123:5:xyz`, BUMP_TOGGLE_PREFIX)).toBeNull();
  });

  it("retorna null se faltar o planId", () => {
    expect(parseBumpCallback(`${BUMP_TOGGLE_PREFIX}:5:2`, BUMP_TOGGLE_PREFIX)).toBeNull();
  });

  it("aceita bitmask 0 (nenhum bump marcado)", () => {
    expect(parseBumpCallback(`${BUMP_CONFIRM_PREFIX}plan-abc123:0`, BUMP_CONFIRM_PREFIX)).toEqual({
      planId: "plan-abc123",
      bitmask: 0,
    });
  });
});
