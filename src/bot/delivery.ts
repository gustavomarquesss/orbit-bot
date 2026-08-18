import type { Order, Product, Lead } from "@prisma/client";
import { bot } from "./index.js";
import { config } from "../config.js";
import { prisma } from "../db/client.js";
import { formatBRL } from "./format.js";

/**
 * `Product.fileTelegramId` guarda o `message_id` (como string) da mensagem
 * do produto já postada no canal-cofre — não um `file_id`. A entrega usa
 * `telegram.copyMessage(destino, canalCofre, message_id)`, que exige um
 * `message_id` dentro do canal de origem; não existe uma chamada da Bot API
 * que copie/reenvie uma mensagem a partir de um `file_id` isolado preservando
 * legenda/mídia originais. Guardar o `message_id` também é mais simples pro
 * operador: ele só precisa encaminhar o produto pro canal-cofre uma vez e
 * copiar o número da mensagem, sem precisar extrair um `file_id` manualmente.
 * A coluna manteve o nome `fileTelegramId` (evitando uma migration só de
 * rename antes do schema ainda ter migrations reais) — ver ARCHITECTURE.md.
 */
export async function deliverProductToLead(params: {
  leadTelegramId: bigint;
  product: Product;
}): Promise<void> {
  const { leadTelegramId, product } = params;
  const chatId = Number(leadTelegramId);

  if (product.deliveryType === "LINK") {
    if (!product.externalLink) {
      throw new Error(`Produto ${product.id} é do tipo LINK mas não tem externalLink configurado`);
    }
    await bot.telegram.sendMessage(chatId, `Aqui está seu acesso:\n${product.externalLink}`);
    return;
  }

  if (!product.fileTelegramId) {
    throw new Error(`Produto ${product.id} é do tipo FILE mas não tem fileTelegramId (message_id) configurado`);
  }

  const messageId = Number(product.fileTelegramId);
  if (!Number.isFinite(messageId)) {
    throw new Error(
      `fileTelegramId inválido para o produto ${product.id}: "${product.fileTelegramId}" (esperado um message_id numérico)`
    );
  }

  await bot.telegram.copyMessage(chatId, config.TELEGRAM_VAULT_CHANNEL_ID, messageId, {
    protect_content: product.protectContent,
  });
}

/**
 * Envia alerta de venda aprovada pro TELEGRAM_ADMIN_USER_ID. `order.originId`
 * é resolvido aqui (via Prisma) porque o contrato de `notifyAdminOfSale` não
 * inclui a Origin diretamente — mantém a assinatura estável para quem chama.
 */
export async function notifyAdminOfSale(params: {
  order: Order;
  product: Product;
  lead: Lead;
}): Promise<void> {
  const { order, product, lead } = params;

  const leadLabel = lead.username
    ? `@${lead.username}`
    : [lead.firstName, lead.lastName].filter(Boolean).join(" ") || lead.telegramId.toString();

  const origin = order.originId
    ? await prisma.origin.findUnique({ where: { id: order.originId } })
    : null;

  const lines = [
    "Nova venda aprovada!",
    `Produto: ${product.name}`,
    `Valor: ${formatBRL(order.amountCents)}`,
    `Cliente: ${leadLabel} (id ${lead.telegramId.toString()})`,
  ];
  if (origin) {
    lines.push(`Origem: ${origin.label} (${origin.param})`);
  }

  await bot.telegram.sendMessage(config.TELEGRAM_ADMIN_USER_ID, lines.join("\n"));
}
