import express, { Router, type Request, type Response, type NextFunction } from "express";
import session from "express-session";
import createPgSessionStore from "connect-pg-simple";
import pg from "pg";
import { timingSafeEqual } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../db/client.js";
import { config } from "../config.js";
import { createBotsRouter } from "./botsRoutes.js";
import { createFlowsRouter } from "./flowsRoutes.js";
import { createMailingRouter } from "./mailingRoutes.js";
import { applyDiscount } from "../bot/downsellMessage.js";
import { withSuccess } from "./toastUtil.js";

// Pool dedicado do connect-pg-simple (ele gerencia sua própria tabela de
// sessões, "session", criada automaticamente com createTableIfMissing).
// Evita depender do MemoryStore padrão do express-session, que vaza memória
// e perde todas as sessões a cada restart do processo — inaceitável numa VPS
// always-on de longa duração.
const sessionPool = new pg.Pool({ connectionString: config.DATABASE_URL });
const PgSessionStore = createPgSessionStore(session);

declare module "express-session" {
  interface SessionData {
    isAdmin?: boolean;
  }
}

function passwordMatches(input: string): boolean {
  const expected = Buffer.from(config.ADMIN_PANEL_PASSWORD);
  const given = Buffer.from(input);
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}

function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (req.session.isAdmin) return next();
  res.redirect("/admin/login");
}

