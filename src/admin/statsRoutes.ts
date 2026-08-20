import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../db/client.js";
import { withSuccess } from "./toastUtil.js";
import { resolvePeriodRange } from "./metricsUtil.js";

const WEEKDAY_LABELS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

export function createStatsRouter(): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    const ownerId = req.session.userId!;
    const bots = await prisma.bot.findMany({ where: { ownerId }, orderBy: { createdAt: "asc" } });
    const ownerBotIds = bots.map((b) => b.id);
    // Só aceita um botId da query string se pertencer a este usuário — sem
    // isso, cai no conjunto de todos os bots dele (nunca do sistema todo).
    const requestedBotId = typeof req.query.botId === "string" && req.query.botId ? req.query.botId : null;
    const botId = requestedBotId && ownerBotIds.includes(requestedBotId) ? requestedBotId : null;
    const period = typeof req.query.period === "string" ? req.query.period : "7d";
    const { start, end } = resolvePeriodRange(period);

    const botFilter = botId ? { botId } : { botId: { in: ownerBotIds } };
    const paidWhere = { status: "PAID" as const, paidAt: { gte: start, ...(end ? { lt: end } : {}) }, ...botFilter };
    const createdWhere = { createdAt: { gte: start, ...(end ? { lt: end } : {}) }, ...botFilter };

    // Fragmentos SQL reaproveitados nas queries raw abaixo — cada tabela usa
    // o alias que fizer sentido pro seu próprio JOIN.
    const paidAtRange = (col: Prisma.Sql) =>
      Prisma.sql`${col} >= ${start} ${end ? Prisma.sql`AND ${col} < ${end}` : Prisma.empty}`;
    const botCond = (col: Prisma.Sql) =>
      botId
        ? Prisma.sql`AND ${col} = ${botId}`
        : ownerBotIds.length > 0
          ? Prisma.sql`AND ${col} IN (${Prisma.join(ownerBotIds)})`
          : Prisma.sql`AND FALSE`;

    const [
      // Grupo 1 — Vendas por tempo
      salesByHourRaw,
      salesByWeekdayRaw,
      top7DaysRaw,
      // Grupo 2 — Rankings de produto
      topBotsGroups,
      topFlowsRaw,
      topPlansRaw,
      topTickets,
      // Grupo 3 — Funil + taxas
      startsCount,
      createdStatusCounts,
      upsellSends,
      downsellGeneralSends,
      recoverySends,
      paidOrdersWithItems,
      // Grupo 4 — Assinatura
      paidOrdersForLtv,
      latestSubItems,
      returnTimeRows,
      // Fontes de tráfego
      originGroups10,
      // Diário de mudanças
      notes,
    ] = await Promise.all([
      prisma.$queryRaw<Array<{ hour: number; count: bigint }>>(Prisma.sql`
        SELECT EXTRACT(HOUR FROM "paidAt" - interval '3 hours')::int AS hour, COUNT(*) AS count
        FROM "Order"
        WHERE status = 'PAID' AND ${paidAtRange(Prisma.sql`"paidAt"`)} ${botCond(Prisma.sql`"botId"`)}
        GROUP BY hour ORDER BY hour ASC
      `),
      prisma.$queryRaw<Array<{ dow: number; count: bigint }>>(Prisma.sql`
        SELECT EXTRACT(DOW FROM "paidAt" - interval '3 hours')::int AS dow, COUNT(*) AS count
        FROM "Order"
        WHERE status = 'PAID' AND ${paidAtRange(Prisma.sql`"paidAt"`)} ${botCond(Prisma.sql`"botId"`)}
        GROUP BY dow ORDER BY dow ASC
      `),
      // Shift -3h/+3h faz o corte de dia bater com o calendário BR (mesma
      // ideia de `startOfDayBR`), senão o dia exibido fica atrasado pro
      // fuso local de quem estiver vendo o painel.
      prisma.$queryRaw<Array<{ day: Date; revenue: bigint }>>(Prisma.sql`
        SELECT date_trunc('day', "paidAt" - interval '3 hours') + interval '3 hours' AS day, SUM("amountCents") AS revenue
        FROM "Order"
        WHERE status = 'PAID' AND "paidAt" >= ${new Date(Date.now() - 90 * 86_400_000)} ${botCond(Prisma.sql`"botId"`)}
        GROUP BY day ORDER BY revenue DESC LIMIT 7
      `),
      prisma.order.groupBy({
        by: ["botId"],
        where: paidWhere,
        _sum: { amountCents: true },
        _count: { _all: true },
        orderBy: { _sum: { amountCents: "desc" } },
        take: 5,
      }),
      prisma.$queryRaw<Array<{ flowId: string; flowName: string; revenue: bigint; count: bigint }>>(Prisma.sql`
        SELECT f.id AS "flowId", f.name AS "flowName", SUM(oi."unitPriceCents") AS revenue, COUNT(*) AS count
        FROM "OrderItem" oi
        JOIN "Order" o ON o.id = oi."orderId"
        JOIN "Plan" p ON p.id = oi."planId"
        JOIN "Flow" f ON f.id = p."flowId"
        WHERE o.status = 'PAID' AND oi.kind = 'BASE' AND ${paidAtRange(Prisma.sql`o."paidAt"`)} ${botCond(Prisma.sql`o."botId"`)}
        GROUP BY f.id, f.name ORDER BY revenue DESC LIMIT 5
      `),
      prisma.$queryRaw<Array<{ planId: string; planName: string; productType: string; revenue: bigint; count: bigint }>>(Prisma.sql`
        SELECT p.id AS "planId", p.name AS "planName", p."productType" AS "productType", SUM(oi."unitPriceCents") AS revenue, COUNT(*) AS count
        FROM "OrderItem" oi
        JOIN "Order" o ON o.id = oi."orderId"
        JOIN "Plan" p ON p.id = oi."planId"
        WHERE o.status = 'PAID' AND oi.kind = 'BASE' AND ${paidAtRange(Prisma.sql`o."paidAt"`)} ${botCond(Prisma.sql`o."botId"`)}
        GROUP BY p.id, p.name, p."productType" ORDER BY revenue DESC LIMIT 5
      `),
      prisma.order.findMany({
        where: paidWhere,
        orderBy: { amountCents: "desc" },
        take: 5,
        include: { lead: true, items: { include: { plan: true } } },
      }),
      prisma.lead.count({ where: createdWhere }),
      prisma.order.groupBy({ by: ["status"], where: createdWhere, _count: { _all: true } }),
      prisma.scheduledUpsellSend.findMany({
        where: { sentAt: { gte: start, ...(end ? { lt: end } : {}) }, ...botFilter },
        select: { leadId: true, sentAt: true },
      }),
      prisma.scheduledDownsellSend.findMany({
        where: {
          sentAt: { gte: start, ...(end ? { lt: end } : {}) },
          sequence: { trigger: "GENERAL" },
          ...botFilter,
        },
        select: { leadId: true },
      }),
      prisma.scheduledDownsellSend.findMany({
        where: {
          sentAt: { gte: start, ...(end ? { lt: end } : {}) },
          sequence: { trigger: "PIX_GENERATED" },
          ...botFilter,
        },
        select: { orderId: true },
      }),
      prisma.order.findMany({
        where: paidWhere,
        select: { id: true, items: { select: { kind: true, planId: true } } },
      }),
      prisma.order.findMany({ where: paidWhere, select: { leadId: true, amountCents: true } }),
      prisma.$queryRaw<Array<{ leadId: string; accessExpiresAt: Date | null; revokedAt: Date | null }>>(Prisma.sql`
        SELECT DISTINCT ON (o."leadId") o."leadId" AS "leadId", oi."accessExpiresAt" AS "accessExpiresAt", oi."revokedAt" AS "revokedAt"
        FROM "OrderItem" oi
        JOIN "Order" o ON o.id = oi."orderId"
        JOIN "Plan" p ON p.id = oi."planId"
        WHERE o.status = 'PAID' AND p."durationDays" IS NOT NULL ${botCond(Prisma.sql`o."botId"`)}
        ORDER BY o."leadId", oi."accessExpiresAt" DESC NULLS LAST
      `),
      prisma.$queryRaw<Array<{ avg_days: number | null }>>(Prisma.sql`
        WITH gaps AS (
          SELECT "leadId", EXTRACT(EPOCH FROM ("paidAt" - LAG("paidAt") OVER (PARTITION BY "leadId" ORDER BY "paidAt"))) / 86400 AS days
          FROM "Order"
          WHERE status = 'PAID' ${botCond(Prisma.sql`"botId"`)}
        )
        SELECT AVG(days) AS avg_days FROM gaps WHERE days IS NOT NULL
      `),
      prisma.order.groupBy({
        by: ["originId"],
        where: paidWhere,
        _sum: { amountCents: true },
        _count: { _all: true },
        orderBy: { _sum: { amountCents: "desc" } },
        take: 10,
      }),
      prisma.dashboardNote.findMany({ where: { ownerId }, orderBy: { createdAt: "desc" }, take: 50 }),
    ]);

    // ---- Grupo 1: Vendas por tempo ----
    const salesByHour = Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      count: Number(salesByHourRaw.find((r) => r.hour === h)?.count ?? 0),
    }));
    const bestHour = salesByHour.reduce((best, cur) => (cur.count > best.count ? cur : best), salesByHour[0]);
    const salesByWeekday = Array.from({ length: 7 }, (_, d) => ({
      label: WEEKDAY_LABELS[d],
      count: Number(salesByWeekdayRaw.find((r) => r.dow === d)?.count ?? 0),
    }));
    const top7Days = top7DaysRaw.map((r) => ({ day: r.day, revenueCents: Number(r.revenue) }));

    // ---- Grupo 2: Rankings de produto ----
    const botById = new Map(bots.map((b) => [b.id, b]));
    const topBots = topBotsGroups.map((g) => ({
      label: botById.get(g.botId)?.label ?? g.botId,
      revenueCents: g._sum.amountCents ?? 0,
      count: g._count._all,
    }));
    const topFlows = topFlowsRaw.map((r) => ({ label: r.flowName, revenueCents: Number(r.revenue), count: Number(r.count) }));
    const topPlans = topPlansRaw.map((r) => ({
      label: r.planName,
      isPack: r.productType === "PACK",
      revenueCents: Number(r.revenue),
      count: Number(r.count),
    }));
    const leadLabel = (lead: { username: string | null; firstName: string | null; id: string }) =>
      lead.username ? `@${lead.username}` : lead.firstName || lead.id;
    const topTicketsView = topTickets.map((o) => ({
      leadLabel: leadLabel(o.lead),
      planNames: o.items.map((i) => i.plan.name).join(" + "),
      amountCents: o.amountCents,
      paidAt: o.paidAt,
    }));

    // ---- Grupo 3: Funil + taxas ----
    const createdCounts = { PENDING: 0, PAID: 0, REFUSED: 0, EXPIRED: 0 } as Record<string, number>;
    for (const row of createdStatusCounts) createdCounts[row.status] = row._count._all;
    const totalGenerated = Object.values(createdCounts).reduce((a, b) => a + b, 0);
    const funnel = {
      starts: startsCount,
      pixGenerated: totalGenerated,
      paid: createdCounts.PAID,
      startToPix: startsCount > 0 ? (totalGenerated / startsCount) * 100 : 0,
      pixToPaid: totalGenerated > 0 ? (createdCounts.PAID / totalGenerated) * 100 : 0,
      startToPaid: startsCount > 0 ? (createdCounts.PAID / startsCount) * 100 : 0,
    };

    const upsellByLead = new Map<string, Date>();
    for (const s of upsellSends) {
      if (!s.sentAt) continue;
      const cur = upsellByLead.get(s.leadId);
      if (!cur || s.sentAt < cur) upsellByLead.set(s.leadId, s.sentAt);
    }
    const upsellLeadIds = [...upsellByLead.keys()];
    const upsellCandidateOrders = upsellLeadIds.length
      ? await prisma.order.findMany({ where: { leadId: { in: upsellLeadIds }, status: "PAID" }, select: { leadId: true, paidAt: true } })
      : [];
    const upsellConvertedLeads = new Set(
      upsellCandidateOrders.filter((o) => o.paidAt && o.paidAt > upsellByLead.get(o.leadId)!).map((o) => o.leadId)
    );
    const upsellRate = {
      rate: upsellLeadIds.length ? (upsellConvertedLeads.size / upsellLeadIds.length) * 100 : 0,
      converted: upsellConvertedLeads.size,
      total: upsellLeadIds.length,
    };

    const downsellGeneralLeadIds = [...new Set(downsellGeneralSends.map((s) => s.leadId))];
    const downsellPaidLeads = downsellGeneralLeadIds.length
      ? await prisma.order.findMany({
          where: { leadId: { in: downsellGeneralLeadIds }, status: "PAID", items: { some: { kind: "DOWNSELL" } } },
          select: { leadId: true },
          distinct: ["leadId"],
        })
      : [];
    const downsellRate = {
      rate: downsellGeneralLeadIds.length ? (downsellPaidLeads.length / downsellGeneralLeadIds.length) * 100 : 0,
      converted: downsellPaidLeads.length,
      total: downsellGeneralLeadIds.length,
    };

    const recoveryOrderIds = [...new Set(recoverySends.map((s) => s.orderId).filter((id): id is string => id != null))];
    const recoveredCount = recoveryOrderIds.length
      ? await prisma.order.count({ where: { id: { in: recoveryOrderIds }, status: "PAID" } })
      : 0;
    const recoveryRate = {
      rate: recoverySends.length ? (recoveredCount / recoverySends.length) * 100 : 0,
      converted: recoveredCount,
      total: recoverySends.length,
    };

    let bumpEligible = 0;
    let bumpTaken = 0;
    if (paidOrdersWithItems.length) {
      const basePlanIds = [...new Set(paidOrdersWithItems.flatMap((o) => o.items.filter((i) => i.kind === "BASE").map((i) => i.planId)))];
      const plansWithBump = basePlanIds.length
        ? await prisma.offer.findMany({
            where: { kind: "ORDER_BUMP", active: true, triggerPlanId: { in: basePlanIds } },
            select: { triggerPlanId: true },
            distinct: ["triggerPlanId"],
          })
        : [];
      const eligiblePlanIds = new Set(plansWithBump.map((o) => o.triggerPlanId));
      for (const o of paidOrdersWithItems) {
        const baseItem = o.items.find((i) => i.kind === "BASE");
        if (baseItem && eligiblePlanIds.has(baseItem.planId)) {
          bumpEligible++;
          if (o.items.some((i) => i.kind === "ORDER_BUMP")) bumpTaken++;
        }
      }
    }
    const orderBumpRate = { rate: bumpEligible ? (bumpTaken / bumpEligible) * 100 : 0, converted: bumpTaken, total: bumpEligible };

    // ---- Grupo 4: Assinatura ----
    const buyerIds = new Set(paidOrdersForLtv.map((o) => o.leadId));
    const totalRevenue = paidOrdersForLtv.reduce((sum, o) => sum + o.amountCents, 0);
    const ltvAvgCents = buyerIds.size ? Math.round(totalRevenue / buyerIds.size) : 0;
    const salesPerUser = buyerIds.size ? paidOrdersForLtv.length / buyerIds.size : 0;

    const buyerIdsArr = [...buyerIds];
    const allTimeOrderCounts = buyerIdsArr.length
      ? await prisma.order.groupBy({ by: ["leadId"], where: { leadId: { in: buyerIdsArr }, status: "PAID" }, _count: { _all: true } })
      : [];
    const recurringCount = allTimeOrderCounts.filter((g) => g._count._all >= 2).length;
    const recurrenceRate = buyerIdsArr.length ? (recurringCount / buyerIdsArr.length) * 100 : 0;
    const upgradeRate = buyerIds.size ? (upsellConvertedLeads.size / buyerIds.size) * 100 : 0;

    const now = new Date();
    const totalSubBuyers = latestSubItems.length;
    const activeVips = latestSubItems.filter((r) => r.accessExpiresAt && r.accessExpiresAt > now && !r.revokedAt).length;
    const retentionRate = totalSubBuyers ? (activeVips / totalSubBuyers) * 100 : 0;
    const churnedCount = totalSubBuyers - activeVips;
    const churnRate = totalSubBuyers ? (churnedCount / totalSubBuyers) * 100 : 0;

    const avgReturnDays = returnTimeRows[0]?.avg_days ?? null;

    const userCounters = {
      totalBuyers: buyerIds.size,
      recurring: recurringCount,
      activeVips,
      upsellers: upsellConvertedLeads.size,
      downsellers: downsellPaidLeads.length,
    };

    // ---- Fontes de tráfego (reaproveita Código de Venda) ----
    const originIds = originGroups10.map((g) => g.originId).filter((id): id is string => id != null);
    const origins = await prisma.origin.findMany({ where: { id: { in: originIds }, ownerId } });
    const originById = new Map(origins.map((o) => [o.id, o]));
    const trafficSources = originGroups10.map((g) => ({
      label: g.originId ? originById.get(g.originId)?.label ?? g.originId : "Direto (sem código)",
      param: g.originId ? originById.get(g.originId)?.param ?? "?" : "start",
      revenueCents: g._sum.amountCents ?? 0,
      count: g._count._all,
    }));

    res.render("stats", {
      bots,
      selectedBotId: botId ?? "",
      selectedPeriod: period,
      salesByHour,
      bestHour,
      salesByWeekday,
      top7Days,
      topBots,
      topFlows,
      topPlans,
      topTickets: topTicketsView,
      funnel,
      upsellRate,
      downsellRate,
      orderBumpRate,
      recoveryRate,
      ltvAvgCents,
      salesPerUser,
      recurrenceRate,
      upgradeRate,
      retentionRate,
      churnRate,
      avgReturnDays,
      userCounters,
      trafficSources,
      notes,
    });
  });

  router.post("/notes", async (req, res) => {
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (text) await prisma.dashboardNote.create({ data: { ownerId: req.session.userId!, text } });
    res.redirect(withSuccess("/admin/stats", "Nota adicionada!"));
  });

  router.post("/notes/:id/delete", async (req, res) => {
    await prisma.dashboardNote.deleteMany({ where: { id: req.params.id, ownerId: req.session.userId! } });
    res.redirect(withSuccess("/admin/stats", "Nota removida."));
  });

  return router;
}
