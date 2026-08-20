import { prisma } from "../db/client.js";
import { decryptSecret } from "../lib/crypto.js";

export interface SyncPayCredentials {
  ownerId: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
}

/** Resolve as credenciais SyncPay do DONO do Bot informado — cada usuário
 * vende na própria conta (Fase 3 Milestone 3), não mais numa conta fixa
 * compartilhada. Lança um erro claro se o usuário ainda não configurou a
 * própria conta em /admin/settings. */
export async function resolveSyncPayCredentialsForBot(botId: string): Promise<SyncPayCredentials> {
  const bot = await prisma.bot.findUnique({ where: { id: botId }, select: { ownerId: true } });
  if (!bot) throw new Error(`resolveSyncPayCredentialsForBot: bot ${botId} não encontrado.`);
  return resolveSyncPayCredentialsForOwner(bot.ownerId);
}

export async function resolveSyncPayCredentialsForOwner(ownerId: string): Promise<SyncPayCredentials> {
  const settings = await prisma.settings.findUnique({ where: { ownerId } });
  if (!settings?.syncpayClientId || !settings.syncpayClientSecretEncrypted || !settings.syncpayWebhookSecret) {
    throw new Error("Configure sua conta SyncPay em Configurações antes de vender.");
  }
  return {
    ownerId,
    clientId: settings.syncpayClientId,
    clientSecret: decryptSecret(settings.syncpayClientSecretEncrypted),
    webhookSecret: settings.syncpayWebhookSecret,
  };
}

/** Só o segredo do webhook (não exige client_id/secret configurados) —
 * usado pra validar a requisição em src/payments/webhook.ts ANTES de
 * confiar em qualquer outra coisa do payload. */
export async function getSyncpayWebhookSecretForOwner(ownerId: string): Promise<string | null> {
  const settings = await prisma.settings.findUnique({ where: { ownerId }, select: { syncpayWebhookSecret: true } });
  return settings?.syncpayWebhookSecret ?? null;
}
