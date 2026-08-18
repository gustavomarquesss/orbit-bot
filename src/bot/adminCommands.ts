import type { Telegraf, Context } from "telegraf";
import type { ButtonAction, MediaType } from "@prisma/client";
import { prisma } from "../db/client.js";
import { config } from "../config.js";
import { formatBRL, parseBooleanFlag, parsePriceToCents } from "./format.js";
import { nextOrder } from "./util.js";

/**
 * Decisão: em vez de scenes/wizards do Telegraf para os comandos de cadastro
 * (/novoproduto, /novobotao), usamos argumentos posicionais numa única
 * mensagem, com "|" separando campos que podem conter espaço. Motivo: o
 * Render free tier derruba o processo ao dormir/reiniciar, e o estado de uma
 * wizard scene do Telegraf vive em memória (ou exigiria session store
 * persistente, fora de escopo aqui) — perder o meio de um wizard em produção
 * é pior experiência do que digitar uma linha com "|". Também é mais fácil
 * de testar (parsing puro, sem depender de múltiplos turnos de conversa).
 */

function isAdmin(ctx: Context): boolean {
  return ctx.from?.id === config.TELEGRAM_ADMIN_USER_ID;
}

function getCommandArgs(ctx: Context): string {
  const message = ctx.message;
  const text = message && "text" in message ? message.text : "";
  const spaceIdx = text.indexOf(" ");
  return spaceIdx === -1 ? "" : text.slice(spaceIdx + 1).trim();
}

const VALID_BUTTON_ACTIONS: ButtonAction[] = [
  "GOTO_FLOW",
  "BUY_PRODUCT",
  "OPEN_LINK",
  "REDIRECT_CHANNEL",
];

const ORDER_STATUS_LABELS: Record<string, string> = {
  PENDING: "Pendentes",
  PAID: "Pagas",
  REFUSED: "Recusadas",
  EXPIRED: "Expiradas",
};

