import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "telegraf";

vi.mock("../db/client.js", () => ({
  prisma: {
    origin: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    lead: {
      findUnique: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
      upsert: vi.fn(),
    },
  },
}));

import { prisma } from "../db/client.js";
import { resolveOriginAndUpsertLead, touchLead } from "./deepLink.js";

const mockedPrisma = vi.mocked(prisma, { deep: true });
const BOT_ID = "bot1";

function fakeCtx(from: { id: number; username?: string; first_name?: string; last_name?: string }): Context {
  return { from } as unknown as Context;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveOriginAndUpsertLead", () => {
  it("cria um lead novo sem origem quando não há start payload", async () => {
    mockedPrisma.lead.findUnique.mockResolvedValue(null);
    mockedPrisma.lead.create.mockResolvedValue({
      id: "lead1",
      telegramId: 111n,
      originId: null,
    } as never);

    const result = await resolveOriginAndUpsertLead(fakeCtx({ id: 111 }), BOT_ID, undefined);

    expect(result?.isNewLead).toBe(true);
    expect(result?.origin).toBeNull();
    expect(mockedPrisma.origin.findUnique).not.toHaveBeenCalled();
    expect(mockedPrisma.lead.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ telegramId: 111n, originId: undefined }) })
    );
  });

  it("associa o lead novo à origem existente que bate com o param", async () => {
    const origin = { id: "origin1", param: "campanha-x", label: "Campanha X", kind: "CAMPAIGN" };
    mockedPrisma.origin.findUnique.mockResolvedValue(origin as never);
    mockedPrisma.lead.findUnique.mockResolvedValue(null);
    mockedPrisma.lead.create.mockResolvedValue({
      id: "lead2",
      telegramId: 222n,
      originId: origin.id,
    } as never);

    const result = await resolveOriginAndUpsertLead(fakeCtx({ id: 222 }), BOT_ID, "campanha-x");

    expect(result?.origin).toEqual(origin);
    expect(mockedPrisma.lead.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ originId: "origin1" }) })
    );
  });

  it("cria automaticamente uma Origin desconhecida em vez de descartar o param", async () => {
    mockedPrisma.origin.findUnique.mockResolvedValue(null);
    mockedPrisma.origin.create.mockResolvedValue({
      id: "origin-novo",
      param: "param-nunca-visto",
      label: "param-nunca-visto",
      kind: "OTHER",
    } as never);
    mockedPrisma.lead.findUnique.mockResolvedValue(null);
    mockedPrisma.lead.create.mockResolvedValue({ id: "lead3", telegramId: 333n } as never);

    const result = await resolveOriginAndUpsertLead(fakeCtx({ id: 333 }), BOT_ID, "param-nunca-visto");

    expect(mockedPrisma.origin.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { param: "param-nunca-visto", label: "param-nunca-visto", kind: "OTHER" },
      })
    );
    expect(result?.origin?.id).toBe("origin-novo");
  });

  it("não sobrescreve a origem de um lead que já existia (atribuição de primeiro contato)", async () => {
    const firstTouchOrigin = { id: "origin-original", param: "primeiro", label: "primeiro", kind: "OTHER" };
    mockedPrisma.origin.findUnique
      .mockResolvedValueOnce({ id: "origin-segundo", param: "segundo" } as never) // resolveOrigin(payload)
      .mockResolvedValueOnce(firstTouchOrigin as never); // busca da origin já salva no lead

    mockedPrisma.lead.findUnique.mockResolvedValue({
      id: "lead4",
      telegramId: 444n,
      originId: "origin-original",
    } as never);
    mockedPrisma.lead.update.mockResolvedValue({
      id: "lead4",
      telegramId: 444n,
      originId: "origin-original",
    } as never);

    const result = await resolveOriginAndUpsertLead(fakeCtx({ id: 444 }), BOT_ID, "segundo");

    expect(mockedPrisma.lead.update).toHaveBeenCalled();
    expect(result?.origin?.id).toBe("origin-original");
    expect(result?.isNewLead).toBe(false);
  });
});

describe("touchLead", () => {
  it("faz upsert por telegramId atualizando lastSeenAt", async () => {
    mockedPrisma.lead.upsert.mockResolvedValue({ id: "lead5", telegramId: 555n } as never);

    await touchLead(fakeCtx({ id: 555, username: "fulano" }), BOT_ID);

    expect(mockedPrisma.lead.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { telegramId_botId: { telegramId: 555n, botId: BOT_ID } },
        update: expect.objectContaining({ username: "fulano" }),
        create: expect.objectContaining({ telegramId: 555n, botId: BOT_ID, username: "fulano" }),
      })
    );
  });

  it("retorna null quando o update não tem `from` (ex: update sem usuário)", async () => {
    const result = await touchLead({ from: undefined } as unknown as Context, BOT_ID);
    expect(result).toBeNull();
    expect(mockedPrisma.lead.upsert).not.toHaveBeenCalled();
  });
});
