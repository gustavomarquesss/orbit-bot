import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/client.js", () => ({
  prisma: {
    orderItem: { findMany: vi.fn(), update: vi.fn() },
    bot: { findUniqueOrThrow: vi.fn() },
  },
}));

const sendMessage = vi.fn();
const banChatMember = vi.fn();
const unbanChatMember = vi.fn();
vi.mock("../bot/botManager.js", () => ({
  getTelegraf: vi.fn(() => ({ telegram: { sendMessage, banChatMember, unbanChatMember } })),
}));

import { prisma } from "../db/client.js";
import { sendRenewalReminders, revokeExpiredAccess } from "./subscriptionScheduler.js";

const lead = { telegramId: 42n };
const order = { botId: "bot1", lead };

describe("sendRenewalReminders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.bot.findUniqueOrThrow).mockResolvedValue({ id: "bot1" } as never);
  });

  it("não faz nada se não há itens vencendo na janela", async () => {
    vi.mocked(prisma.orderItem.findMany).mockResolvedValue([]);

    await sendRenewalReminders();

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("manda o lembrete com botão que reaproveita o callback plan:<id>", async () => {
    vi.mocked(prisma.orderItem.findMany).mockResolvedValue([
      {
        id: "item-1",
        planId: "plan-1",
        order,
        plan: { id: "plan-1", name: "Plano VIP", priceCents: 2990, flow: { paymentMessages: null } },
      },
    ] as never);

    await sendRenewalReminders();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text, opts] = sendMessage.mock.calls[0];
    expect(chatId).toBe(42);
    expect(text).toContain("Plano VIP");
    expect(opts.reply_markup.inline_keyboard[0][0].callback_data).toBe("plan:plan-1");
    expect(prisma.orderItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "item-1" }, data: expect.objectContaining({ renewalReminderSentAt: expect.any(Date) }) })
    );
  });

  it("usa o template customizado (renewalMessage) quando configurado", async () => {
    vi.mocked(prisma.orderItem.findMany).mockResolvedValue([
      {
        id: "item-2",
        planId: "plan-1",
        order,
        plan: { id: "plan-1", name: "Plano VIP", priceCents: 2990, flow: { paymentMessages: { renewalMessage: "Oi {nome}, renova aí!" } } },
      },
    ] as never);

    await sendRenewalReminders();

    const [, text] = sendMessage.mock.calls[0];
    expect(text).toBe("Oi , renova aí!"); // {nome} vira vazio (lead sem firstName no fixture)
  });
});

describe("revokeExpiredAccess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("não faz nada se não há itens vencidos", async () => {
    vi.mocked(prisma.orderItem.findMany).mockResolvedValue([]);

    await revokeExpiredAccess();

    expect(banChatMember).not.toHaveBeenCalled();
  });

  it("kicka (ban+unban) do canal VIP planos DeliveryType.CHANNEL vencidos", async () => {
    vi.mocked(prisma.orderItem.findMany).mockResolvedValue([
      {
        id: "item-3",
        order,
        plan: { id: "plan-1", deliveryType: "CHANNEL", subscriptionChannelId: "-100123" },
      },
    ] as never);

    await revokeExpiredAccess();

    expect(banChatMember).toHaveBeenCalledWith(-100123, 42);
    expect(unbanChatMember).toHaveBeenCalledWith(-100123, 42, { only_if_banned: true });
    expect(prisma.orderItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "item-3" }, data: expect.objectContaining({ revokedAt: expect.any(Date) }) })
    );
  });

  it("não mexe no Telegram pra planos FILE/LINK vencidos, só marca revokedAt (não tem o que revogar)", async () => {
    vi.mocked(prisma.orderItem.findMany).mockResolvedValue([
      {
        id: "item-4",
        order,
        plan: { id: "plan-2", deliveryType: "LINK", subscriptionChannelId: null },
      },
    ] as never);

    await revokeExpiredAccess();

    expect(banChatMember).not.toHaveBeenCalled();
    expect(prisma.orderItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "item-4" }, data: expect.objectContaining({ revokedAt: expect.any(Date) }) })
    );
  });
});
