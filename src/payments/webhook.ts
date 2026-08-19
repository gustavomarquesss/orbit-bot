import crypto from "node:crypto";
import express, { type Request, type Response } from "express";
import type { Prisma } from "@prisma/client";
import { config } from "../config.js";
import { prisma } from "../db/client.js";
import { normalizeChargeStatus } from "./syncpay.js";
import { applyNormalizedStatus, findOrderByChargeId } from "./orderStatus.js";

const PROVIDER = "syncpay";

/**
 * A doc da SyncPay acessível na pesquisa não documenta nenhum mecanismo de
 * assinatura de webhook (HMAC, header custom, etc — ver relatório da task).
 * Como fallback, exigimos um shared-secret (SYNCPAY_WEBHOOK_SECRET) embutido
 * na própria webhook_url que registramos na cobrança (src/payments/syncpay.ts,
 * buildWebhookUrl) e comparamos aqui via timingSafeEqual. Isso PRECISA ser
 * confirmado/substituído por um mecanismo oficial assim que a doc real (ou
 * suporte da SyncPay) confirmar como eles assinam o postback.
 */
export function isValidWebhookSecret(receivedSecret: unknown): boolean {
  if (typeof receivedSecret !== "string" || receivedSecret.length === 0) {
    return false;
  }
  const expected = Buffer.from(config.SYNCPAY_WEBHOOK_SECRET);
  const received = Buffer.from(receivedSecret);
  if (expected.length !== received.length) {
    return false;
  }
  return crypto.timingSafeEqual(expected, received);
}

const EXTERNAL_ID_KEYS = ["idtransaction", "idTransaction", "id", "transaction_id", "identifier"] as const;
const STATUS_KEYS = ["status_transaction", "status", "transactionStatus"] as const;

export function extractExternalId(payload: Record<string, unknown>): string | undefined {
  for (const key of EXTERNAL_ID_KEYS) {
    const value = payload[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export function extractStatus(payload: Record<string, unknown>): string | undefined {
  for (const key of STATUS_KEYS) {
    const value = payload[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function toRecord(body: unknown): Record<string, unknown> {
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
}

/**
 * O payload real de um webhook de pagamento da SyncPay vem aninhado em
 * `{ data: { idtransaction, status, ... } }` — confirmado num pagamento
 * real em 2026-08-19 (o formato plano assumido antes nunca tinha sido visto
 * de verdade, só suposto). `extractExternalId`/`extractStatus` continuam
 * operando sobre um Record achatado; esta função resolve qual Record usar
 * (o `data` aninhado, se existir, senão o payload como veio).
 */
function unwrapFields(payload: Record<string, unknown>): Record<string, unknown> {
  const data = payload.data;
  return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : payload;
}

/**
 * Handler exportado separadamente do router só pra ser testável sem precisar
 * subir um servidor Express de verdade nos testes (vitest chama esta função
 * diretamente com req/res mockados).
 */
export async function handleSyncpayWebhook(req: Request, res: Response): Promise<void> {
  if (!isValidWebhookSecret(req.query.secret)) {
    console.warn("[syncpay-webhook] secret ausente ou inválido — requisição rejeitada.");
    res.status(401).json({ ok: false, error: "invalid secret" });
    return;
  }

  const payload = toRecord(req.body);
  const fields = unwrapFields(payload);
  const externalId = extractExternalId(fields);

  if (!externalId) {
    console.error(
      "[syncpay-webhook] payload sem id de transação reconhecível:",
      JSON.stringify(payload)
    );
    // 200 pra SyncPay não ficar reenviando um payload que nunca vamos conseguir
    // processar (não temos como recuperar o id da transação retentando).
    res.status(200).json({ ok: true, warning: "id de transação não encontrado" });
    return;
  }

  try {
    const existing = await prisma.webhookEvent.findUnique({
      where: { provider_externalId: { provider: PROVIDER, externalId } },
    });

    if (existing?.processedAt) {
      res.status(200).json({ ok: true, duplicate: true });
      return;
    }

    const webhookEvent = existing
      ? await prisma.webhookEvent.update({
          where: { id: existing.id },
          data: { payload: payload as Prisma.InputJsonValue },
        })
      : await prisma.webhookEvent.create({
          data: { provider: PROVIDER, externalId, payload: payload as Prisma.InputJsonValue },
        });

    const order = await findOrderByChargeId(externalId);

    if (!order) {
      console.error(
        `[syncpay-webhook] nenhum Order encontrado para syncpayChargeId=${externalId}.`
      );
      await prisma.webhookEvent.update({
        where: { id: webhookEvent.id },
        data: { processedAt: new Date() },
      });
      res.status(200).json({ ok: true, warning: "order não encontrado" });
      return;
    }

    const normalizedStatus = normalizeChargeStatus(extractStatus(fields));

    // Só entrega/notifica na transição PENDING -> PAID, nunca em reprocessamento
    // (garantido pelo early-return de `existing?.processedAt` acima) nem se o
    // Order já estava PAID por um evento anterior (ex: pego antes pelo
    // polling de reconciliação — ver src/payments/reconciliation.ts).
    await applyNormalizedStatus(order, normalizedStatus, { webhookEventId: webhookEvent.id });

    await prisma.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: { processedAt: new Date() },
    });

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[syncpay-webhook] erro ao processar webhook:", err);
    // 200 mesmo em erro interno evita retentativas agressivas da gateway; o
    // WebhookEvent fica registrado com processedAt=null para investigação
    // manual (ou reprocessamento futuro, se implementarmos isso).
    res.status(200).json({ ok: false });
  }
}

export const syncpayWebhookRouter = express.Router();

// Depende de `app.use(express.json())` já estar montado globalmente antes
// deste router (ver src/server.ts) — não duplicamos aqui pra evitar
// reprocessar o stream do request.
syncpayWebhookRouter.post("/", handleSyncpayWebhook);
