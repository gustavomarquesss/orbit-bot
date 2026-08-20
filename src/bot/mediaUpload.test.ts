import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/client.js", () => ({
  prisma: {
    bot: { findUnique: vi.fn() },
    settings: { findUnique: vi.fn() },
    mediaAsset: { create: vi.fn() },
  },
}));

const sendPhoto = vi.fn();
const sendVideo = vi.fn();
const sendAudio = vi.fn();
const sendDocument = vi.fn();
vi.mock("./botManager.js", () => ({
  getTelegraf: vi.fn(() => ({ telegram: { sendPhoto, sendVideo, sendAudio, sendDocument } })),
}));

import { prisma } from "../db/client.js";
import { getTelegraf } from "./botManager.js";
import { uploadMediaToLibrary, uploadDeliverableFile } from "./mediaUpload.js";

describe("uploadMediaToLibrary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.bot.findUnique).mockResolvedValue({ ownerId: "owner-1" } as never);
    vi.mocked(prisma.settings.findUnique).mockResolvedValue({ id: "settings-1", ownerId: "owner-1", salesChannelId: "-100123" } as never);
  });

  it("sobe foto via sendPhoto e usa a maior resolução como file_id", async () => {
    sendPhoto.mockResolvedValue({ photo: [{ file_id: "small" }, { file_id: "big" }] });
    vi.mocked(prisma.mediaAsset.create).mockResolvedValue({ id: "asset-1" } as never);

    await uploadMediaToLibrary({ botId: "bot-1", buffer: Buffer.from("x"), mimeType: "image/png", filename: "foto.png" });

    expect(sendPhoto).toHaveBeenCalledWith(-100123, { source: expect.any(Buffer), filename: "foto.png" });
    expect(prisma.mediaAsset.create).toHaveBeenCalledWith({
      data: { botId: "bot-1", mediaType: "PHOTO", fileId: "big", label: "foto.png" },
    });
  });

  it("sobe vídeo via sendVideo", async () => {
    sendVideo.mockResolvedValue({ video: { file_id: "v1" } });
    await uploadMediaToLibrary({ botId: "bot-1", buffer: Buffer.from("x"), mimeType: "video/mp4", filename: "clipe.mp4" });
    expect(sendVideo).toHaveBeenCalled();
    expect(prisma.mediaAsset.create).toHaveBeenCalledWith({
      data: { botId: "bot-1", mediaType: "VIDEO", fileId: "v1", label: "clipe.mp4" },
    });
  });

  it("sobe áudio via sendAudio", async () => {
    sendAudio.mockResolvedValue({ audio: { file_id: "a1" } });
    await uploadMediaToLibrary({ botId: "bot-1", buffer: Buffer.from("x"), mimeType: "audio/ogg", filename: "som.ogg" });
    expect(sendAudio).toHaveBeenCalled();
    expect(prisma.mediaAsset.create).toHaveBeenCalledWith({
      data: { botId: "bot-1", mediaType: "AUDIO", fileId: "a1", label: "som.ogg" },
    });
  });

  it("mimetype não reconhecido cai em sendDocument", async () => {
    sendDocument.mockResolvedValue({ document: { file_id: "d1" } });
    await uploadMediaToLibrary({ botId: "bot-1", buffer: Buffer.from("x"), mimeType: "application/pdf", filename: "arquivo.pdf" });
    expect(sendDocument).toHaveBeenCalled();
    expect(prisma.mediaAsset.create).toHaveBeenCalledWith({
      data: { botId: "bot-1", mediaType: "DOCUMENT", fileId: "d1", label: "arquivo.pdf" },
    });
  });

  it("lança erro claro se o bot não está registrado/online", async () => {
    vi.mocked(getTelegraf).mockReturnValueOnce(undefined);
    await expect(
      uploadMediaToLibrary({ botId: "bot-1", buffer: Buffer.from("x"), mimeType: "image/png", filename: "foto.png" })
    ).rejects.toThrow(/offline/i);
    expect(prisma.mediaAsset.create).not.toHaveBeenCalled();
  });

  it("lança erro claro se o canal de vendas/mídias não está configurado", async () => {
    vi.mocked(prisma.settings.findUnique).mockResolvedValue({ id: "settings-1", ownerId: "owner-1", salesChannelId: null } as never);
    await expect(
      uploadMediaToLibrary({ botId: "bot-1", buffer: Buffer.from("x"), mimeType: "image/png", filename: "foto.png" })
    ).rejects.toThrow(/configure o canal/i);
    expect(sendPhoto).not.toHaveBeenCalled();
  });
});

describe("uploadDeliverableFile", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sobe o arquivo pro canal-cofre informado e devolve o message_id (não o file_id)", async () => {
    sendDocument.mockResolvedValue({ document: { file_id: "d1" }, message_id: 482 });

    const result = await uploadDeliverableFile({
      botId: "bot-1",
      channelId: "-1004465630850",
      buffer: Buffer.from("x"),
      mimeType: "application/pdf",
      filename: "curso.pdf",
    });

    expect(sendDocument).toHaveBeenCalledWith(-1004465630850, { source: expect.any(Buffer), filename: "curso.pdf" });
    expect(result).toEqual({ messageId: 482 });
    expect(prisma.mediaAsset.create).not.toHaveBeenCalled();
  });

  it("lança erro claro se o bot não está registrado/online", async () => {
    vi.mocked(getTelegraf).mockReturnValueOnce(undefined);
    await expect(
      uploadDeliverableFile({ botId: "bot-1", channelId: "-100123", buffer: Buffer.from("x"), mimeType: "application/pdf", filename: "x.pdf" })
    ).rejects.toThrow(/offline/i);
  });

  it("lança erro claro se o canal de entrega configurado é inválido", async () => {
    await expect(
      uploadDeliverableFile({ botId: "bot-1", channelId: "não-é-um-id", buffer: Buffer.from("x"), mimeType: "application/pdf", filename: "x.pdf" })
    ).rejects.toThrow(/canal de entrega inválido/i);
    expect(sendDocument).not.toHaveBeenCalled();
  });
});
