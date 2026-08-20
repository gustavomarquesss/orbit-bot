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

  it("sem CTA e com planos, os botões de plano já saem na própria mensagem de boas-vindas (sem mensagem 'Escolha um plano:' à parte)", async () => {
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

    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const [, opts] = ctx.reply.mock.calls[0];
    const buttons = opts.reply_markup.inline_keyboard.flat();
    expect(buttons).toHaveLength(1);
    expect(buttons[0].callback_data).toBe("plan:plan-1");
    expect(buttons[0].text).toContain("Mensal");
    expect(buttons[0].text).toContain("29,90");
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
