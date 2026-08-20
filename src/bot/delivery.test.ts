import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/client.js", () => ({
  prisma: {
    bot: { findUniqueOrThrow: vi.fn() },
    settings: { findUnique: vi.fn() },
    origin: { findUnique: vi.fn() },
  },
}));

const sendMessage = vi.fn();
vi.mock("./botManager.js", () => ({
  getTelegraf: vi.fn(() => ({ telegram: { sendMessage } })),
}));

import { prisma } from "../db/client.js";
import { notifyAdminOfSale, resolveEffectiveDelivery, deliverPlanToLead } from "./delivery.js";

const botRow = { id: "bot1", telegramUsername: "meu_bot" };
const lead = {
  id: "lead-1",
  telegramId: 1117602307n,
  username: "Adrianoberenguel",
  firstName: "Adriano",
  lastName: "Berenguel",
  languageCode: "pt-br",
  isPremium: false,
  // Bem antes do Order — simula um cliente recorrente (primeiro contato há
  // horas). Regressão: "Tempo Conversão" não pode usar essa data, senão
  // acusa horas de "conversão" pra uma compra que levou minutos (bug real
  // reportado pelo usuário em 2026-08-19).
  createdAt: new Date("2026-08-19T08:00:00Z"),
};
const plan = { id: "plan-1", name: "FOTOS E VÍDEOS", durationDays: null };
const item = { id: "item-1", kind: "BASE" as const, unitPriceCents: 1771 };
const order = {
  id: "order-1",
  botId: "bot1",
  originId: null,
  syncpayChargeId: "92097cb2-f1d5-4a22-aa9c-23084cbddcc8",
  createdAt: new Date("2026-08-19T10:00:00Z"),
  paidAt: new Date("2026-08-19T10:03:19Z"),
};

describe("notifyAdminOfSale", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.bot.findUniqueOrThrow).mockResolvedValue(botRow as never);
    vi.mocked(prisma.origin.findUnique).mockResolvedValue(null);
  });

  it("manda pro canal configurado em Settings.salesChannelId quando definido", async () => {
    vi.mocked(prisma.settings.findUnique).mockResolvedValue({
      id: "singleton",
      salesChannelId: "-1009999999999",
    } as never);

    await notifyAdminOfSale({ botId: "bot1", order: order as never, item: item as never, plan: plan as never, lead: lead as never });

    expect(sendMessage).toHaveBeenCalledWith("-1009999999999", expect.any(String));
  });

  it("cai no fallback TELEGRAM_ADMIN_USER_ID quando o canal não está configurado", async () => {
    vi.mocked(prisma.settings.findUnique).mockResolvedValue(null);

    await notifyAdminOfSale({ botId: "bot1", order: order as never, item: item as never, plan: plan as never, lead: lead as never });

    expect(sendMessage).toHaveBeenCalledWith(123456, expect.any(String));
  });

  it("monta a mensagem com todos os campos no formato esperado", async () => {
    vi.mocked(prisma.settings.findUnique).mockResolvedValue({
      id: "singleton",
      salesChannelId: "-1009999999999",
    } as never);

    await notifyAdminOfSale({ botId: "bot1", order: order as never, item: item as never, plan: plan as never, lead: lead as never });

    const message: string = sendMessage.mock.calls[0][1];
    expect(message).toContain("🎉 Pagamento Aprovado!");
    expect(message).toContain("🤖 Bot: @meu_bot");
    expect(message).toContain("🆔 ID Cliente: 1117602307");
    expect(message).toContain("🔗 Username: @Adrianoberenguel");
    expect(message).toContain("👤 Nome de Perfil: Adriano Berenguel");
    expect(message).toContain("🌐 Idioma: pt-br");
    expect(message).toContain("⭐️ Telegram Premium: Não");
    expect(message).toContain("📦 Categoria: Plano Base");
    expect(message).toContain("🎁 Plano: FOTOS E VÍDEOS");
    expect(message).toContain("📅 Duração: Avulso");
    expect(message).toContain("💰 Valor: R$ 17,71");
    expect(message).toContain("⏳ Tempo Conversão: 0d 0h 3m 19s");
    expect(message).toContain("🔖 Código de Venda: start");
    expect(message).toContain(`🔑 ID Transação Interna: ${order.id}`);
    expect(message).toContain(`🏷️ ID Transação Gateway: ${order.syncpayChargeId}`);
    expect(message).toContain("🏦 Plataforma Pagamento: syncpay");
  });

  it("usa o param da Origin como Código de Venda quando existe", async () => {
    vi.mocked(prisma.settings.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.origin.findUnique).mockResolvedValue({ param: "campanha-x", label: "Campanha X" } as never);

    await notifyAdminOfSale({
      botId: "bot1",
      order: { ...order, originId: "origin-1" } as never,
      item: item as never,
      plan: plan as never,
      lead: lead as never,
    });

    const message: string = sendMessage.mock.calls[0][1];
    expect(message).toContain("🔖 Código de Venda: campanha-x");
  });

  it("mostra a duração em dias pra plano de assinatura", async () => {
    vi.mocked(prisma.settings.findUnique).mockResolvedValue(null);

    await notifyAdminOfSale({
      botId: "bot1",
      order: order as never,
      item: item as never,
      plan: { ...plan, durationDays: 30 } as never,
      lead: lead as never,
    });

    const message: string = sendMessage.mock.calls[0][1];
    expect(message).toContain("📅 Duração: 30 dias");
  });
});

