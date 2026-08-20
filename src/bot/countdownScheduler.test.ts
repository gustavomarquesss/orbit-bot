import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/client.js", () => ({
  prisma: {
    scheduledCountdownEdit: { create: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  },
}));

const editMessageText = vi.fn();
const editMessageCaption = vi.fn();
const deleteMessage = vi.fn();
vi.mock("./botManager.js", () => ({
  getTelegraf: vi.fn(() => ({ telegram: { editMessageText, editMessageCaption, deleteMessage } })),
}));

import { prisma } from "../db/client.js";
import { getTelegraf } from "./botManager.js";
import { registerCountdown, processCountdownTicks } from "./countdownScheduler.js";
import { COUNTDOWN_MARKER } from "./templating.js";

describe("registerCountdown", () => {
  beforeEach(() => vi.clearAllMocks());

  it("cria a linha com nextTickAt = agora + intervalSeconds", async () => {
    const before = Date.now();
    await registerCountdown({
      botId: "bot1",
      chatId: 123n,
      messageId: 55,
      markerTemplate: `Expira em ${COUNTDOWN_MARKER}`,
      directive: { raw: "{countdown:60:10}", totalSeconds: 60, intervalSeconds: 10, deleteOnZero: false },
    });

    expect(prisma.scheduledCountdownEdit.create).toHaveBeenCalledTimes(1);
    const data = vi.mocked(prisma.scheduledCountdownEdit.create).mock.calls[0][0].data as never as {
      botId: string;
      chatId: bigint;
      messageId: number;
      totalSeconds: number;
      intervalSeconds: number;
      deleteOnZero: boolean;
      nextTickAt: Date;
    };
    expect(data.botId).toBe("bot1");
    expect(data.chatId).toBe(123n);
    expect(data.messageId).toBe(55);
    expect(data.totalSeconds).toBe(60);
    expect(data.intervalSeconds).toBe(10);
    expect(data.deleteOnZero).toBe(false);
    expect(data.nextTickAt.getTime()).toBeGreaterThanOrEqual(before + 10_000);
  });
});

