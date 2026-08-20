import type { Telegraf } from "telegraf";
import type { MediaAsset, MediaType } from "@prisma/client";
import { prisma } from "../db/client.js";
import { getTelegraf } from "./botManager.js";
import { probeMp4VideoDimensions } from "./videoProbe.js";
import { extractVideoThumbnail } from "./videoThumbnail.js";

function mediaTypeFromMime(mimeType: string): MediaType {
  if (mimeType.startsWith("image/")) return "PHOTO";
  if (mimeType.startsWith("video/")) return "VIDEO";
  if (mimeType.startsWith("audio/")) return "AUDIO";
  return "DOCUMENT";
}

/** Manda o arquivo pro canal certo conforme o mimetype, e devolve tanto o
 * file_id (só válido pra ESTE bot — reuso via sendPhoto/etc) quanto o
 * message_id (usado por `copyMessage`, que funciona pra qualquer bot com
 * acesso ao canal de origem — ver src/bot/delivery.ts). Compartilhado entre
 * `uploadMediaToLibrary` (biblioteca de mídia reutilizável) e
 * `uploadDeliverableFile` (arquivo entregue ao comprador). */
async function sendMediaByMime(
  telegraf: Telegraf,
  channelId: number,
  buffer: Buffer,
  mimeType: string,
  filename: string
): Promise<{ mediaType: MediaType; fileId: string; messageId: number }> {
  const mediaType = mediaTypeFromMime(mimeType);
  const source = { source: buffer, filename };

  switch (mediaType) {
    case "PHOTO": {
      const sent = await telegraf.telegram.sendPhoto(channelId, source);
      return { mediaType, fileId: sent.photo[sent.photo.length - 1].file_id, messageId: sent.message_id };
    }
    case "VIDEO": {
      // Sem width/height + thumbnail explícitos, a miniatura automática do
      // Telegram pode sair errada (quadrada) antes do vídeo ser aberto —
      // sobretudo em containers não otimizados pra streaming (moov no fim
      // do arquivo), comuns em exports de editores web. Ver videoProbe.ts
      // e videoThumbnail.ts.
      const dims = probeMp4VideoDimensions(buffer);
      const thumb = await extractVideoThumbnail(buffer);
      const extra: { width?: number; height?: number; thumbnail?: { source: Buffer } } = {};
      if (dims) {
        extra.width = dims.width;
        extra.height = dims.height;
      }
      if (thumb) extra.thumbnail = { source: thumb };
      const sent = await telegraf.telegram.sendVideo(channelId, source, Object.keys(extra).length ? extra : undefined);
      return { mediaType, fileId: sent.video.file_id, messageId: sent.message_id };
    }
    case "AUDIO": {
      const sent = await telegraf.telegram.sendAudio(channelId, source);
      return { mediaType, fileId: sent.audio.file_id, messageId: sent.message_id };
    }
    default: {
      const sent = await telegraf.telegram.sendDocument(channelId, source);
      return { mediaType, fileId: sent.document.file_id, messageId: sent.message_id };
    }
  }
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

  const { mediaType, fileId } = await sendMediaByMime(telegraf, channelId, buffer, mimeType, filename);

  return prisma.mediaAsset.create({
    data: { botId, mediaType, fileId, label: filename },
  });
}

/**
 * Sobe o conteúdo que o comprador recebe (Entrega Padrão do Flow ou entrega
 * própria de um Plano) direto pro canal-cofre configurado, sem precisar
 * digitar message_id à mão — pedido do usuário, 2026-08-20, espelhando a
 * referência ApexVips/SharkBot (lá também não existe esse campo manual).
 * Diferente de `uploadMediaToLibrary`: não cria `MediaAsset` (não é mídia
 * reutilizável, é o produto pago em si) e devolve o `message_id`, que é o
 * que `deliverPlanToLead`/`copyMessage` de fato precisam.
 */
export async function uploadDeliverableFile(params: {
  botId: string;
  channelId: string;
  buffer: Buffer;
  mimeType: string;
  filename: string;
}): Promise<{ messageId: number }> {
  const { botId, channelId, buffer, mimeType, filename } = params;
  const telegraf = getTelegraf(botId);
  if (!telegraf) throw new Error("Bot offline — não é possível enviar o arquivo agora.");

  const chatId = Number(channelId);
  if (!Number.isFinite(chatId)) {
    throw new Error(`Canal de entrega inválido: "${channelId}". Configure o "Destino da Entrega" antes de enviar o arquivo.`);
  }

  const { messageId } = await sendMediaByMime(telegraf, chatId, buffer, mimeType, filename);
  return { messageId };
}
