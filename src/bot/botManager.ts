import express from "express";
import { Telegraf } from "telegraf";
import { prisma } from "../db/client.js";
import { config } from "../config.js";
import { decryptSecret } from "../lib/crypto.js";
import { registerAdminCommands } from "./adminCommands.js";
import { registerFlowHandlers } from "./flows.js";

interface BotRow {
  id: string;
  telegramBotTokenEncrypted: string;
  webhookSecret: string;
}

const registry = new Map<string, Telegraf>();

/** Router único, montado uma vez em server.ts — novos bots adicionam suas
 * próprias rotas aqui em runtime (`.use()` funciona depois de montado). */
export const webhookRouter = express.Router();

function webhookPath(botId: string, secret: string): string {
  return `/telegram/webhook/${botId}/${secret}`;
}

/** Valida um token do BotFather chamando getMe — usado pelo painel antes
 * de salvar um Bot novo (lança se o token for inválido). */
export async function validateBotToken(token: string) {
  const telegraf = new Telegraf(token);
  return telegraf.telegram.getMe();
}

async function startInstance(botRow: BotRow): Promise<void> {
  const token = decryptSecret(botRow.telegramBotTokenEncrypted);
  const telegraf = new Telegraf(token);

  telegraf.catch((err, ctx) => {
    console.error(`[bot:${botRow.id}] erro não tratado ao processar update "${ctx.updateType}"`, err);
  });

  registerAdminCommands(telegraf, botRow.id);
  registerFlowHandlers(telegraf, botRow.id);

  const path = webhookPath(botRow.id, botRow.webhookSecret);
  webhookRouter.use(telegraf.webhookCallback(path, { secretToken: botRow.webhookSecret }));

  const webhookUrl = `${config.PUBLIC_BASE_URL}${path}`;
  try {
    await telegraf.telegram.setWebhook(webhookUrl, { secret_token: botRow.webhookSecret });
    console.log(`[bot:${botRow.id}] webhook registrado em ${webhookUrl}`);
  } catch (err) {
    console.error(
      `[bot:${botRow.id}] falha ao registrar webhook (verifique o token/PUBLIC_BASE_URL)`,
      err
    );
  }

  try {
    // Sem isso o Telegram não exibe o botão "Menu" fixo ao lado do campo de
    // texto (fica só o autocomplete ao digitar "/") — precisa ser setado
    // explicitamente, não é o comportamento padrão mesmo com comandos registrados.
    await telegraf.telegram.setChatMenuButton({ menuButton: { type: "commands" } });
  } catch (err) {
    console.error(`[bot:${botRow.id}] falha ao configurar o botão de menu`, err);
  }

  registry.set(botRow.id, telegraf);
}

/** Chamada pelo painel ao cadastrar um bot novo — sobe a instância sem
 * precisar reiniciar o processo. */
export async function registerBot(botId: string): Promise<void> {
  const botRow = await prisma.bot.findUnique({ where: { id: botId } });
  if (!botRow) throw new Error(`registerBot: bot ${botId} não encontrado`);
  await startInstance(botRow);
}

/** Chamada no boot do servidor — sobe todos os bots ativos já cadastrados. */
export async function loadAllBotsFromDb(): Promise<void> {
  const bots = await prisma.bot.findMany({ where: { active: true } });
  for (const botRow of bots) {
    try {
      await startInstance(botRow);
    } catch (err) {
      console.error(`[bot:${botRow.id}] falha ao inicializar`, err);
    }
  }
}

export function getTelegraf(botId: string): Telegraf | undefined {
  return registry.get(botId);
}

/** Chamada pelo painel ao excluir/desativar um bot — remove o webhook do
 * lado do Telegram e tira da memória (não dá pra "desmontar" a rota do
 * Express dinamicamente, mas sem entrada no registry o webhookCallback
 * simplesmente nunca mais casa com nenhum update de verdade). */
export async function unregisterBot(botId: string): Promise<void> {
  const telegraf = registry.get(botId);
  if (!telegraf) return;
  try {
    await telegraf.telegram.deleteWebhook();
  } catch (err) {
    console.error(`[bot:${botId}] falha ao remover webhook do Telegram`, err);
  }
  registry.delete(botId);
}
