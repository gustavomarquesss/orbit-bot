import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

vi.mock("../../db/client.js", () => ({
  prisma: {
    webhookEvent: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    order: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("../../bot/delivery.js", () => ({
  deliverPlanToLead: vi.fn(),
  notifyAdminOfSale: vi.fn(),
  notifyLeadOfApproval: vi.fn(),
}));

vi.mock("../../bot/upsellScheduler.js", () => ({
  scheduleUpsellSequence: vi.fn(),
}));

vi.mock("../../bot/downsellScheduler.js", () => ({
  cancelPendingDownsellsForLead: vi.fn(),
}));

import { prisma } from "../../db/client.js";
import { deliverPlanToLead, notifyAdminOfSale, notifyLeadOfApproval } from "../../bot/delivery.js";
import { scheduleUpsellSequence } from "../../bot/upsellScheduler.js";
import { cancelPendingDownsellsForLead } from "../../bot/downsellScheduler.js";
import { config } from "../../config.js";
import {
  handleSyncpayWebhook,
  isValidWebhookSecret,
  extractExternalId,
  extractStatus,
} from "../webhook.js";

function mockRes(): Response {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

function mockReq(overrides: Partial<Request> = {}): Request {
  return { query: {}, body: {}, ...overrides } as unknown as Request;
}

describe("isValidWebhookSecret", () => {
  it("aceita o secret configurado (SYNCPAY_WEBHOOK_SECRET)", () => {
    expect(isValidWebhookSecret(config.SYNCPAY_WEBHOOK_SECRET)).toBe(true);
  });

  it("rejeita secret incorreto", () => {
    expect(isValidWebhookSecret("secret-errado")).toBe(false);
  });

  it("rejeita ausência de secret", () => {
    expect(isValidWebhookSecret(undefined)).toBe(false);
    expect(isValidWebhookSecret("")).toBe(false);
  });

  it("rejeita valor que não é string", () => {
    expect(isValidWebhookSecret(["array"])).toBe(false);
    expect(isValidWebhookSecret(123)).toBe(false);
  });
});

describe("extractExternalId / extractStatus", () => {
  it("extrai id de idtransaction (minúsculo — campo real da SyncPay) como preferido", () => {
    expect(extractExternalId({ idtransaction: "real", idTransaction: "abc", id: "outro" })).toBe("real");
  });

  it("extrai id de idTransaction quando idtransaction (minúsculo) ausente", () => {
    expect(extractExternalId({ idTransaction: "abc", id: "outro" })).toBe("abc");
  });

  it("cai pro fallback id/transaction_id quando idTransaction ausente", () => {
    expect(extractExternalId({ id: "xyz" })).toBe("xyz");
    expect(extractExternalId({ transaction_id: "qwe" })).toBe("qwe");
  });

  it("retorna undefined se nenhum campo reconhecido está presente", () => {
    expect(extractExternalId({ foo: "bar" })).toBeUndefined();
  });

  it("extrai status de status_transaction como campo preferido", () => {
    expect(extractStatus({ status_transaction: "PAID_OUT", status: "outro" })).toBe("PAID_OUT");
  });
});

describe("handleSyncpayWebhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejeita com 401 quando o secret é inválido, sem tocar no banco", async () => {
    const req = mockReq({ query: { secret: "errado" } });
    const res = mockRes();

    await handleSyncpayWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(prisma.webhookEvent.findUnique).not.toHaveBeenCalled();
  });

  it("rejeita com 401 quando o secret está ausente", async () => {
    const req = mockReq({ query: {} });
    const res = mockRes();

    await handleSyncpayWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("responde 200 sem reprocessar quando o WebhookEvent já tem processedAt (idempotência)", async () => {
    const req = mockReq({
      query: { secret: config.SYNCPAY_WEBHOOK_SECRET },
      body: { idTransaction: "tx-1", status_transaction: "PAID_OUT" },
    });
    const res = mockRes();
    vi.mocked(prisma.webhookEvent.findUnique).mockResolvedValue({
      id: "we-1",
      processedAt: new Date(),
    } as never);

    await handleSyncpayWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ duplicate: true }));
    expect(prisma.order.findUnique).not.toHaveBeenCalled();
    expect(deliverPlanToLead).not.toHaveBeenCalled();
    expect(notifyAdminOfSale).not.toHaveBeenCalled();
  });

  it("responde 200 sem id reconhecível e não toca no banco", async () => {
    const req = mockReq({
      query: { secret: config.SYNCPAY_WEBHOOK_SECRET },
      body: { foo: "bar" },
    });
    const res = mockRes();

    await handleSyncpayWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(prisma.webhookEvent.findUnique).not.toHaveBeenCalled();
  });

  it("marca Order como PAID e chama entrega + notificação na primeira confirmação", async () => {
    const req = mockReq({
      query: { secret: config.SYNCPAY_WEBHOOK_SECRET },
      body: { idTransaction: "tx-2", status_transaction: "PAID_OUT" },
    });
    const res = mockRes();

    const lead = { id: "lead-1", telegramId: 123n };
    const plan = { id: "plan-1", name: "Plano X", deliveryType: "LINK", customDeliveryTarget: null, flow: { welcomeConfig: { defaultDeliveryTarget: "-100999" } } };

    vi.mocked(prisma.webhookEvent.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.webhookEvent.create).mockResolvedValue({
      id: "we-2",
      processedAt: null,
    } as never);
    vi.mocked(prisma.webhookEvent.update).mockResolvedValue({} as never);
    vi.mocked(prisma.order.findUnique).mockResolvedValue({
      id: "order-1",
      botId: "bot1",
      leadId: "lead-1",
      status: "PENDING",
      paidAt: null,
      lead,
      items: [{ plan }],
    } as never);
    vi.mocked(prisma.order.update).mockResolvedValue({
      id: "order-1",
      botId: "bot1",
      status: "PAID",
      paidAt: new Date(),
      lead,
      items: [{ plan }],
    } as never);

    await handleSyncpayWebhook(req, res);

    expect(prisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "order-1" },
        data: expect.objectContaining({ status: "PAID" }),
      })
    );
    expect(deliverPlanToLead).toHaveBeenCalledTimes(1);
    expect(deliverPlanToLead).toHaveBeenCalledWith(
      expect.objectContaining({ botId: "bot1", leadTelegramId: 123n, plan, deliveryTarget: "-100999" })
    );
    expect(notifyAdminOfSale).toHaveBeenCalledTimes(1);
    expect(notifyLeadOfApproval).toHaveBeenCalledTimes(1);
    expect(scheduleUpsellSequence).toHaveBeenCalledTimes(1);
    expect(cancelPendingDownsellsForLead).toHaveBeenCalledWith("lead-1");
    expect(prisma.webhookEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "we-2" },
        data: expect.objectContaining({ processedAt: expect.any(Date) }),
      })
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("processa o payload real da SyncPay, aninhado em `data` (regressão: pagamento real em 2026-08-19 foi ignorado por assumirmos campos no nível raiz)", async () => {
    const req = mockReq({
      query: { secret: config.SYNCPAY_WEBHOOK_SECRET },
      body: {
        data: {
          id: "tx-real",
          idtransaction: "tx-real",
          status: "PAID_OUT",
          amount: 1,
          end_to_end: "E0036030520260819122940e07f4a1f9",
        },
      },
    });
    const res = mockRes();

    const lead = { id: "lead-1", telegramId: 123n };
    const plan = { id: "plan-1", name: "Plano X", deliveryType: "LINK", customDeliveryTarget: null, flow: { welcomeConfig: { defaultDeliveryTarget: "-100999" } } };

    vi.mocked(prisma.webhookEvent.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.webhookEvent.create).mockResolvedValue({ id: "we-real", processedAt: null } as never);
    vi.mocked(prisma.webhookEvent.update).mockResolvedValue({} as never);
    vi.mocked(prisma.order.findUnique).mockResolvedValue({
      id: "order-real",
      botId: "bot1",
      leadId: "lead-1",
      status: "PENDING",
      paidAt: null,
      lead,
      items: [{ plan }],
    } as never);
    vi.mocked(prisma.order.update).mockResolvedValue({
      id: "order-real",
      botId: "bot1",
      status: "PAID",
      paidAt: new Date(),
      lead,
      items: [{ plan }],
    } as never);

    await handleSyncpayWebhook(req, res);

    expect(prisma.order.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { syncpayChargeId: "tx-real" } })
    );
    expect(prisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "PAID" }) })
    );
    expect(deliverPlanToLead).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  });

  it("não chama entrega/notificação de novo se o Order já estava PAID", async () => {
    const req = mockReq({
      query: { secret: config.SYNCPAY_WEBHOOK_SECRET },
      body: { idTransaction: "tx-3", status_transaction: "PAID_OUT" },
    });
    const res = mockRes();

    const lead = { id: "lead-1", telegramId: 123n };
    const plan = { id: "plan-1", name: "Plano X", deliveryType: "LINK", customDeliveryTarget: null, flow: { welcomeConfig: { defaultDeliveryTarget: "-100999" } } };

    vi.mocked(prisma.webhookEvent.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.webhookEvent.create).mockResolvedValue({
      id: "we-3",
      processedAt: null,
    } as never);
    vi.mocked(prisma.webhookEvent.update).mockResolvedValue({} as never);
    vi.mocked(prisma.order.findUnique).mockResolvedValue({
      id: "order-3",
      botId: "bot1",
      status: "PAID",
      paidAt: new Date(),
      lead,
      items: [{ plan }],
    } as never);
    vi.mocked(prisma.order.update).mockResolvedValue({
      id: "order-3",
      botId: "bot1",
      status: "PAID",
      paidAt: new Date(),
      lead,
      items: [{ plan }],
    } as never);

    await handleSyncpayWebhook(req, res);

    expect(deliverPlanToLead).not.toHaveBeenCalled();
    expect(notifyAdminOfSale).not.toHaveBeenCalled();
  });

  it("responde 200 com aviso quando não encontra Order pro syncpayChargeId", async () => {
    const req = mockReq({
      query: { secret: config.SYNCPAY_WEBHOOK_SECRET },
      body: { idTransaction: "tx-4", status_transaction: "PAID_OUT" },
    });
    const res = mockRes();

    vi.mocked(prisma.webhookEvent.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.webhookEvent.create).mockResolvedValue({
      id: "we-4",
      processedAt: null,
    } as never);
    vi.mocked(prisma.webhookEvent.update).mockResolvedValue({} as never);
    vi.mocked(prisma.order.findUnique).mockResolvedValue(null);

    await handleSyncpayWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ warning: expect.any(String) }));
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it("marca REFUSED sem chamar entrega/notificação", async () => {
    const req = mockReq({
      query: { secret: config.SYNCPAY_WEBHOOK_SECRET },
      body: { idTransaction: "tx-5", status_transaction: "REFUSED" },
    });
    const res = mockRes();

    const lead = { id: "lead-1", telegramId: 123n };
    const plan = { id: "plan-1", name: "Plano X", deliveryType: "LINK", customDeliveryTarget: null, flow: { welcomeConfig: { defaultDeliveryTarget: "-100999" } } };

    vi.mocked(prisma.webhookEvent.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.webhookEvent.create).mockResolvedValue({
      id: "we-5",
      processedAt: null,
    } as never);
    vi.mocked(prisma.webhookEvent.update).mockResolvedValue({} as never);
    vi.mocked(prisma.order.findUnique).mockResolvedValue({
      id: "order-5",
      botId: "bot1",
      status: "PENDING",
      paidAt: null,
      lead,
      items: [{ plan }],
    } as never);
    vi.mocked(prisma.order.update).mockResolvedValue({
      id: "order-5",
      botId: "bot1",
      status: "REFUSED",
      paidAt: null,
      lead,
      items: [{ plan }],
    } as never);

    await handleSyncpayWebhook(req, res);

    expect(prisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "REFUSED" }) })
    );
    expect(deliverPlanToLead).not.toHaveBeenCalled();
    expect(notifyAdminOfSale).not.toHaveBeenCalled();
  });
});