const basePlanFields = { id: "plan-1", protectContent: true, messageContent: null };

describe("resolveEffectiveDelivery", () => {
  it("plano com deliveryType próprio usa os campos dele, ignorando o padrão do fluxo", () => {
    const plan = { ...basePlanFields, deliveryType: "LINK" as const, fileTelegramId: null, externalLink: "https://x.com", subscriptionChannelId: null, customDeliveryTarget: null };
    const flowDelivery = { id: "fd-1", flowId: "flow-1", deliveryType: "FILE" as const, deliveryTarget: "-100999", fileTelegramId: "50", externalLink: null, subscriptionChannelId: null };

    expect(resolveEffectiveDelivery(plan, flowDelivery)).toEqual({
      plan: { id: "plan-1", deliveryType: "LINK", fileTelegramId: null, externalLink: "https://x.com", subscriptionChannelId: null, messageContent: null, protectContent: true },
      deliveryTarget: "-100999", // herda do fluxo já que o plano não tem customDeliveryTarget
    });
  });

  it("customDeliveryTarget do plano sobrepõe o padrão do fluxo", () => {
    const plan = { ...basePlanFields, deliveryType: "FILE" as const, fileTelegramId: "10", externalLink: null, subscriptionChannelId: null, customDeliveryTarget: "-100777" };
    const flowDelivery = { id: "fd-1", flowId: "flow-1", deliveryType: "FILE" as const, deliveryTarget: "-100999", fileTelegramId: "50", externalLink: null, subscriptionChannelId: null };

    expect(resolveEffectiveDelivery(plan, flowDelivery)?.deliveryTarget).toBe("-100777");
  });

  it("deliveryType nulo ('usar padrão') herda tipo/arquivo/link inteiros do FlowDelivery", () => {
    const plan = { ...basePlanFields, deliveryType: null, fileTelegramId: null, externalLink: null, subscriptionChannelId: null, customDeliveryTarget: null };
    const flowDelivery = { id: "fd-1", flowId: "flow-1", deliveryType: "FILE" as const, deliveryTarget: "-100999", fileTelegramId: "50", externalLink: null, subscriptionChannelId: null };

    expect(resolveEffectiveDelivery(plan, flowDelivery)).toEqual({
      plan: { id: "plan-1", deliveryType: "FILE", fileTelegramId: "50", externalLink: null, subscriptionChannelId: null, messageContent: null, protectContent: true },
      deliveryTarget: "-100999",
    });
  });

  it("deliveryType nulo sem FlowDelivery configurado retorna null (nada a entregar)", () => {
    const plan = { ...basePlanFields, deliveryType: null, fileTelegramId: null, externalLink: null, subscriptionChannelId: null, customDeliveryTarget: null };
    expect(resolveEffectiveDelivery(plan, null)).toBeNull();
  });

  it("deliveryType nulo herda um FlowDelivery do tipo CHANNEL, incluindo o subscriptionChannelId", () => {
    const plan = { ...basePlanFields, deliveryType: null, fileTelegramId: null, externalLink: null, subscriptionChannelId: null, customDeliveryTarget: null };
    const flowDelivery = { id: "fd-1", flowId: "flow-1", deliveryType: "CHANNEL" as const, deliveryTarget: null, fileTelegramId: null, externalLink: null, subscriptionChannelId: "-100888" };

    expect(resolveEffectiveDelivery(plan, flowDelivery)).toEqual({
      plan: { id: "plan-1", deliveryType: "CHANNEL", fileTelegramId: null, externalLink: null, subscriptionChannelId: "-100888", messageContent: null, protectContent: true },
      deliveryTarget: null,
    });
  });

  it("plano do tipo MESSAGE entrega mandando o texto configurado", async () => {
    sendMessage.mockClear();
    await deliverPlanToLead({
      botId: "bot1",
      leadTelegramId: 123n,
      plan: { id: "pack-1", deliveryType: "MESSAGE", fileTelegramId: null, externalLink: null, subscriptionChannelId: null, messageContent: "Seu acesso já foi liberado!", protectContent: true },
      deliveryTarget: "",
    });
    expect(sendMessage).toHaveBeenCalledWith(123, "Seu acesso já foi liberado!");
  });

  it("plano do tipo MESSAGE preserva o messageContent", () => {
    const plan = { ...basePlanFields, deliveryType: "MESSAGE" as const, fileTelegramId: null, externalLink: null, subscriptionChannelId: null, messageContent: "Seu acesso já foi liberado!", customDeliveryTarget: null };

    expect(resolveEffectiveDelivery(plan, null)).toEqual({
      plan: { id: "plan-1", deliveryType: "MESSAGE", fileTelegramId: null, externalLink: null, subscriptionChannelId: null, messageContent: "Seu acesso já foi liberado!", protectContent: true },
      deliveryTarget: null,
    });
  });
});
