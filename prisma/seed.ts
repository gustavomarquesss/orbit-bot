// Seed de dados de exemplo para desenvolvimento local — NÃO roda em produção.
// Uso: npx tsx prisma/seed.ts
//
// Não cria um Bot de exemplo com token fake — bots precisam de um token real
// (validado via getMe contra a API do Telegram) e são cadastrados pelo
// painel (/admin/bots/new). Este seed só popula Origin/Flow/Plan pra dar um
// funil pra vincular ao bot depois de cadastrado manualmente.
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const origin = await prisma.origin.upsert({
    where: { param: "canal-principal" },
    update: {},
    create: { param: "canal-principal", label: "Canal principal", kind: "CHANNEL" },
  });

  const flow = await prisma.flow.upsert({
    where: { key: "boas-vindas" },
    update: {},
    create: { key: "boas-vindas", name: "Boas-vindas" },
  });

  await prisma.welcomeConfig.upsert({
    where: { flowId: flow.id },
    update: {},
    create: {
      flowId: flow.id,
      text: "Olá {nome}! {saudacao}, bem-vindo(a) ao @{bot.username}.",
      ctaButtonEnabled: true,
      ctaLabel: "Ver planos",
    },
  });

  await prisma.plan.upsert({
    where: { id: "seed-plan-ebook" },
    update: {},
    create: {
      id: "seed-plan-ebook",
      flowId: flow.id,
      name: "Ebook de exemplo",
      // Baixo de propósito: a conta SyncPay em teste tem um teto de valor
      // sem taxa ("max_cashin_without_fee") — visto em teste real que
      // R$123,45 foi recusado mas R$1,00 passou. Ver PROJECT_STATE.md.
      priceCents: 100,
      deliveryType: "LINK",
      externalLink: "https://example.com/ebook",
      protectContent: true,
      order: 0,
    },
  });

  console.log("Seed concluído. Origin + Flow + Plan de exemplo criados.");
  console.log(`Flow "${flow.key}" (id ${flow.id}) — vincule a um Bot pelo painel: /admin/bots`);
  console.log(`Origin de exemplo: ${origin.param}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
