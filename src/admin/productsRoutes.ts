import { Router, type Request, type Response } from "express";
import { prisma } from "../db/client.js";

function parsePriceToCents(input: string): number | null {
  const normalized = input.trim().replace(/\./g, "").replace(",", ".");
  const value = Number(normalized);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 100);
}

export function createProductsRouter(): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    const products = await prisma.product.findMany({ orderBy: { createdAt: "desc" } });
    res.render("products/list", { products });
  });

  router.get("/new", async (_req, res) => {
    res.render("products/form", { product: null, error: null });
  });

  router.post("/", async (req, res) => {
    await handleUpsert(req, res, null);
  });

  router.get("/:id/edit", async (req, res) => {
    const product = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!product) return res.status(404).send("Produto não encontrado.");
    res.render("products/form", { product, error: null });
  });

  router.post("/:id", async (req, res) => {
    await handleUpsert(req, res, req.params.id);
  });

  router.post("/:id/delete", async (req, res) => {
    await prisma.product.delete({ where: { id: req.params.id } });
    res.redirect("/admin/products");
  });

  async function handleUpsert(req: Request, res: Response, id: string | null) {
    const name = String(req.body.name ?? "").trim();
    const description = String(req.body.description ?? "").trim() || null;
    const priceCents = parsePriceToCents(String(req.body.price ?? ""));
    const deliveryType = String(req.body.deliveryType ?? "LINK");
    const fileTelegramId = String(req.body.fileTelegramId ?? "").trim() || null;
    const externalLink = String(req.body.externalLink ?? "").trim() || null;
    const protectContent = req.body.protectContent === "on";
    const active = req.body.active === "on";

    if (!name || priceCents === null) {
      return res.status(400).render("products/form", {
        product: { id, name, description, priceCents: 0, deliveryType, fileTelegramId, externalLink, protectContent, active },
        error: "Nome e preço (maior que zero) são obrigatórios.",
      });
    }

    const data = {
      name,
      description,
      priceCents,
      deliveryType: deliveryType as never,
      fileTelegramId: deliveryType === "FILE" ? fileTelegramId : null,
      externalLink: deliveryType === "LINK" ? externalLink : null,
      protectContent,
      active,
    };

    if (id) {
      await prisma.product.update({ where: { id }, data });
      res.redirect("/admin/products");
    } else {
      const product = await prisma.product.create({ data });
      res.redirect(`/admin/products?created=${product.id}`);
    }
  }

  return router;
}
