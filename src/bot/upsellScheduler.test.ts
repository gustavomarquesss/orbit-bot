import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/client.js", () => ({
  prisma: {
    upsellSequence: { findUnique: vi.fn() },
    scheduledUpsellSend: { createMany: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    bot: { findUniqueOrThrow: vi.fn() },
  },
}));

const sendMessage = vi.fn();
vi.mock("./botManager.js", () => ({
  getTelegraf: vi.fn(() => ({ telegram: { sendMessage } })),
}));

import { prisma } from "../db/client.js";
import { scheduleUpsellSequence, processScheduledUpsells } from "./upsellScheduler.js";

describe("scheduleUpsellSequence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("não agenda nada se o funil não tem sequência de upsell", async () => {
    vi.mocked(prisma.upsellSequence.findUnique).mockResolvedValue(null);

    await scheduleUpsellSequence("bot1", "lead-1", "flow-1");

    expect(prisma.scheduledUpsellSend.createMany).not.toHaveBeenCalled();
  });

  it("não agenda nada se a sequência está pausada", async () => {
    vi.mocked(prisma.upsellSequence.findUnique).mockResolvedValue({
      id: "seq-1",
      flowId: "flow-1",
      active: false,
      messages: [{ id: "msg-1", delayMinutes: 0 }],
    } as never);

    await scheduleUpsellSequence("bot1", "lead-1", "flow-1");

    expect(prisma.scheduledUpsellSend.createMany).not.toHaveBeenCalled();
  });

  it("cria um ScheduledUpsellSend por mensagem, com sendAt = agora + delayMinutes", async () => {
    vi.mocked(prisma.upsellSequence.findUnique).mockResolvedValue({
      id: "seq-1",
      flowId: "flow-1",
      active: true,
      messages: [
        { id: "msg-1", delayMinutes: 0 },
        { id: "msg-2", delayMinutes: 20 },
      ],
    } as never);

    const before = Date.now();
    await scheduleUpsellSequence("bot1", "lead-1", "flow-1");
    const after = Date.now();

    expect(prisma.scheduledUpsellSend.createMany).toHaveBeenCalledTimes(1);
    const { data } = vi.mocked(prisma.scheduledUpsellSend.createMany).mock.calls[0][0] as {
      data: { messageId: string; leadId: string; botId: string; sendAt: Date }[];
    };
    expect(data).toHaveLength(2);
    expect(data[0]).toMatchObject({ messageId: "msg-1", leadId: "lead-1", botId: "bot1" });
    expect(data[0].sendAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(data[0].sendAt.getTime()).toBeLessThanOrEqual(after);
    const expectedSecondDelay = data[1].sendAt.getTime() - data[0].sendAt.getTime();
    expect(expectedSecondDelay).toBeGreaterThanOrEqual(20 * 60_000 - 1000);
    expect(expectedSecondDelay).toBeLessThanOrEqual(20 * 60_000 + 1000);
  });
});

describe("processScheduledUpsells", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.bot.findUniqueOrThrow).mockResolvedValue({ id: "bot1" } as never);
  });

  it("não faz nada se não há envios vencidos", async () => {
    vi.mocked(prisma.scheduledUpsellSend.findMany).mockResolvedValue([]);

    await processScheduledUpsells();

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("manda a mensagem com botão BUY_PLAN reaproveitando o callback plan:<id>", async () => {
    vi.mocked(prisma.scheduledUpsellSend.findMany).mockResolvedValue([
      {
        id: "send-1",
        botId: "bot1",
        lead: { telegramId: 42n },
        message: {
          text: "Leve também!",
          buttons: [{ text: "Quero", type: "BUY_PLAN", targetPlanId: "plan-2", url: null }],
        },
      },
    ] as never);

    await processScheduledUpsells();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text, opts] = sendMessage.mock.calls[0];
    expect(chatId).toBe(42);
    expect(text).toBe("Leve também!");
    expect(opts.reply_markup.inline_keyboard[0][0].callback_data).toBe("plan:plan-2");
    expect(prisma.scheduledUpsellSend.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "send-1" }, data: expect.objectContaining({ sentAt: expect.any(Date) }) })
    );
  });

  it("manda um botão OPEN_LINK como link de verdade, não callback", async () => {
    vi.mocked(prisma.scheduledUpsellSend.findMany).mockResolvedValue([
      {
        id: "send-2",
        botId: "bot1",
        lead: { telegramId: 42n },
        message: {
          text: "Confira",
          buttons: [{ text: "Ver mais", type: "OPEN_LINK", targetPlanId: null, url: "https://example.com" }],
        },
      },
    ] as never);

    await processScheduledUpsells();

    const [, , opts] = sendMessage.mock.calls[0];
    expect(opts.reply_markup.inline_keyboard[0][0].url).toBe("https://example.com");
    expect(opts.reply_markup.inline_keyboard[0][0].callback_data).toBeUndefined();
  });

  it("marca como enviado mesmo se o bot não estiver registrado (não fica reenviando pra sempre)", async () => {
    const { getTelegraf } = await import("./botManager.js");
    vi.mocked(getTelegraf).mockReturnValueOnce(undefined);
    vi.mocked(prisma.scheduledUpsellSend.findMany).mockResolvedValue([
      { id: "send-3", botId: "bot-inexistente", lead: { telegramId: 1n }, message: { text: "x", buttons: [] } },
    ] as never);

    await processScheduledUpsells();

    expect(sendMessage).not.toHaveBeenCalled();
    expect(prisma.scheduledUpsellSend.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "send-3" } })
    );
  });
});
