// Seed de dados de exemplo para desenvolvimento local — NÃO roda em produção.
// Uso: npx tsx prisma/seed.ts
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
    create: { key: "boas-vindas", name: "Boas-vindas", isEntryPoint: true },
  });

  const step = await prisma.flowStep.upsert({
    where: { flowId_order: { flowId: flow.id, order: 0 } },
    update: {},
    create: {
      flowId: flow.id,
      order: 0,
      text: "Olá! Bem-vindo(a). Aqui está nossa oferta:",
    },
  });

  const product = await prisma.product.upsert({
    where: { id: "seed-product-ebook" },
    update: {},
    create: {
      id: "seed-product-ebook",
      name: "Ebook de exemplo",
      // Baixo de propósito: a conta SyncPay em teste tem um teto de valor
      // sem taxa ("max_cashin_without_fee") — visto em teste real que
      // R$123,45 foi recusado mas R$1,00 passou. Ver PROJECT_STATE.md.
      priceCents: 100,
      deliveryType: "LINK",
      externalLink: "https://example.com/ebook",
      protectContent: true,
    },
  });

  await prisma.button.upsert({
    where: { flowStepId_order: { flowStepId: step.id, order: 0 } },
    update: {},
    create: {
      flowStepId: step.id,
      order: 0,
      label: "Comprar agora",
      action: "BUY_PRODUCT",
      productId: product.id,
    },
  });

  const leads = await Promise.all(
    [1001, 1002, 1003].map((telegramId, i) =>
      prisma.lead.upsert({
        where: { telegramId: BigInt(telegramId) },
        update: {},
        create: {
          telegramId: BigInt(telegramId),
          username: `lead${i + 1}`,
          firstName: `Lead ${i + 1}`,
          originId: origin.id,
        },
      })
    )
  );

  const statuses = ["PAID", "PAID", "PENDING", "REFUSED"] as const;
  for (let i = 0; i < statuses.length; i++) {
    const chargeId = `seed-charge-${i}`;
    await prisma.order.upsert({
      where: { syncpayChargeId: chargeId },
      update: {},
      create: {
        leadId: leads[i % leads.length].id,
        productId: product.id,
        originId: origin.id,
        syncpayChargeId: chargeId,
        amountCents: product.priceCents,
        status: statuses[i],
        paidAt: statuses[i] === "PAID" ? new Date() : null,
      },
    });
  }

  console.log("Seed concluído.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
