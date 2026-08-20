import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  // Bots são cadastrados pelo painel (/admin/bots), não mais via env var
  // fixa — só a identidade do operador (vale pra todos os bots) fica aqui.
  TELEGRAM_ADMIN_USER_ID: z.coerce.number().int(),
  // Chave usada pra criptografar o token de cada Bot no banco (AES-256-GCM,
  // ver src/lib/crypto.ts). Qualquer string longa serve — normalizada com
  // SHA-256 internamente.
  BOT_TOKEN_ENCRYPTION_KEY: z.string().min(16),

  // client_id/client_secret/webhook secret viraram por usuário (Fase 3
  // Milestone 3, ver Settings no schema + src/payments/syncpayCredentials.ts)
  // — só o endpoint da API continua global (é o mesmo pra todo mundo).
  SYNCPAY_API_BASE_URL: z.string().url().default("https://api.syncpayments.com.br"),

  DATABASE_URL: z.string().min(1),

  // Login do painel virou multi-usuário (Fase 3) — contas ficam no banco
  // (model User), cadastradas via `npm run user:create`, sem senha única
  // fixa aqui.
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
