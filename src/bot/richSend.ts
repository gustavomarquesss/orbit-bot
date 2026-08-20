import type { InlineKeyboardButton } from "telegraf/types";
import type { Lead, Bot } from "@prisma/client";
import {
  renderTemplate,
  extractMessageEffectId,
  prepareCountdownMarker,
  parseButtonLabel,
  type CountdownDirective,
} from "./templating.js";
import { registerCountdown } from "./countdownScheduler.js";

export interface PreparedText {
  text: string;
  /** Só usado em `sendMessage`/`sendPhoto`/etc — Bot API só aceita em chat
   * privado, no envio inicial (não em edição). Todo lugar que chama isso
   * hoje só manda DM pro lead, então não precisa checar o tipo do chat. */
  effectId?: string;
  countdownDirective?: CountdownDirective;
}

/**
 * Resolve variáveis (`renderTemplate`) e extrai as duas diretivas que não
 * viram texto: `{effect:...}` (vira `message_effect_id` na chamada de
 * envio) e `{countdown:...}` (o marcador sobrevive no `text` resultante —
 * ver `registerCountdownIfNeeded` pra completar o registro do contador ao
 * vivo depois que a mensagem foi enviada de verdade e se sabe o
 * chatId/messageId).
 */
export function prepareRichText(
  rawTemplate: string | null | undefined,
  context: { lead: Lead; bot: Pick<Bot, "displayName" | "telegramUsername">; extra?: Record<string, string> }
): PreparedText {
  if (!rawTemplate) return { text: "" };
  const countdownPrep = prepareCountdownMarker(rawTemplate);
  const text = renderTemplate(countdownPrep ? countdownPrep.markerTemplate : rawTemplate, context);
  const effectId = extractMessageEffectId(rawTemplate);
  return { text, effectId, countdownDirective: countdownPrep?.directive };
}

/**
 * Completa o registro do contador ao vivo depois que a mensagem preparada
 * por `prepareRichText` foi de fato enviada — sem-op se não havia
 * `{countdown:...}` no template original. Falha aqui não derruba o envio
 * (a mensagem já foi mandada com o valor inicial correto; só o "ao vivo"
 * some, fica só logado).
 */
export async function registerCountdownIfNeeded(
  prepared: PreparedText,
  params: { botId: string; chatId: number | bigint; messageId: number; isCaption?: boolean }
): Promise<void> {
  if (!prepared.countdownDirective) return;
  try {
    await registerCountdown({
      botId: params.botId,
      chatId: params.chatId,
      messageId: params.messageId,
      markerTemplate: prepared.text,
      directive: prepared.countdownDirective,
      isCaption: params.isCaption,
    });
  } catch (err) {
    console.error("[richSend] falha ao registrar countdown ao vivo", err);
  }
}

/** Bot API 9.4 (fev/2026) adicionou `style` a InlineKeyboardButton/
 * KeyboardButton — telegraf 4.16.3 (a instalada, a mais recente publicada)
 * ainda não conhece o campo nos types, daí o cast manual aqui. */
type StyledInlineKeyboardButton = InlineKeyboardButton & { style?: "primary" | "success" | "danger" };

/** Constrói um botão de callback aplicando a cor real (`{#FF0000}` etc no
 * final do texto editável do admin) via `parseButtonLabel`. */
export function styledCallbackButton(rawLabel: string, callbackData: string): InlineKeyboardButton {
  const { text, style } = parseButtonLabel(rawLabel);
  const button: StyledInlineKeyboardButton = { text, callback_data: callbackData };
  if (style) button.style = style;
  return button;
}

/** Mesma ideia de `styledCallbackButton`, pra botões de URL externa. */
export function styledUrlButton(rawLabel: string, url: string): InlineKeyboardButton {
  const { text, style } = parseButtonLabel(rawLabel);
  const button: StyledInlineKeyboardButton = { text, url };
  if (style) button.style = style;
  return button;
}