function formatBRL(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function formatSecondsDuration(totalSeconds: number | null): string {
  if (totalSeconds == null) return "—";
  const s = Math.max(0, Math.round(totalSeconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// Brasil não observa horário de verão desde 2019 — deslocamento fixo é
// suficiente pra calcular o início do dia local sem precisar de lib de
// timezone nova. Só afeta os cortes "hoje"/"ontem" do dashboard.
const BR_OFFSET_MS = 3 * 60 * 60 * 1000;

function startOfDayBR(date: Date): Date {
  const shifted = new Date(date.getTime() - BR_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() + BR_OFFSET_MS);
}

/**
 * Resolve o período do dashboard em um intervalo de datas. `start`/`end`
 * limitam as métricas (`end: null` = até agora); `chartStart` limita só o
 * gráfico de cobranças por dia — em "total" as métricas continuam
 * all-time, mas o gráfico é limitado aos últimos 90 dias (um gráfico com
 * um bar por dia desde o início do projeto não seria legível nem útil).
 */
function resolvePeriodRange(period: string): { start: Date; end: Date | null; chartStart: Date } {
  const todayStart = startOfDayBR(new Date());
  const daysAgo = (n: number) => new Date(todayStart.getTime() - n * 86_400_000);

  switch (period) {
    case "hoje":
      return { start: todayStart, end: null, chartStart: todayStart };
    case "ontem":
      return { start: daysAgo(1), end: todayStart, chartStart: daysAgo(1) };
    case "30d":
      return { start: daysAgo(29), end: null, chartStart: daysAgo(29) };
    case "total":
      return { start: new Date(0), end: null, chartStart: daysAgo(89) };
    case "7d":
    default:
      return { start: daysAgo(6), end: null, chartStart: daysAgo(6) };
  }
}

export function createAdminRouter(): Router {
  const router = Router();

  router.use(express.urlencoded({ extended: true }));
  router.use(
    session({
      store: new PgSessionStore({ pool: sessionPool, tableName: "session", createTableIfMissing: true }),
      secret: config.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        secure: config.NODE_ENV === "production",
        maxAge: 1000 * 60 * 60 * 12, // 12h
      },
    })
  );
  router.use((req, res, next) => {
    res.locals.formatBRL = formatBRL;
    res.locals.applyDiscount = applyDiscount;
    next();
  });

  router.get("/login", (req, res) => {
    if (req.session.isAdmin) return res.redirect("/admin");
    res.render("login", { error: null });
  });

  router.post("/login", (req, res) => {
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (password && passwordMatches(password)) {
      req.session.isAdmin = true;
      return res.redirect("/admin");
    }
    res.status(401).render("login", { error: "Senha incorreta." });
  });

  router.post("/logout", (req, res) => {
    req.session.destroy(() => res.redirect("/admin/login"));
  });

  router.use(requireAuth);

  router.use("/bots", createBotsRouter());
  router.use("/flows", createFlowsRouter());
  router.use("/mailing", createMailingRouter());

  router.get("/settings", async (_req, res) => {
    const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
    res.render("settings", { settings: settings ?? { salesChannelId: null } });
  });

  router.post("/settings", async (req, res) => {
    const salesChannelId =
      typeof req.body?.salesChannelId === "string" && req.body.salesChannelId.trim()
        ? req.body.salesChannelId.trim()
        : null;

    await prisma.settings.upsert({
      where: { id: "singleton" },
      update: { salesChannelId },
      create: { id: "singleton", salesChannelId },
    });

    res.redirect(withSuccess("/admin/settings", "Configurações salvas com sucesso!"));
  });

  router.get("/", async (req, res) => {
    const bots = await prisma.bot.findMany({ orderBy: { createdAt: "asc" } });

    const botId = typeof req.query.botId === "string" && req.query.botId ? req.query.botId : null;
    const period = typeof req.query.period === "string" ? req.query.period : "7d";
    const { start, end, chartStart } = resolvePeriodRange(period);

    const botFilter = botId ? { botId } : {};
    // "Vendas aprovadas"/ticket médio/tempo médio/ranking são todos sobre
    // QUANDO a venda foi paga (paidAt), não quando o PIX foi gerado — bate
    // com o que já foi corrigido no canal de vendas (Fase 2, Milestone 2).
    const paidWhere = {
      status: "PAID" as const,
      paidAt: { gte: start, ...(end ? { lt: end } : {}) },
      ...botFilter,
    };
    const createdWhere = { createdAt: { gte: start, ...(end ? { lt: end } : {}) }, ...botFilter };
    const leadWhere = { createdAt: { gte: start, ...(end ? { lt: end } : {}) }, ...botFilter };

    const [
      approvedAgg,
      createdStatusCounts,
      startsCount,
      convertedLeadsCount,
      avgTicketAgg,
      avgTimeRows,
      originGroups,
      recentLeads,
      recentOrdersCreated,
      recentOrdersPaid,
      dailyOrdersRaw,
    ] = await Promise.all([
      prisma.order.aggregate({ where: paidWhere, _sum: { amountCents: true }, _count: { _all: true } }),
      prisma.order.groupBy({ by: ["status"], where: createdWhere, _count: { _all: true } }),
      prisma.lead.count({ where: leadWhere }),
      prisma.lead.count({ where: { ...leadWhere, orders: { some: { status: "PAID" } } } }),
      prisma.order.aggregate({ where: paidWhere, _avg: { amountCents: true } }),
      prisma.$queryRaw<Array<{ avg_seconds: number | null }>>(Prisma.sql`
        SELECT AVG(EXTRACT(EPOCH FROM ("paidAt" - "createdAt"))) AS avg_seconds
        FROM "Order"
        WHERE status = 'PAID' AND "paidAt" >= ${start}
        ${end ? Prisma.sql`AND "paidAt" < ${end}` : Prisma.empty}
        ${botId ? Prisma.sql`AND "botId" = ${botId}` : Prisma.empty}
      `),
      prisma.order.groupBy({
        by: ["originId"],
        where: paidWhere,
        _sum: { amountCents: true },
        _count: { _all: true },
        orderBy: { _sum: { amountCents: "desc" } },
        take: 5,
      }),
      prisma.lead.findMany({
        where: botFilter,
        orderBy: { createdAt: "desc" },
        take: 20,
        include: { bot: { select: { label: true } } },
      }),
      prisma.order.findMany({
        where: botFilter,
        orderBy: { createdAt: "desc" },
        take: 20,
        include: { lead: true, items: { include: { plan: true } } },
      }),
      prisma.order.findMany({
        where: { ...botFilter, status: "PAID" },
        orderBy: { paidAt: "desc" },
        take: 20,
        include: { lead: true, items: { include: { plan: true } } },
      }),
      prisma.$queryRaw<Array<{ day: Date; count: bigint }>>(Prisma.sql`
        SELECT date_trunc('day', "createdAt") AS day, COUNT(*) AS count
        FROM "Order"
        WHERE "createdAt" >= ${chartStart}
        ${botId ? Prisma.sql`AND "botId" = ${botId}` : Prisma.empty}
        GROUP BY day
        ORDER BY day ASC
      `),
    ]);

    const createdCounts = { PENDING: 0, PAID: 0, REFUSED: 0, EXPIRED: 0 } as Record<string, number>;
    for (const row of createdStatusCounts) createdCounts[row.status] = row._count._all;
    const totalGenerated = Object.values(createdCounts).reduce((a, b) => a + b, 0);
    const paymentConversionRate = totalGenerated > 0 ? (createdCounts.PAID / totalGenerated) * 100 : 0;
    const userConversionRate = startsCount > 0 ? (convertedLeadsCount / startsCount) * 100 : 0;

    const originIds = originGroups.map((g) => g.originId).filter((id): id is string => id != null);
    const origins = await prisma.origin.findMany({ where: { id: { in: originIds } } });
    const originById = new Map(origins.map((o) => [o.id, o]));
    const originRanking = originGroups.map((g) => ({
      label: g.originId ? originById.get(g.originId)?.label ?? g.originId : "Direto (sem código)",
      param: g.originId ? originById.get(g.originId)?.param ?? "?" : "start",
      revenueCents: g._sum.amountCents ?? 0,
      count: g._count._all,
    }));

    interface ActivityEvent {
      at: Date;
      kind: "lead" | "pix" | "sale";
      label: string;
      sub: string;
    }
    const planNames = (o: (typeof recentOrdersCreated)[number]) => o.items.map((i) => i.plan.name).join(" + ");
    const leadLabel = (lead: { username: string | null; firstName: string | null; id: string }) =>
      lead.username ? `@${lead.username}` : lead.firstName || lead.id;
    const events: ActivityEvent[] = [
      ...recentLeads.map((l) => ({
        at: l.createdAt,
        kind: "lead" as const,
        label: `Novo lead — ${leadLabel(l)}`,
        sub: l.bot.label,
      })),
      ...recentOrdersCreated.map((o) => ({
        at: o.createdAt,
        kind: "pix" as const,
        label: `PIX gerado — ${planNames(o)} (${formatBRL(o.amountCents)})`,
        sub: leadLabel(o.lead),
      })),
      ...recentOrdersPaid.map((o) => ({
        at: o.paidAt!,
        kind: "sale" as const,
        label: `Venda aprovada — ${planNames(o)} (${formatBRL(o.amountCents)})`,
        sub: leadLabel(o.lead),
      })),
    ];
    events.sort((a, b) => b.at.getTime() - a.at.getTime());

    res.render("dashboard", {
      bots,
      selectedBotId: botId ?? "",
      selectedPeriod: period,
      approvedCount: approvedAgg._count._all,
      revenueCents: approvedAgg._sum.amountCents ?? 0,
      avgTicketCents: avgTicketAgg._avg.amountCents ?? 0,
      avgTimeLabel: formatSecondsDuration(avgTimeRows[0]?.avg_seconds ?? null),
      startsCount,
      userConversionRate,
      paymentConversionRate,
      createdCounts,
      originRanking,
      activityLog: events.slice(0, 20),
      dailyOrders: dailyOrdersRaw.map((r) => ({ day: r.day, count: Number(r.count) })),
    });
  });

  return router;
}