export function registerAdminCommands(bot: Telegraf): void {
  bot.command("fluxos", async (ctx) => {
    if (!isAdmin(ctx)) return;

    const flows = await prisma.flow.findMany({ orderBy: { createdAt: "asc" } });
    if (flows.length === 0) {
      await ctx.reply("Nenhum fluxo cadastrado ainda. Use /novofluxo <chave> <nome>.");
      return;
    }

    const lines = flows.map((f) => `${f.isEntryPoint ? "★" : "•"} ${f.key} — ${f.name}`);
    await ctx.reply(lines.join("\n"));
  });

  bot.command("novofluxo", async (ctx) => {
    if (!isAdmin(ctx)) return;

    const args = getCommandArgs(ctx);
    const [key, ...rest] = args.split(/\s+/).filter(Boolean);
    const name = rest.join(" ");

    if (!key || !name) {
      await ctx.reply("Uso: /novofluxo <chave> <nome>\nExemplo: /novofluxo boas-vindas Boas-vindas");
      return;
    }

    const existing = await prisma.flow.findUnique({ where: { key } });
    if (existing) {
      await ctx.reply(`Já existe um fluxo com a chave "${key}".`);
      return;
    }

    const flow = await prisma.flow.create({ data: { key, name } });
    await ctx.reply(
      `Fluxo "${flow.name}" (${flow.key}) criado.\n` +
        `Use /novamensagem ${flow.key} <texto> para adicionar o primeiro passo.`
    );
  });

  bot.command("produtos", async (ctx) => {
    if (!isAdmin(ctx)) return;

    const products = await prisma.product.findMany({ orderBy: { createdAt: "asc" } });
    if (products.length === 0) {
      await ctx.reply("Nenhum produto cadastrado ainda. Use /novoproduto.");
      return;
    }

    const lines = products.map(
      (p) =>
        `${p.active ? "✅" : "⛔"} ${p.name} — ${formatBRL(p.priceCents)} (${p.deliveryType})\n` +
        `  id: ${p.id}`
    );
    await ctx.reply(lines.join("\n\n"));
  });

  bot.command("novoproduto", async (ctx) => {
    if (!isAdmin(ctx)) return;

    const args = getCommandArgs(ctx);
    if (!args) {
      await ctx.reply(
        "Uso: /novoproduto <nome> | <preço em R$> | <FILE|LINK> | <message_id do cofre ou link> | <protect_content: sim/não> | <descrição opcional>\n" +
          "Exemplo (arquivo): /novoproduto Ebook Vendas | 29.90 | FILE | 482 | sim | PDF com o passo a passo\n" +
          "Exemplo (link): /novoproduto Mentoria | 199.90 | LINK | https://exemplo.com/acesso | nao"
      );
      return;
    }

    const parts = args.split("|").map((p) => p.trim());
    const [name, priceRaw, deliveryTypeRaw, target, protectRaw, description] = parts;

    if (!name || !priceRaw || !deliveryTypeRaw || !target) {
      await ctx.reply(
        "Faltam campos obrigatórios. Uso: /novoproduto <nome> | <preço> | <FILE|LINK> | <alvo> | <protect sim/não> | <descrição opcional>"
      );
      return;
    }

    const priceCents = parsePriceToCents(priceRaw);
    if (priceCents == null) {
      await ctx.reply(`Preço inválido: "${priceRaw}". Use algo como 29.90`);
      return;
    }

    const deliveryType = deliveryTypeRaw.toUpperCase();
    if (deliveryType !== "FILE" && deliveryType !== "LINK") {
      await ctx.reply('Tipo de entrega inválido. Use "FILE" ou "LINK".');
      return;
    }

    const protectContent = parseBooleanFlag(protectRaw, true);

    const product = await prisma.product.create({
      data: {
        name,
        description: description || null,
        priceCents,
        deliveryType,
        fileTelegramId: deliveryType === "FILE" ? target : null,
        externalLink: deliveryType === "LINK" ? target : null,
        protectContent,
      },
    });

    await ctx.reply(
      `Produto criado: ${product.name} (${formatBRL(product.priceCents)})\n` +
        `id: ${product.id}\n` +
        `Use esse id (ou o nome exato) em /novobotao para vender este produto.`
    );
  });

  bot.command("novamensagem", async (ctx) => {
    if (!isAdmin(ctx)) return;

    const args = getCommandArgs(ctx);
    const firstSpace = args.indexOf(" ");
    const flowKey = firstSpace === -1 ? args : args.slice(0, firstSpace);
    const text = firstSpace === -1 ? "" : args.slice(firstSpace + 1).trim();

    if (!flowKey) {
      await ctx.reply(
        "Uso: /novamensagem <fluxo> <texto>\n" +
          "Dica: para incluir foto/vídeo/áudio/documento, envie a mídia normalmente e depois " +
          "responda a ela (reply) com este comando — o texto do reply vira a legenda."
      );
      return;
    }

    const flow = await prisma.flow.findUnique({ where: { key: flowKey } });
    if (!flow) {
      await ctx.reply(`Fluxo "${flowKey}" não encontrado. Veja /fluxos.`);
      return;
    }

    const message = ctx.message;
    const replyMsg = message && "reply_to_message" in message ? message.reply_to_message : undefined;

    let mediaType: MediaType = "NONE";
    let mediaFileId: string | null = null;

    if (replyMsg) {
      if ("photo" in replyMsg && replyMsg.photo && replyMsg.photo.length > 0) {
        mediaType = "PHOTO";
        mediaFileId = replyMsg.photo[replyMsg.photo.length - 1].file_id;
      } else if ("video" in replyMsg && replyMsg.video) {
        mediaType = "VIDEO";
        mediaFileId = replyMsg.video.file_id;
      } else if ("audio" in replyMsg && replyMsg.audio) {
        mediaType = "AUDIO";
        mediaFileId = replyMsg.audio.file_id;
      } else if ("document" in replyMsg && replyMsg.document) {
        mediaType = "DOCUMENT";
        mediaFileId = replyMsg.document.file_id;
      }
    }

    if (!text && mediaType === "NONE") {
      await ctx.reply("Informe um texto e/ou responda a uma mídia (foto/vídeo/áudio/documento).");
      return;
    }

    const lastStep = await prisma.flowStep.findFirst({
      where: { flowId: flow.id },
      orderBy: { order: "desc" },
    });
    const stepOrder = nextOrder(lastStep?.order);

    const step = await prisma.flowStep.create({
      data: {
        flowId: flow.id,
        order: stepOrder,
        text: text || null,
        mediaType,
        mediaFileId,
      },
    });

    await ctx.reply(
      `Passo ${step.order} adicionado ao fluxo "${flow.key}"` +
        (mediaType !== "NONE" ? ` (mídia: ${mediaType})` : "") +
        `.\nUse /novobotao ${flow.key} ${step.order} para adicionar botões a esse passo.`
    );
  });

  bot.command("novobotao", async (ctx) => {
    if (!isAdmin(ctx)) return;

    const args = getCommandArgs(ctx);
    const match = args.match(/^(\S+)\s+(\d+)\s+([\s\S]+)$/);
    if (!match) {
      await ctx.reply(
        "Uso: /novobotao <fluxo> <ordem_do_passo> <label> | <GOTO_FLOW|BUY_PRODUCT|OPEN_LINK|REDIRECT_CHANNEL> | <destino>\n" +
          "Exemplos:\n" +
          "/novobotao vendas 0 Ver ofertas | GOTO_FLOW | ofertas\n" +
          "/novobotao vendas 0 Comprar agora | BUY_PRODUCT | <id ou nome do produto>\n" +
          "/novobotao vendas 0 Canal VIP | OPEN_LINK | https://t.me/canal"
      );
      return;
    }

    const [, flowKey, orderRaw, rest] = match;
    const stepOrder = Number(orderRaw);
    const [label, actionRaw, target] = rest.split("|").map((p) => p.trim());

    if (!label || !actionRaw) {
      await ctx.reply("Faltam campos. Formato: <label> | <ACTION> | <destino>");
      return;
    }

    const action = actionRaw.toUpperCase() as ButtonAction;
    if (!VALID_BUTTON_ACTIONS.includes(action)) {
      await ctx.reply(`Ação inválida "${actionRaw}". Use uma de: ${VALID_BUTTON_ACTIONS.join(", ")}`);
      return;
    }

    const flow = await prisma.flow.findUnique({ where: { key: flowKey } });
    if (!flow) {
      await ctx.reply(`Fluxo "${flowKey}" não encontrado. Veja /fluxos.`);
      return;
    }

    const step = await prisma.flowStep.findUnique({
      where: { flowId_order: { flowId: flow.id, order: stepOrder } },
    });
    if (!step) {
      await ctx.reply(`Passo ${stepOrder} não encontrado no fluxo "${flowKey}".`);
      return;
    }

    let targetFlowKey: string | null = null;
    let productId: string | null = null;
    let url: string | null = null;

    if (action === "GOTO_FLOW") {
      if (!target) {
        await ctx.reply("Informe a chave do fluxo de destino.");
        return;
      }
      const targetFlow = await prisma.flow.findUnique({ where: { key: target } });
      if (!targetFlow) {
        await ctx.reply(`Fluxo de destino "${target}" não existe.`);
        return;
      }
      targetFlowKey = target;
    } else if (action === "BUY_PRODUCT") {
      if (!target) {
        await ctx.reply("Informe o id (ou nome exato) do produto. Veja /produtos.");
        return;
      }
      const product =
        (await prisma.product.findUnique({ where: { id: target } })) ??
        (await prisma.product.findFirst({ where: { name: { equals: target, mode: "insensitive" } } }));
      if (!product) {
        await ctx.reply(`Produto "${target}" não encontrado. Veja /produtos.`);
        return;
      }
      productId = product.id;
    } else {
      if (!target) {
        await ctx.reply("Informe a URL de destino.");
        return;
      }
      url = target;
    }

    const lastButton = await prisma.button.findFirst({
      where: { flowStepId: step.id },
      orderBy: { order: "desc" },
    });
    const buttonOrder = nextOrder(lastButton?.order);

    await prisma.button.create({
      data: {
        flowStepId: step.id,
        order: buttonOrder,
        label,
        action,
        targetFlowKey,
        productId,
        url,
      },
    });

    await ctx.reply(`Botão "${label}" adicionado ao passo ${stepOrder} do fluxo "${flowKey}".`);
  });

  bot.command("vendas", async (ctx) => {
    if (!isAdmin(ctx)) return;

    const grouped = await prisma.order.groupBy({
      by: ["status"],
      _count: { _all: true },
      _sum: { amountCents: true },
    });

    if (grouped.length === 0) {
      await ctx.reply("Nenhuma venda registrada ainda.");
      return;
    }

    const lines = grouped.map(
      (g) =>
        `${ORDER_STATUS_LABELS[g.status] ?? g.status}: ${g._count._all} (${formatBRL(
          g._sum.amountCents ?? 0
        )})`
    );
    await ctx.reply(`Resumo de vendas:\n\n${lines.join("\n")}`);
  });
}
