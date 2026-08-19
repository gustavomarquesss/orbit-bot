import express, { Router, type Request, type Response, type NextFunction } from "express";
import session from "express-session";
import createPgSessionStore from "connect-pg-simple";
import pg from "pg";
import { timingSafeEqual } from "node:crypto";
import { prisma } from "../db/client.js";
import { config } from "../config.js";
import { createFlowsRouter } from "./flowsRoutes.js";
import { createProductsRouter } from "./productsRoutes.js";

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

  router.use("/flows", createFlowsRouter());
  router.use("/products", createProductsRouter());

  router.get("/", async (_req, res) => {
    const [statusCounts, revenueAgg, leadCount, buyerCount, recentOrders, dailyOrdersRaw] =
      await Promise.all([
        prisma.order.groupBy({ by: ["status"], _count: { _all: true } }),
        prisma.order.aggregate({
          where: { status: "PAID" },
          _sum: { amountCents: true },
        }),
        prisma.lead.count(),
        prisma.order.findMany({
          where: { status: "PAID" },
          distinct: ["leadId"],
          select: { leadId: true },
        }),
        prisma.order.findMany({
          take: 20,
          orderBy: { createdAt: "desc" },
          include: { lead: true, product: true, origin: true },
        }),
        prisma.$queryRaw<Array<{ day: Date; count: bigint }>>`
          SELECT date_trunc('day', "createdAt") AS day, COUNT(*) AS count
          FROM "Order"
          WHERE "createdAt" >= NOW() - INTERVAL '14 days'
          GROUP BY day
          ORDER BY day ASC
        `,
      ]);

    const counts = { PENDING: 0, PAID: 0, REFUSED: 0, EXPIRED: 0 } as Record<string, number>;
    for (const row of statusCounts) counts[row.status] = row._count._all;

    const totalOrders = Object.values(counts).reduce((a, b) => a + b, 0);
    const conversionRate = leadCount > 0 ? (buyerCount.length / leadCount) * 100 : 0;

    res.render("dashboard", {
      counts,
      totalOrders,
      revenueCents: revenueAgg._sum.amountCents ?? 0,
      leadCount,
      buyerCount: buyerCount.length,
      conversionRate,
      recentOrders,
      dailyOrders: dailyOrdersRaw.map((r) => ({ day: r.day, count: Number(r.count) })),
    });
  });

  return router;
}
