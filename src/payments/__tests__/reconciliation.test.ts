import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db/client.js", () => ({
  prisma: {
    order: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("../syncpay.js", async () => {
  const actual = await vi.importActual<typeof import("../syncpay.js")>("../syncpay.js");
  return {
    ...actual,
    getTransactionStatus: vi.fn(),
  };
});

vi.mock("../../bot/delivery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../bot/delivery.js")>();
  return {
    ...actual,
    deliverPlanToLead: vi.fn(),
    notifyAdminOfSale: vi.fn(),
    notifyLeadOfApproval: vi.fn(),
  };
});

vi.mock("../../bot/upsellScheduler.js", () => ({
  scheduleUpsellSequence: vi.fn(),
}));

vi.mock("../../bot/downsellScheduler.js", () => ({
  cancelPendingDownsellsForLead: vi.fn(),
}));

import { prisma } from "../../db/client.js";
import { getTransactionStatus } from "../syncpay.js";
import { deliverPlanToLead, notifyAdminOfSale } from "../../bot/delivery.js";
import { cancelPendingDownsellsForLead } from "../../bot/downsellScheduler.js";
import { pollPendingOrders } from "../reconciliation.js";

const lead = { id: "lead-1", telegramId: 123n };
const plan = {
  id: "plan-1",
  name: "Plano X",
  deliveryType: "LINK",
  externalLink: "https://x",
  customDeliveryTarget: null,
  flow: { delivery: { deliveryTarget: "-100999" }, paymentMessages: null },
};

function orderFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "order-1",
    botId: "bot1",
    leadId: "lead-1",
    status: "PENDING",
    paidAt: null,
    syncpayChargeId: "tx-1",
    lead,
    items: [{ plan }],
    ...overrides,
  };
}

describe("pollPendingOrders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("não faz nada quando não há Orders PENDING", async () => {
    vi.mocked(prisma.order.findMany).mockResolvedValue([]);

    await pollPendingOrders();

    expect(getTransactionStatus).not.toHaveBeenCalled();
  });

  it("ignora status PENDING/desconhecido vindo da SyncPay, sem tocar no Order", async () => {
    vi.mocked(prisma.order.findMany).mockResolvedValue([{ syncpayChargeId: "tx-1" }] as never);
    vi.mocked(getTransactionStatus).mockResolvedValue("pending");

    await pollPendingOrders();

    expect(prisma.order.findUnique).not.toHaveBeenCalled();
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it("marca como PAID e entrega quando a SyncPay reporta pago (caso do postback que nunca chega)", async () => {
    vi.mocked(prisma.order.findMany).mockResolvedValue([{ syncpayChargeId: "tx-1" }] as never);
    vi.mocked(getTransactionStatus).mockResolvedValue("paid");
    vi.mocked(prisma.order.findUnique).mockResolvedValue(orderFixture() as never);
    vi.mocked(prisma.order.update).mockResolvedValue(orderFixture({ status: "PAID", paidAt: new Date() }) as never);

    await pollPendingOrders();

    expect(prisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "order-1" },
        data: expect.objectContaining({ status: "PAID" }),
      })
    );
    expect(deliverPlanToLead).toHaveBeenCalledTimes(1);
    expect(notifyAdminOfSale).toHaveBeenCalledTimes(1);
    expect(cancelPendingDownsellsForLead).toHaveBeenCalledWith("lead-1");
  });

  it("segue pros próximos pedidos se um deles falhar ao consultar a SyncPay", async () => {
    vi.mocked(prisma.order.findMany).mockResolvedValue([
      { syncpayChargeId: "tx-erro" },
      { syncpayChargeId: "tx-1" },
    ] as never);
    vi.mocked(getTransactionStatus).mockImplementation(async (id: string) => {
      if (id === "tx-erro") throw new Error("timeout");
      return "paid";
    });
    vi.mocked(prisma.order.findUnique).mockResolvedValue(orderFixture() as never);
    vi.mocked(prisma.order.update).mockResolvedValue(orderFixture({ status: "PAID" }) as never);

    await pollPendingOrders();

    expect(deliverPlanToLead).toHaveBeenCalledTimes(1);
  });
});
