import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/client.js", () => ({
  prisma: {
    scheduledPreviewCleanup: { findMany: vi.fn(), update: vi.fn() },
  },
}));

const deleteMessage = vi.fn();
const sendMessage = vi.fn().mockResolvedValue({ message_id: 999 });
vi.mock("./botManager.js", () => ({
  getTelegraf: vi.fn(() => ({ telegram: { deleteMessage, sendMessage } })),
}));

import { prisma } from "../db/client.js";
import { processPreviewCleanups } from "./previewScheduler.js";

const baseRow = {
  id: "cleanup-1",
  botId: "bot1",
  chatId: 123n,
  messageIds: [10, 11, 12],
  expiredMessage: null,
  expiredShowPlansButton: true,
  deleteAt: new Date(),
  finishedAt: null,
};

describe("processPreviewCleanups", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deleteMessage.mockResolvedValue(true);
  });

  it("apaga cada mensagem do lote e manda a mensagem de expiração com o botão de planos", async () => {
    vi.mocked(prisma.scheduledPreviewCleanup.findMany).mockResolvedValue([baseRow] as never);

    await processPreviewCleanups();

    expect(deleteMessage).toHaveBeenCalledTimes(3);
    expect(deleteMessage).toHaveBeenCalledWith(123, 10);
    expect(deleteMessage).toHaveBeenCalledWith(123, 11);
    expect(deleteMessage).toHaveBeenCalledWith(123, 12);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text, opts] = sendMessage.mock.calls[0];
    expect(chatId).toBe(123);
    expect(text).toContain("prévias expiraram");
    expect((opts as never as { reply_markup: { inline_keyboard: unknown[][] } }).reply_markup.inline_keyboard).toHaveLength(1);

    expect(prisma.scheduledPreviewCleanup.update).toHaveBeenCalledWith({
      where: { id: "cleanup-1" },
      data: { finishedAt: expect.any(Date) },
    });
  });

  it("usa o expiredMessage customizado e omite o botão quando expiredShowPlansButton é false", async () => {
    vi.mocked(prisma.scheduledPreviewCleanup.findMany).mockResolvedValue([
      { ...baseRow, expiredMessage: "Acabou! 😢", expiredShowPlansButton: false },
    ] as never);

    await processPreviewCleanups();

    const [, text, opts] = sendMessage.mock.calls[0];
    expect(text).toBe("Acabou! 😢");
    expect((opts as never as { reply_markup: unknown }).reply_markup).toBeUndefined();
  });

  it("segue apagando as próximas mensagens do lote mesmo se uma falhar (já apagada pelo usuário)", async () => {
    deleteMessage.mockRejectedValueOnce(new Error("message to delete not found")).mockResolvedValue(true);
    vi.mocked(prisma.scheduledPreviewCleanup.findMany).mockResolvedValue([baseRow] as never);

    await processPreviewCleanups();

    expect(deleteMessage).toHaveBeenCalledTimes(3);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(prisma.scheduledPreviewCleanup.update).toHaveBeenCalledWith({
      where: { id: "cleanup-1" },
      data: { finishedAt: expect.any(Date) },
    });
  });
});
