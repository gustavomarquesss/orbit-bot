import type { Telegraf } from "telegraf";
import type { Message } from "telegraf/types";
import type { MediaType } from "@prisma/client";
import { prisma } from "../db/client.js";

interface ExtractedMedia {
  mediaType: MediaType;
  fileId: string;
}

/** Um file_id do Telegram só é válido pro bot que recebeu a mídia — por
 * isso a captura sempre grava vinculada ao `botId` que recebeu o post,
 * nunca compartilhada entre bots (ver nota no schema, model MediaAsset). */
function extractMedia(post: Message): ExtractedMedia | null {
  if ("photo" in post && post.photo.length > 0) {
    // Último item = maior resolução disponível.
    return { mediaType: "PHOTO", fileId: post.photo[post.photo.length - 1].file_id };
  }
  if ("video" in post) return { mediaType: "VIDEO", fileId: post.video.file_id };
  if ("audio" in post) return { mediaType: "AUDIO", fileId: post.audio.file_id };
  if ("document" in post) return { mediaType: "DOCUMENT", fileId: post.document.file_id };
  return null;
}

/**
 * Escuta `channel_post` em busca de mídia postada no canal configurado em
 * `Bot.mediaChannelId` — captura o file_id automaticamente numa
 * `MediaAsset`, poupando o admin de mandar a mídia manualmente pro bot e
 * copiar o file_id retornado pra colar no painel. Consulta o
 * `mediaChannelId` fresco no banco a cada post (não fica em cache na
 * closure) pra refletir mudanças feitas no painel sem precisar reiniciar
 * o processo.
 */
export function registerMediaCaptureHandler(bot: Telegraf, botId: string): void {
  bot.on("channel_post", async (ctx) => {
    const post = ctx.channelPost;
    const extracted = extractMedia(post);
    if (!extracted) return;

    const botRow = await prisma.bot.findUnique({ where: { id: botId } });
    if (!botRow?.mediaChannelId) return;
    if (post.chat.id.toString() !== botRow.mediaChannelId) return;

    const label = "caption" in post ? post.caption ?? null : null;
    await prisma.mediaAsset.create({
      data: { botId, mediaType: extracted.mediaType, fileId: extracted.fileId, label },
    });
  });
}
