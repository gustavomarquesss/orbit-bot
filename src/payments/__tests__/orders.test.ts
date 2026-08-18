import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db/client.js", () => ({
  prisma: {
    lead: { findUnique: vi.fn() },
    product: { findUnique: vi.fn() },
    order: { create: vi.fn() },
  },
}));

vi.mock("../syncpay.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../syncpay.js")>();
  return { ...actual, createCharge: vi.fn() };
});

import { prisma } from "../../db/client.js";
import { createCharge } from "../syncpay.js";
import { createOrderAndCharge } from "../orders.js";

describe("createOrderAndCharge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lança erro claro se o lead não existe", async () => {
    vi.mocked(prisma.lead.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.product.findUnique).mockResolvedValue({
      id: "p1",
      active: true,
      name: "X",
      priceCents: 100,
    } as never);

    await expect(
      createOrderAndCharge({ leadId: "lead-x", productId: "p1" })
    ).rejects.toThrow(/lead lead-x não encontrado/);
    expect(createCharge).not.toHaveBeenCalled();
  });

  it("lança erro claro se o produto não existe", async () => {
    vi.mocked(prisma.lead.findUnique).mockResolvedValue({
      id: "lead-1",
      telegramId: 1n,
    } as never);
    vi.mocked(prisma.product.findUnique).mockResolvedValue(null);

    await expect(
      createOrderAndCharge({ leadId: "lead-1", productId: "p-x" })
    ).rejects.toThrow(/produto p-x não encontrado/);
    expect(createCharge).not.toHaveBeenCalled();
  });

  it("lança erro claro se o produto está inativo", async () => {
    vi.mocked(prisma.lead.findUnique).mockResolvedValue({
      id: "lead-1",
      telegramId: 1n,
    } as never);
    vi.mocked(prisma.product.findUnique).mockResolvedValue({
      id: "p1",
      name: "X",
      active: false,
      priceCents: 100,
    } as never);

    await expect(
      createOrderAndCharge({ leadId: "lead-1", productId: "p1" })
    ).rejects.toThrow(/está inativo/);
    expect(createCharge).not.toHaveBeenCalled();
  });

  it("chama createCharge com o valor do produto e cria o Order com os dados retornados", async () => {
    vi.mocked(prisma.lead.findUnique).mockResolvedValue({
      id: "lead-1",
      telegramId: 42n,
      firstName: "Fulano",
      username: null,
    } as never);
    vi.mocked(prisma.product.findUnique).mockResolvedValue({
      id: "p1",
      name: "Produto X",
      active: true,
      priceCents: 5000,
    } as never);
    vi.mocked(createCharge).mockResolvedValue({
      externalId: "tx-1",
      pixCopyPaste: "codigo-pix",
      qrCodeUrl: "data:image/png;base64,abc",
      expiresAt: new Date(),
    });
    vi.mocked(prisma.order.create).mockResolvedValue({
      id: "order-1",
      leadId: "lead-1",
      productId: "p1",
      syncpayChargeId: "tx-1",
      status: "PENDING",
    } as never);

    const result = await createOrderAndCharge({ leadId: "lead-1", productId: "p1" });

    expect(createCharge).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 5000, description: "Produto X" })
    );
    expect(prisma.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          leadId: "lead-1",
          productId: "p1",
          syncpayChargeId: "tx-1",
          status: "PENDING",
          amountCents: 5000,
          pixCopyPaste: "codigo-pix",
          qrCodeUrl: "data:image/png;base64,abc",
        }),
      })
    );
    expect(result.pixCopyPaste).toBe("codigo-pix");
    expect(result.qrCodeUrl).toBe("data:image/png;base64,abc");
  });

  it("propaga SyncPayError sem criar Order quando a gateway recusa a cobrança", async () => {
    vi.mocked(prisma.lead.findUnique).mockResolvedValue({
      id: "lead-1",
      telegramId: 42n,
      firstName: "Fulano",
      username: null,
    } as never);
    vi.mocked(prisma.product.findUnique).mockResolvedValue({
      id: "p1",
      name: "Produto X",
      active: true,
      priceCents: 5000,
    } as never);
    vi.mocked(createCharge).mockRejectedValue(new Error("gateway fora do ar"));

    await expect(
      createOrderAndCharge({ leadId: "lead-1", productId: "p1" })
    ).rejects.toThrow(/gateway fora do ar/);
    expect(prisma.order.create).not.toHaveBeenCalled();
  });
});
