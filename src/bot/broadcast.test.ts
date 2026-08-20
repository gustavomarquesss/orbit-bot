import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/client.js", () => ({
  prisma: {
    broadcast: { findUniqueOrThrow: vi.fn(), update: vi.fn() },
    bot: { findUniqueOrThrow: vi.fn() },
    lead: { findMany: vi.fn() },
  },
}));

const sendMessage = vi.fn();
vi.mock("./botManager.js", () => ({
  getTelegraf: vi.fn(() => ({ telegram: { sendMessage } })),
}));

import { prisma } from "../db/client.js";
import { getTelegraf } from "./botManager.js";
import { sendBroadcast } from "./broadcast.js";

const botRow = { id: "bot1", displayName: "Meu Bot", telegramUsername: "meu_bot" };

describe("sendBroadcast", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.bot.findUniqueOrThrow).mockResolvedValue(botRow as never);
    sendMessage.mockResolvedValue({});
  });

  it("marca FAILED sem tentar mandar nada se o bot não está registrado", async () => {
    vi.mocked(prisma.broadcast.findUniqueOrThrow).mockResolvedValue({
      id: "b1",
      botId: "bot1",
      segment: "ALL",
      message: "oi",
    } as never);
    vi.mocked(getTelegraf).mockReturnValueOnce(undefined);

    await sendBroadcast("b1");

    expect(sendMessage).not.toHaveBeenCalled();
    expect(prisma.broadcast.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "b1" }, data: expect.objectContaining({ status: "FAILED" }) })
    );
  });

  it("resolve o segmento ALL como todos os leads do bot", async () => {
    vi.mocked(prisma.broadcast.findUniqueOrThrow).mockResolvedValue({
      id: "b2",
      botId: "bot1",
      segment: "ALL",
      message: "Oi {nome}!",
    } as never);
    vi.mocked(prisma.lead.findMany).mockResolvedValue([
      { id: "lead-1", telegramId: 1n, firstName: "Ana" },
      { id: "lead-2", telegramId: 2n, firstName: "Bia" },
    ] as never);

    await sendBroadcast("b2");

    expect(prisma.lead.findMany).toHaveBeenCalledWith({ where: { botId: "bot1" } });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledWith(1, "Oi Ana!", { parse_mode: "HTML" });
    expect(sendMessage).toHaveBeenCalledWith(2, "Oi Bia!", { parse_mode: "HTML" });
    expect(prisma.broadcast.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "b2" }, data: expect.objectContaining({ status: "DONE" }) })
    );
  });

  it("resolve o segmento BUYERS filtrando por Order PAID", async () => {
    vi.mocked(prisma.broadcast.findUniqueOrThrow).mockResolvedValue({
      id: "b3",
      botId: "bot1",
      segment: "BUYERS",
      message: "oi",
    } as never);
    vi.mocked(prisma.lead.findMany).mockResolvedValue([]);

    await sendBroadcast("b3");

    expect(prisma.lead.findMany).toHaveBeenCalledWith({
      where: { botId: "bot1", orders: { some: { status: "PAID" } } },
    });
  });

  it("resolve o segmento NON_BUYERS filtrando por ausência de Order PAID", async () => {
    vi.mocked(prisma.broadcast.findUniqueOrThrow).mockResolvedValue({
      id: "b4",
      botId: "bot1",
      segment: "NON_BUYERS",
      message: "oi",
    } as never);
    vi.mocked(prisma.lead.findMany).mockResolvedValue([]);

    await sendBroadcast("b4");

    expect(prisma.lead.findMany).toHaveBeenCalledWith({
      where: { botId: "bot1", orders: { none: { status: "PAID" } } },
    });
  });

  it("incrementa failedCount e segue pro próximo quando o envio de uma mensagem falha", async () => {
    vi.mocked(prisma.broadcast.findUniqueOrThrow).mockResolvedValue({
      id: "b5",
      botId: "bot1",
      segment: "ALL",
      message: "oi",
    } as never);
    vi.mocked(prisma.lead.findMany).mockResolvedValue([
      { id: "lead-1", telegramId: 1n, firstName: "Ana" },
      { id: "lead-2", telegramId: 2n, firstName: "Bia" },
    ] as never);
    sendMessage.mockRejectedValueOnce(new Error("bot bloqueado")).mockResolvedValueOnce({});

    await sendBroadcast("b5");

    expect(prisma.broadcast.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "b5" }, data: { failedCount: { increment: 1 } } })
    );
    expect(prisma.broadcast.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "b5" }, data: { sentCount: { increment: 1 } } })
    );
    expect(prisma.broadcast.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "b5" }, data: expect.objectContaining({ status: "DONE" }) })
    );
  });
});
