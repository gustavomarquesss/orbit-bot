import express from "express";
import { config } from "./config.js";

const app = express();
app.use(express.json());

// Usado pelo ping de keep-alive (cron-job.org/UptimeRobot) para reduzir
// cold-starts no Render free tier — ver ARCHITECTURE.md.
app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

// Routers do bot (webhook Telegraf), pagamentos (webhook SyncPay) e painel
// admin são montados aqui pelas respectivas features:
//   app.use(await createBotWebhookRouter())
//   app.use("/webhooks/syncpay", syncpayWebhookRouter)
//   app.use("/admin", adminRouter)

app.listen(config.PORT, () => {
  console.log(`[server] ouvindo na porta ${config.PORT} (${config.NODE_ENV})`);
});
