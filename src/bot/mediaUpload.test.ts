import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/client.js", () => ({
  prisma: {
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
import { uploadMediaToLibrary } from "./mediaUpload.js";

describe("uploadMediaToLibrary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.settings.findUnique).mockResolvedValue({ id: "singleton", salesChannelId: "-100123" } as never);
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
    vi.mocked(prisma.settings.findUnique).mockResolvedValue({ id: "singleton", salesChannelId: null } as never);
    await expect(
      uploadMediaToLibrary({ botId: "bot-1", buffer: Buffer.from("x"), mimeType: "image/png", filename: "foto.png" })
    ).rejects.toThrow(/configure o canal/i);
    expect(sendPhoto).not.toHaveBeenCalled();
  });
});
