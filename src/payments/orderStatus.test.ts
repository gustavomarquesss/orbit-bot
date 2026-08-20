import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/client.js", () => ({
  prisma: {
    order: { update: vi.fn() },
    orderItem: { update: vi.fn() },
  },
}));

vi.mock("../bot/delivery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../bot/delivery.js")>();
  return {
    ...actual,
    deliverPlanToLead: vi.fn(),
    notifyAdminOfSale: vi.fn(),
    notifyLeadOfApproval: vi.fn(),
  };
});

vi.mock("../bot/upsellScheduler.js", () => ({
  scheduleUpsellSequence: vi.fn(),
}));

vi.mock("../bot/downsellScheduler.js", () => ({
  cancelPendingDownsellsForLead: vi.fn(),
}));

import { prisma } from "../db/client.js";
import { applyNormalizedStatus, type OrderWithRelations } from "./orderStatus.js";

const lead = { id: "lead-1", telegramId: 123n };

function orderFixture(items: OrderWithRelations["items"]): OrderWithRelations {
  return {
    id: "order-1",
    leadId: "lead-1",
    botId: "bot1",
    status: "PENDING",
    paidAt: null,
    lead,
    items,
  } as unknown as OrderWithRelations;
}

describe("applyNormalizedStatus — accessExpiresAt de assinatura", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marca accessExpiresAt = paidAt + durationDays pra um item de plano com duração", async () => {
    const plan = {
      id: "plan-1",
      durationDays: 30,
      customDeliveryTarget: null,
      deliveryType: "LINK",
      externalLink: "https://x",
      flow: { welcomeConfig: null, paymentMessages: null, id: "flow-1" },
      flowId: "flow-1",
    };
    const item = { id: "item-1", planId: "plan-1", plan } as unknown as OrderWithRelations["items"][number];
    const order = orderFixture([item]);

    const paidAt = new Date("2026-08-20T00:00:00.000Z");
    vi.mocked(prisma.order.update).mockResolvedValue({ ...order, status: "PAID", paidAt, items: [item] } as never);

    await applyNormalizedStatus(order, "PAID");

    expect(prisma.orderItem.update).toHaveBeenCalledWith({
      where: { id: "item-1" },
      data: { accessExpiresAt: new Date(paidAt.getTime() + 30 * 86_400_000) },
    });
  });

  it("não mexe em accessExpiresAt pra um item de plano sem duração (pagamento único)", async () => {
    const plan = {
      id: "plan-2",
      durationDays: null,
      customDeliveryTarget: null,
      deliveryType: "LINK",
      externalLink: "https://x",
      flow: { welcomeConfig: null, paymentMessages: null, id: "flow-1" },
      flowId: "flow-1",
    };
    const item = { id: "item-2", planId: "plan-2", plan } as unknown as OrderWithRelations["items"][number];
    const order = orderFixture([item]);

    vi.mocked(prisma.order.update).mockResolvedValue({ ...order, status: "PAID", paidAt: new Date(), items: [item] } as never);

    await applyNormalizedStatus(order, "PAID");

    expect(prisma.orderItem.update).not.toHaveBeenCalled();
  });
});
