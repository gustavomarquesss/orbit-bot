import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/client.js", () => ({
  prisma: {
    downsellConfig: { findUnique: vi.fn() },
    scheduledDownsellSend: { createMany: vi.fn(), updateMany: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    order: { findFirst: vi.fn() },
    bot: { findUniqueOrThrow: vi.fn() },
  },
}));

const sendMessage = vi.fn();
const sendPhoto = vi.fn();
vi.mock("./botManager.js", () => ({
  getTelegraf: vi.fn(() => ({ telegram: { sendMessage, sendPhoto, sendMediaGroup: vi.fn() } })),
}));

import { prisma } from "../db/client.js";
import {
  scheduleGeneralDownsell,
  scheduleDownsellForOrder,
  cancelPendingDownsellsForLead,
  processScheduledDownsells,
} from "./downsellScheduler.js";

describe("scheduleGeneralDownsell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("não agenda nada se não há DownsellConfig", async () => {
    vi.mocked(prisma.downsellConfig.findUnique).mockResolvedValue(null);

    await scheduleGeneralDownsell("bot1", "lead-1", "flow-1");

    expect(prisma.scheduledDownsellSend.createMany).not.toHaveBeenCalled();
  });

  it("não agenda nada se o Downsell está desativado", async () => {
    vi.mocked(prisma.downsellConfig.findUnique).mockResolvedValue({
      id: "cfg-1",
      active: false,
      sequences: [{ id: "seq-1", delayMinutes: 5 }],
    } as never);

    await scheduleGeneralDownsell("bot1", "lead-1", "flow-1");

    expect(prisma.scheduledDownsellSend.createMany).not.toHaveBeenCalled();
  });

  it("cria um envio por sequência GENERAL ativa, sendAt = agora + delayMinutes", async () => {
    vi.mocked(prisma.downsellConfig.findUnique).mockResolvedValue({
      id: "cfg-1",
      active: true,
      sequences: [{ id: "seq-1", delayMinutes: 5 }],
    } as never);

    const before = Date.now();
    await scheduleGeneralDownsell("bot1", "lead-1", "flow-1");

    expect(prisma.scheduledDownsellSend.createMany).toHaveBeenCalledTimes(1);
    const { data } = vi.mocked(prisma.scheduledDownsellSend.createMany).mock.calls[0][0] as {
      data: { sequenceId: string; leadId: string; botId: string; sendAt: Date }[];
    };
    expect(data).toEqual([expect.objectContaining({ sequenceId: "seq-1", leadId: "lead-1", botId: "bot1" })]);
    expect(data[0].sendAt.getTime()).toBeGreaterThanOrEqual(before + 5 * 60_000 - 1000);
  });
});

describe("scheduleDownsellForOrder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("não agenda nem cancela nada se não há sequência PIX_GENERATED ativa", async () => {
    vi.mocked(prisma.downsellConfig.findUnique).mockResolvedValue({
      id: "cfg-1",
      active: true,
      sequences: [],
    } as never);

    await scheduleDownsellForOrder("bot1", "lead-1", "order-1", "flow-1");

    expect(prisma.scheduledDownsellSend.createMany).not.toHaveBeenCalled();
    expect(prisma.scheduledDownsellSend.updateMany).not.toHaveBeenCalled();
  });

  it("agenda os envios PIX_GENERATED e cancela de vez os GENERAL pendentes do lead", async () => {
    vi.mocked(prisma.downsellConfig.findUnique).mockResolvedValue({
      id: "cfg-1",
      active: true,
      sequences: [{ id: "seq-pix", delayMinutes: 15 }],
    } as never);

    await scheduleDownsellForOrder("bot1", "lead-1", "order-1", "flow-1");

    expect(prisma.scheduledDownsellSend.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ sequenceId: "seq-pix", leadId: "lead-1", botId: "bot1", orderId: "order-1" })],
      })
    );
    expect(prisma.scheduledDownsellSend.updateMany).toHaveBeenCalledWith({
      where: { leadId: "lead-1", orderId: null, sentAt: null, canceledAt: null },
      data: { canceledAt: expect.any(Date) },
    });
  });
});

describe("cancelPendingDownsellsForLead", () => {
  it("cancela todos os envios pendentes (qualquer trigger) do lead", async () => {
    await cancelPendingDownsellsForLead("lead-1");

    expect(prisma.scheduledDownsellSend.updateMany).toHaveBeenCalledWith({
      where: { leadId: "lead-1", sentAt: null, canceledAt: null },
      data: { canceledAt: expect.any(Date) },
    });
  });
});

