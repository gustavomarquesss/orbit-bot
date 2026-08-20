import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/client.js", () => ({
  prisma: {
    bot: { findUnique: vi.fn() },
    mediaAsset: { create: vi.fn() },
  },
}));

import { prisma } from "../db/client.js";
import { registerMediaCaptureHandler } from "./mediaCapture.js";

function makeBot() {
  const handlers: Record<string, (ctx: unknown) => Promise<void>> = {};
  const bot = {
    on: vi.fn((event: string, handler: (ctx: unknown) => Promise<void>) => {
      handlers[event] = handler;
    }),
  };
  return { bot: bot as never, trigger: (ctx: unknown) => handlers["channel_post"](ctx) };
}

describe("registerMediaCaptureHandler", () => {
  beforeEach(() => vi.clearAllMocks());

  it("captura foto (maior resolução) quando o post é do canal configurado", async () => {
    vi.mocked(prisma.bot.findUnique).mockResolvedValue({ mediaChannelId: "-100123" } as never);
    const { bot, trigger } = makeBot();
    registerMediaCaptureHandler(bot, "bot-1");

    await trigger({
      channelPost: {
        chat: { id: -100123 },
        photo: [{ file_id: "small" }, { file_id: "big" }],
        caption: "Foto de teste",
      },
    });

    expect(prisma.mediaAsset.create).toHaveBeenCalledWith({
      data: { botId: "bot-1", mediaType: "PHOTO", fileId: "big", label: "Foto de teste" },
    });
  });

  it("captura vídeo/áudio/documento pelos campos corretos", async () => {
    vi.mocked(prisma.bot.findUnique).mockResolvedValue({ mediaChannelId: "-100123" } as never);
    const { bot, trigger } = makeBot();
    registerMediaCaptureHandler(bot, "bot-1");

    await trigger({ channelPost: { chat: { id: -100123 }, video: { file_id: "v1" } } });
    await trigger({ channelPost: { chat: { id: -100123 }, audio: { file_id: "a1" } } });
    await trigger({ channelPost: { chat: { id: -100123 }, document: { file_id: "d1" } } });

    expect(prisma.mediaAsset.create).toHaveBeenNthCalledWith(1, {
      data: { botId: "bot-1", mediaType: "VIDEO", fileId: "v1", label: null },
    });
    expect(prisma.mediaAsset.create).toHaveBeenNthCalledWith(2, {
      data: { botId: "bot-1", mediaType: "AUDIO", fileId: "a1", label: null },
    });
    expect(prisma.mediaAsset.create).toHaveBeenNthCalledWith(3, {
      data: { botId: "bot-1", mediaType: "DOCUMENT", fileId: "d1", label: null },
    });
  });

  it("ignora post de um canal diferente do configurado", async () => {
    vi.mocked(prisma.bot.findUnique).mockResolvedValue({ mediaChannelId: "-100123" } as never);
    const { bot, trigger } = makeBot();
    registerMediaCaptureHandler(bot, "bot-1");

    await trigger({ channelPost: { chat: { id: -100999 }, photo: [{ file_id: "x" }] } });

    expect(prisma.mediaAsset.create).not.toHaveBeenCalled();
  });

  it("ignora tudo se o bot não tem mediaChannelId configurado", async () => {
    vi.mocked(prisma.bot.findUnique).mockResolvedValue({ mediaChannelId: null } as never);
    const { bot, trigger } = makeBot();
    registerMediaCaptureHandler(bot, "bot-1");

    await trigger({ channelPost: { chat: { id: -100123 }, photo: [{ file_id: "x" }] } });

    expect(prisma.mediaAsset.create).not.toHaveBeenCalled();
  });

  it("ignora post sem mídia reconhecida (ex: texto puro) sem consultar o banco", async () => {
    const { bot, trigger } = makeBot();
    registerMediaCaptureHandler(bot, "bot-1");

    await trigger({ channelPost: { chat: { id: -100123 }, text: "oi" } });

    expect(prisma.bot.findUnique).not.toHaveBeenCalled();
    expect(prisma.mediaAsset.create).not.toHaveBeenCalled();
  });
});
