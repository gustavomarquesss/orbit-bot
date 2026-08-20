import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { config } from "./config.js";
import { webhookRouter, loadAllBotsFromDb } from "./bot/botManager.js";
import { syncpayWebhookRouter } from "./payments/webhook.js";
import { startReconciliationPolling } from "./payments/reconciliation.js";
import { startUpsellScheduler } from "./bot/upsellScheduler.js";
import { startDownsellScheduler } from "./bot/downsellScheduler.js";
import { startSubscriptionScheduler } from "./payments/subscriptionScheduler.js";
import { createAdminRouter } from "./admin/routes.js";

// Varredura de pedidos PENDING pra cobrir o caso do postback da SyncPay não
// chegar (ver src/payments/reconciliation.ts). 20s é conservador o bastante
// pra não pesar na API deles com poucos pedidos pendentes de cada vez.
const RECONCILIATION_INTERVAL_MS = 20_000;
// Varredura de mensagens de Upsell agendadas (src/bot/upsellScheduler.ts).
// 30s é preciso o bastante pra um atraso configurado em minutos.
const UPSELL_SCHEDULER_INTERVAL_MS = 30_000;
// Varredura de sequências de Downsell agendadas (src/bot/downsellScheduler.ts).
const DOWNSELL_SCHEDULER_INTERVAL_MS = 30_000;
// Lembrete de renovação + revogação de assinatura vencida
// (src/payments/subscriptionScheduler.ts). Prazo é em dias, não precisa de
// granularidade fina — 1h é conservador o bastante.
const SUBSCRIPTION_SCHEDULER_INTERVAL_MS = 60 * 60_000;

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
  // já faz seu próprio parsing do corpo da requisição internamente. O
  // router é montado uma vez aqui, mas bots cadastrados depois pelo painel
  // adicionam suas próprias rotas nele em runtime (ver botManager.ts).
  app.use(webhookRouter);
  await loadAllBotsFromDb();

  app.use(express.json());
  app.use("/webhooks/syncpay", syncpayWebhookRouter);
  app.use("/admin", createAdminRouter());

  startReconciliationPolling(RECONCILIATION_INTERVAL_MS);
  startUpsellScheduler(UPSELL_SCHEDULER_INTERVAL_MS);
  startDownsellScheduler(DOWNSELL_SCHEDULER_INTERVAL_MS);
  startSubscriptionScheduler(SUBSCRIPTION_SCHEDULER_INTERVAL_MS);

  app.listen(config.PORT, () => {
    console.log(`[server] ouvindo na porta ${config.PORT} (${config.NODE_ENV})`);
  });
}

main().catch((err) => {
  console.error("[server] falha ao iniciar", err);
  process.exit(1);
});
