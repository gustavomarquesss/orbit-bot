import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(1),
  TELEGRAM_ADMIN_USER_ID: z.coerce.number().int(),
  TELEGRAM_VAULT_CHANNEL_ID: z.coerce.number().int(),

  SYNCPAY_CLIENT_ID: z.string().min(1),
  SYNCPAY_CLIENT_SECRET: z.string().min(1),
  SYNCPAY_API_BASE_URL: z.string().url().default("https://api.syncpayments.com.br"),
  SYNCPAY_WEBHOOK_SECRET: z.string().min(1),

  DATABASE_URL: z.string().min(1),

  ADMIN_PANEL_PASSWORD: z.string().min(8),
  SESSION_SECRET: z.string().min(16),

  PORT: z.coerce.number().int().default(3000),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:3000"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

function loadConfig() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(
      `Configuração inválida. Confira o .env contra o .env.example:\n${missing}`
    );
  }
  return parsed.data;
}

export const config = loadConfig();
