import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/client.js", () => ({
  prisma: {
    flowBot: { findFirst: vi.fn() },
    bot: { findUniqueOrThrow: vi.fn() },
  },
}));

vi.mock("../payments/orders.js", () => ({ createOrderAndCharge: vi.fn() }));

vi.mock("./deepLink.js", () => ({
  resolveOriginAndUpsertLead: vi.fn(),
  touchLead: vi.fn(),
}));

vi.mock("./downsellScheduler.js", () => ({
  scheduleGeneralDownsell: vi.fn(),
  scheduleDownsellForOrder: vi.fn(),
}));

vi.mock("./richSend.js", () => ({
  prepareRichText: vi.fn((text: string | null) => ({ text: text || "" })),
  registerCountdownIfNeeded: vi.fn(),
  styledCallbackButton: vi.fn((text: string, cb: string) => ({ text, callback_data: cb })),
  styledUrlButton: vi.fn((text: string, url: string) => ({ text, url })),
}));

import { prisma } from "../db/client.js";
import { resolveOriginAndUpsertLead } from "./deepLink.js";
import { registerFlowHandlers } from "./flows.js";

function makeBot() {
  let startHandler: ((ctx: unknown) => Promise<void>) | null = null;
  const bot = {
    start: vi.fn((handler: (ctx: unknown) => Promise<void>) => {
      startHandler = handler;
    }),
    action: vi.fn(),
  };
  return { bot: bot as never, trigger: (ctx: unknown) => startHandler!(ctx) };
}

function makeCtx() {
  return {
    startPayload: undefined,
    chat: { id: 123 },
    reply: vi.fn().mockResolvedValue({ message_id: 1 }),
  };
}

const lead = { id: "lead-1", firstName: "Ana", telegramId: 123n };
const plans = [{ id: "plan-1", name: "Mensal", priceCents: 2990 }];

describe("/start — CTA desligado cai direto nos planos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveOriginAndUpsertLead).mockResolvedValue({ lead, isNewLead: false } as never);
    vi.mocked(prisma.bot.findUniqueOrThrow).mockResolvedValue({ id: "bot-1", displayName: "Bot", telegramUsername: "meubot" } as never);
  });

  it("sem CTA e com planos, manda a lista de planos logo após as boas-vindas", async () => {
    vi.mocked(prisma.flowBot.findFirst).mockResolvedValue({
      flow: {
        id: "flow-1",
        welcomeConfig: { text: "Oi!", ctaButtonEnabled: false, ctaLabel: null, media: [], redirectButtons: [], miniAppEnabled: false, secondaryMessageEnabled: false },
        plans,
      },
    } as never);
    const { bot, trigger } = makeBot();
    registerFlowHandlers(bot, "bot-1");
    const ctx = makeCtx();

    await trigger(ctx);

    expect(ctx.reply).toHaveBeenCalledTimes(2);
    expect(ctx.reply).toHaveBeenNthCalledWith(2, "Escolha um plano:", expect.objectContaining({ reply_markup: expect.anything() }));
  });

  it("com CTA ligado, NÃO manda a lista de planos automaticamente (espera o clique)", async () => {
    vi.mocked(prisma.flowBot.findFirst).mockResolvedValue({
      flow: {
        id: "flow-1",
        welcomeConfig: { text: "Oi!", ctaButtonEnabled: true, ctaLabel: "Ver planos", media: [], redirectButtons: [], miniAppEnabled: false, secondaryMessageEnabled: false },
        plans,
      },
    } as never);
    const { bot, trigger } = makeBot();
    registerFlowHandlers(bot, "bot-1");
    const ctx = makeCtx();

    await trigger(ctx);

    expect(ctx.reply).toHaveBeenCalledTimes(1);
  });

  it("sem CTA mas também sem planos cadastrados, não tenta mandar lista vazia", async () => {
    vi.mocked(prisma.flowBot.findFirst).mockResolvedValue({
      flow: {
        id: "flow-1",
        welcomeConfig: { text: "Oi!", ctaButtonEnabled: false, ctaLabel: null, media: [], redirectButtons: [], miniAppEnabled: false, secondaryMessageEnabled: false },
        plans: [],
      },
    } as never);
    const { bot, trigger } = makeBot();
    registerFlowHandlers(bot, "bot-1");
    const ctx = makeCtx();

    await trigger(ctx);

    expect(ctx.reply).toHaveBeenCalledTimes(1);
  });
});
