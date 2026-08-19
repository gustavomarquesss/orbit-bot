import { describe, it, expect } from "vitest";
import { parseBumpCallback, BUMP_ACCEPT_PREFIX, BUMP_DECLINE_PREFIX } from "./flows.js";

describe("parseBumpCallback", () => {
  it("faz parse de um callback de aceitar", () => {
    const data = `${BUMP_ACCEPT_PREFIX}plan-abc123:5:2`;
    expect(parseBumpCallback(data, BUMP_ACCEPT_PREFIX)).toEqual({
      planId: "plan-abc123",
      bitmask: 5,
      index: 2,
    });
  });

  it("faz parse de um callback de recusar", () => {
    const data = `${BUMP_DECLINE_PREFIX}plan-abc123:5:2`;
    expect(parseBumpCallback(data, BUMP_DECLINE_PREFIX)).toEqual({
      planId: "plan-abc123",
      bitmask: 5,
      index: 2,
    });
  });

  it("retorna null se o bitmask não é um número", () => {
    expect(parseBumpCallback(`${BUMP_ACCEPT_PREFIX}plan-abc123:xyz:2`, BUMP_ACCEPT_PREFIX)).toBeNull();
  });

  it("retorna null se o índice não é um número", () => {
    expect(parseBumpCallback(`${BUMP_ACCEPT_PREFIX}plan-abc123:5:xyz`, BUMP_ACCEPT_PREFIX)).toBeNull();
  });

  it("retorna null se faltar o planId", () => {
    expect(parseBumpCallback(`${BUMP_ACCEPT_PREFIX}:5:2`, BUMP_ACCEPT_PREFIX)).toBeNull();
  });

  it("aceita bitmask 0 e índice 0 (primeiro bump, nenhum aceito ainda)", () => {
    expect(parseBumpCallback(`${BUMP_ACCEPT_PREFIX}plan-abc123:0:0`, BUMP_ACCEPT_PREFIX)).toEqual({
      planId: "plan-abc123",
      bitmask: 0,
      index: 0,
    });
  });
});
