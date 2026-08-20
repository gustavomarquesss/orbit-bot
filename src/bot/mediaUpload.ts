import type { MediaAsset, MediaType } from "@prisma/client";
import { prisma } from "../db/client.js";
import { getTelegraf } from "./botManager.js";

function mediaTypeFromMime(mimeType: string): MediaType {
  if (mimeType.startsWith("image/")) return "PHOTO";
  if (mimeType.startsWith("video/")) return "VIDEO";
  if (mimeType.startsWith("audio/")) return "AUDIO";
  return "DOCUMENT";
}

/**
 * Upload direto pela tela (drag-and-drop em /admin/bots/:id/media) — sobe o
 * arquivo pro Telegram via `Settings.salesChannelId` (mesmo canal da
 * notificação de vendas, reaproveitado como "canal de registro" de mídia
 * também — decisão do usuário, 2026-08-20, espelhando a referência
 * ApexVips) usando o Bot dono do upload, e guarda o file_id resultante.
 * Sem passo manual no Telegram — diferente da primeira versão desta
 * feature (listener de channel_post), descartada por não bater com o que
 * o usuário pediu.
 */
export async function uploadMediaToLibrary(params: {
  botId: string;
  buffer: Buffer;
  mimeType: string;
  filename: string;
}): Promise<MediaAsset> {
  const { botId, buffer, mimeType, filename } = params;
  const telegraf = getTelegraf(botId);
  if (!telegraf) throw new Error("Bot offline — não é possível enviar mídia agora.");

  const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
  if (!settings?.salesChannelId) {
    throw new Error("Configure o canal de vendas/mídias em Configurações antes de enviar arquivos.");
  }
  const channelId = Number(settings.salesChannelId);
  if (!Number.isFinite(channelId)) {
    throw new Error(`Canal configurado em Configurações é inválido: "${settings.salesChannelId}".`);
  }

  const mediaType = mediaTypeFromMime(mimeType);
  const source = { source: buffer, filename };

  let fileId: string;
  switch (mediaType) {
    case "PHOTO": {
      const sent = await telegraf.telegram.sendPhoto(channelId, source);
      fileId = sent.photo[sent.photo.length - 1].file_id;
      break;
    }
    case "VIDEO": {
      const sent = await telegraf.telegram.sendVideo(channelId, source);
      fileId = sent.video.file_id;
      break;
    }
    case "AUDIO": {
      const sent = await telegraf.telegram.sendAudio(channelId, source);
      fileId = sent.audio.file_id;
      break;
    }
    default: {
      const sent = await telegraf.telegram.sendDocument(channelId, source);
      fileId = sent.document.file_id;
      break;
    }
  }

  return prisma.mediaAsset.create({
    data: { botId, mediaType, fileId, label: filename },
  });
}