describe("processCountdownTicks", () => {
  beforeEach(() => vi.clearAllMocks());

  it("edita a mensagem com o tempo restante e reagenda o próximo tick", async () => {
    const startedAt = new Date(Date.now() - 20_000); // começou há 20s
    vi.mocked(prisma.scheduledCountdownEdit.findMany).mockResolvedValue([
      {
        id: "cd-1",
        botId: "bot1",
        chatId: 123n,
        messageId: 55,
        markerTemplate: `Expira em ${COUNTDOWN_MARKER}`,
        totalSeconds: 60,
        intervalSeconds: 10,
        deleteOnZero: false,
        startedAt,
        nextTickAt: new Date(),
        finishedAt: null,
      },
    ] as never);

    await processCountdownTicks();

    expect(editMessageText).toHaveBeenCalledWith(123, 55, undefined, "Expira em 00:40", { parse_mode: "HTML" });
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(prisma.scheduledCountdownEdit.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "cd-1" } })
    );
    const updateData = vi.mocked(prisma.scheduledCountdownEdit.update).mock.calls[0][0].data as never as { nextTickAt: Date };
    expect(updateData.nextTickAt).toBeInstanceOf(Date);
  });

  it("ao chegar em zero sem deleteOnZero, fixa 00:00 e marca finishedAt", async () => {
    const startedAt = new Date(Date.now() - 60_000);
    vi.mocked(prisma.scheduledCountdownEdit.findMany).mockResolvedValue([
      {
        id: "cd-2",
        botId: "bot1",
        chatId: 123n,
        messageId: 55,
        markerTemplate: `Expira em ${COUNTDOWN_MARKER}`,
        totalSeconds: 30,
        intervalSeconds: 5,
        deleteOnZero: false,
        startedAt,
        nextTickAt: new Date(),
        finishedAt: null,
      },
    ] as never);

    await processCountdownTicks();

    expect(editMessageText).toHaveBeenCalledWith(123, 55, undefined, "Expira em 00:00", { parse_mode: "HTML" });
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(prisma.scheduledCountdownEdit.update).toHaveBeenCalledWith({
      where: { id: "cd-2" },
      data: { finishedAt: expect.any(Date) },
    });
  });

  it("ao chegar em zero com deleteOnZero, apaga a mensagem em vez de editar", async () => {
    const startedAt = new Date(Date.now() - 30_000);
    vi.mocked(prisma.scheduledCountdownEdit.findMany).mockResolvedValue([
      {
        id: "cd-3",
        botId: "bot1",
        chatId: 123n,
        messageId: 55,
        markerTemplate: `Expira em ${COUNTDOWN_MARKER}`,
        totalSeconds: 30,
        intervalSeconds: 5,
        deleteOnZero: true,
        startedAt,
        nextTickAt: new Date(),
        finishedAt: null,
      },
    ] as never);

    await processCountdownTicks();

    expect(deleteMessage).toHaveBeenCalledWith(123, 55);
    expect(editMessageText).not.toHaveBeenCalled();
    expect(prisma.scheduledCountdownEdit.update).toHaveBeenCalledWith({
      where: { id: "cd-3" },
      data: { finishedAt: expect.any(Date) },
    });
  });

  it("se o bot não está registrado (offline/removido), marca finishedAt sem tentar editar", async () => {
    vi.mocked(getTelegraf).mockReturnValueOnce(undefined);
    vi.mocked(prisma.scheduledCountdownEdit.findMany).mockResolvedValue([
      {
        id: "cd-4",
        botId: "bot-removido",
        chatId: 123n,
        messageId: 55,
        markerTemplate: `Expira em ${COUNTDOWN_MARKER}`,
        totalSeconds: 30,
        intervalSeconds: 5,
        deleteOnZero: false,
        startedAt: new Date(),
        nextTickAt: new Date(),
        finishedAt: null,
      },
    ] as never);

    await processCountdownTicks();

    expect(editMessageText).not.toHaveBeenCalled();
    expect(prisma.scheduledCountdownEdit.update).toHaveBeenCalledWith({
      where: { id: "cd-4" },
      data: { finishedAt: expect.any(Date) },
    });
  });

  it("quando isCaption é true, edita a legenda (editMessageCaption) em vez do texto", async () => {
    const startedAt = new Date(Date.now() - 20_000);
    vi.mocked(prisma.scheduledCountdownEdit.findMany).mockResolvedValue([
      {
        id: "cd-6",
        botId: "bot1",
        chatId: 123n,
        messageId: 55,
        markerTemplate: `Expira em ${COUNTDOWN_MARKER}`,
        isCaption: true,
        totalSeconds: 60,
        intervalSeconds: 10,
        deleteOnZero: false,
        startedAt,
        nextTickAt: new Date(),
        finishedAt: null,
      },
    ] as never);

    await processCountdownTicks();

    expect(editMessageCaption).toHaveBeenCalledWith(123, 55, undefined, "Expira em 00:40", { parse_mode: "HTML" });
    expect(editMessageText).not.toHaveBeenCalled();
  });

  it("erro ao editar (ex: mensagem apagada pelo usuário) marca finishedAt em vez de repetir pra sempre", async () => {
    editMessageText.mockRejectedValueOnce(new Error("message to edit not found"));
    vi.mocked(prisma.scheduledCountdownEdit.findMany).mockResolvedValue([
      {
        id: "cd-5",
        botId: "bot1",
        chatId: 123n,
        messageId: 55,
        markerTemplate: `Expira em ${COUNTDOWN_MARKER}`,
        totalSeconds: 60,
        intervalSeconds: 10,
        deleteOnZero: false,
        startedAt: new Date(),
        nextTickAt: new Date(),
        finishedAt: null,
      },
    ] as never);

    await processCountdownTicks();

    expect(prisma.scheduledCountdownEdit.update).toHaveBeenCalledWith({
      where: { id: "cd-5" },
      data: { finishedAt: expect.any(Date) },
    });
  });
});
