import express from "express";
import { Telegraf } from "telegraf";
import { config } from "../config.js";
import { registerAdminCommands } from "./adminCommands.js";
import { registerFlowHandlers } from "./flows.js";

export const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);

bot.catch((err, ctx) => {
  console.error(`[bot] erro não tratado ao processar update "${ctx.updateType}"`, err);
});

registerAdminCommands(bot);
registerFlowHandlers(bot);

// O secret entra tanto no path quanto no `secret_token` do Telegram (checado
// pelo próprio Telegraf via `X-Telegram-Bot-Api-Secret-Token`) — defesa em
// profundidade: mesmo que alguém descubra o path por algum log/proxy, ainda
// precisaria do header que só o Telegram envia.
const WEBHOOK_PATH = `/telegram/webhook/${config.TELEGRAM_WEBHOOK_SECRET}`;

/**
 * Monta o router do webhook e registra a URL no Telegram via `setWebhook`.
 * Assíncrona (retorna `Promise<express.Router>`) porque `setWebhook` precisa
 * ser confirmado antes do processo aceitar tráfego — mesma forma já
 * esboçada no comentário de `src/server.ts`.
 */
export async function createBotWebhookRouter(): Promise<express.Router> {
  const router = express.Router();

  router.use(
    bot.webhookCallback(WEBHOOK_PATH, { secretToken: config.TELEGRAM_WEBHOOK_SECRET })
  );

  const webhookUrl = `${config.PUBLIC_BASE_URL}${WEBHOOK_PATH}`;
  try {
    await bot.telegram.setWebhook(webhookUrl, {
      secret_token: config.TELEGRAM_WEBHOOK_SECRET,
    });
    console.log(`[bot] webhook registrado em ${webhookUrl}`);
  } catch (err) {
    console.error(
      "[bot] falha ao registrar webhook no Telegram (verifique TELEGRAM_BOT_TOKEN/PUBLIC_BASE_URL)",
      err
    );
  }

  return router;
}
