import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { config } from "./config.js";
import { createBotWebhookRouter } from "./bot/index.js";
import { syncpayWebhookRouter } from "./payments/webhook.js";
import { createAdminRouter } from "./admin/routes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const app = express();

  app.set("view engine", "ejs");
  app.set("views", join(__dirname, "admin", "views"));

  // Usado pelo Docker healthcheck (docker-compose.yml) — ver ARCHITECTURE.md.
  app.get("/health", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  // Monta o webhook do Telegram ANTES do express.json() global: o Telegraf
  // já faz seu próprio parsing do corpo da requisição internamente.
  app.use(await createBotWebhookRouter());

  app.use(express.json());
  app.use("/webhooks/syncpay", syncpayWebhookRouter);
  app.use("/admin", createAdminRouter());

  app.listen(config.PORT, () => {
    console.log(`[server] ouvindo na porta ${config.PORT} (${config.NODE_ENV})`);
  });
}

main().catch((err) => {
  console.error("[server] falha ao iniciar", err);
  process.exit(1);
});