describe("processScheduledDownsells", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.bot.findUniqueOrThrow).mockResolvedValue({ id: "bot1" } as never);
  });

  it("não faz nada se não há envios vencidos", async () => {
    vi.mocked(prisma.scheduledDownsellSend.findMany).mockResolvedValue([]);

    await processScheduledDownsells();

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("cancela sem enviar se o Order (PIX_GENERATED) já foi pago nesse meio tempo", async () => {
    vi.mocked(prisma.scheduledDownsellSend.findMany).mockResolvedValue([
      {
        id: "send-1",
        botId: "bot1",
        orderId: "order-1",
        order: { status: "PAID" },
        leadId: "lead-1",
        lead: { telegramId: 42n },
        sequence: { active: true, config: { active: true }, message: "x", discountType: "PERCENT", discountValue: 10, media: [], plans: [] },
      },
    ] as never);

    await processScheduledDownsells();

    expect(sendMessage).not.toHaveBeenCalled();
    expect(prisma.scheduledDownsellSend.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "send-1" }, data: expect.objectContaining({ canceledAt: expect.any(Date) }) })
    );
  });

  it("cancela sem enviar um GENERAL se o lead já tiver pago outro Order (rede de segurança)", async () => {
    vi.mocked(prisma.scheduledDownsellSend.findMany).mockResolvedValue([
      {
        id: "send-2",
        botId: "bot1",
        orderId: null,
        order: null,
        leadId: "lead-1",
        lead: { telegramId: 42n },
        sequence: { active: true, config: { active: true }, message: "x", discountType: "PERCENT", discountValue: 10, media: [], plans: [] },
      },
    ] as never);
    vi.mocked(prisma.order.findFirst).mockResolvedValue({ id: "order-pago" } as never);

    await processScheduledDownsells();

    expect(sendMessage).not.toHaveBeenCalled();
    expect(prisma.scheduledDownsellSend.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "send-2" }, data: expect.objectContaining({ canceledAt: expect.any(Date) }) })
    );
  });

  it("manda a mensagem com botão de compra mostrando o preço já com desconto", async () => {
    vi.mocked(prisma.scheduledDownsellSend.findMany).mockResolvedValue([
      {
        id: "send-3",
        botId: "bot1",
        orderId: "order-1",
        order: { status: "PENDING" },
        leadId: "lead-1",
        lead: { telegramId: 42n },
        sequence: {
          id: "seq-1",
          active: true,
          config: { active: true },
          message: "Oferta especial",
          discountType: "PERCENT",
          discountValue: 10,
          media: [],
          plans: [{ planId: "plan-1", plan: { id: "plan-1", name: "Plano X", priceCents: 1000 } }],
        },
      },
    ] as never);

    await processScheduledDownsells();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text, opts] = sendMessage.mock.calls[0];
    expect(chatId).toBe(42);
    expect(text).toBe("Oferta especial");
    const button = opts.reply_markup.inline_keyboard[0][0];
    expect(button.text).toContain("9,00"); // 1000 - 10% = 900 centavos (R$ usa espaço não separável no locale pt-BR)
    expect(button.callback_data).toBe("dsBuy:seq-1:plan-1");
    expect(prisma.scheduledDownsellSend.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "send-3" }, data: expect.objectContaining({ sentAt: expect.any(Date) }) })
    );
  });

  it("não manda (mas marca sentAt) se a sequência ou a config estiverem pausadas", async () => {
    vi.mocked(prisma.scheduledDownsellSend.findMany).mockResolvedValue([
      {
        id: "send-4",
        botId: "bot1",
        orderId: null,
        order: null,
        leadId: "lead-1",
        lead: { telegramId: 42n },
        sequence: { active: false, config: { active: true }, message: "x", discountType: "PERCENT", discountValue: 10, media: [], plans: [] },
      },
    ] as never);
    vi.mocked(prisma.order.findFirst).mockResolvedValue(null);

    await processScheduledDownsells();

    expect(sendMessage).not.toHaveBeenCalled();
    expect(prisma.scheduledDownsellSend.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "send-4" }, data: expect.objectContaining({ sentAt: expect.any(Date) }) })
    );
  });
});
