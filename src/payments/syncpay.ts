import QRCode from "qrcode";
import { config } from "../config.js";

const REQUEST_TIMEOUT_MS = 15_000;

export type SyncPayErrorKind = "network" | "gateway" | "validation";

/**
 * Erro do cliente SyncPay. `kind` indica ao chamador (orders.ts) se vale a
 * pena tentar de novo ("network"/"gateway" = problema transitório do lado da
 * gateway) ou não ("validation" = dado inválido, repetir não resolve).
 */
export class SyncPayError extends Error {
  readonly kind: SyncPayErrorKind;
  readonly cause?: unknown;

  constructor(message: string, kind: SyncPayErrorKind, cause?: unknown) {
    super(message);
    this.name = "SyncPayError";
    this.kind = kind;
    this.cause = cause;
  }
}

export interface CreateChargeParams {
  amountCents: number;
  description: string;
}

export interface CreateChargeResult {
  externalId: string;
  pixCopyPaste: string;
  qrCodeUrl: string;
  // A API não devolve prazo de expiração na criação (confirmado em teste real
  // — ver PROJECT_STATE.md). Null até termos como saber isso de verdade.
  expiresAt: Date | null;
}

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

let cachedToken: CachedToken | null = null;

/** Só para testes — força a próxima chamada a buscar um token novo. */
export function _resetTokenCacheForTests(): void {
  cachedToken = null;
}

// Margem de segurança pra renovar antes do token expirar de fato (evita usar
// um token que vence no meio de uma requisição em voo).
const TOKEN_REFRESH_MARGIN_MS = 60_000;

interface AuthTokenResponse {
  access_token?: string;
  expires_in?: number;
}

function extractErrorMessage(payload: unknown): string | undefined {
  if (typeof payload === "object" && payload !== null) {
    const obj = payload as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.error === "string") return obj.error;
  }
  return undefined;
}

/**
 * Troca client_id/client_secret por um Bearer token.
 * Endpoint e payload confirmados com uma chamada real em 2026-08-19 (ver
 * PROJECT_STATE.md): POST /api/partner/v1/auth-token, base
 * https://api.syncpayments.com.br (NÃO api.syncpay.pro — esse domínio nem
 * existe, era de uma doc espelhada desatualizada/errada usada antes).
 * Resposta real: { access_token, token_type, expires_in, expires_at }.
 * Cacheado em memória do processo; single-instância (VPS única, sem
 * múltiplos workers), então cache local é suficiente sem precisar de Redis.
 */
async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAtMs - TOKEN_REFRESH_MARGIN_MS > now) {
    return cachedToken.accessToken;
  }

  const endpoint = new URL("/api/partner/v1/auth-token", config.SYNCPAY_API_BASE_URL).toString();

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: config.SYNCPAY_CLIENT_ID,
        client_secret: config.SYNCPAY_CLIENT_SECRET,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new SyncPayError("Falha de rede ao autenticar na SyncPay.", "network", err);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (err) {
    throw new SyncPayError(
      `Resposta de autenticação inválida da SyncPay (HTTP ${response.status}).`,
      "gateway",
      err
    );
  }

  if (!response.ok) {
    throw new SyncPayError(
      `SyncPay recusou a autenticação: ${extractErrorMessage(payload) ?? `HTTP ${response.status}`}`,
      response.status >= 500 ? "gateway" : "validation",
      payload
    );
  }

  const { access_token, expires_in } = payload as AuthTokenResponse;
  if (!access_token) {
    throw new SyncPayError(
      `Resposta de autenticação da SyncPay sem access_token. Corpo: ${JSON.stringify(payload)}`,
      "gateway",
      payload
    );
  }

  cachedToken = {
    accessToken: access_token,
    expiresAtMs: now + (expires_in ?? 3600) * 1000,
  };
  return access_token;
}

function buildPostbackUrl(): string {
  const url = new URL("/webhooks/syncpay", config.PUBLIC_BASE_URL);
  // Mecanismo de assinatura do webhook não documentado publicamente (ver
  // PROJECT_STATE.md). Usamos SYNCPAY_WEBHOOK_SECRET como shared-secret
  // embutido na própria postbackUrl, validado em src/payments/webhook.ts.
  url.searchParams.set("secret", config.SYNCPAY_WEBHOOK_SECRET);
  return url.toString();
}

interface RawChargeResponse {
  identifier?: string;
  pix_code?: string;
  message?: string;
}

/**
 * Gera a imagem do QR code a partir do "pix copia-e-cola" (string EMV/BR
 * Code) nós mesmos — a API não devolve uma imagem pronta (confirmado em
 * teste real, ver PROJECT_STATE.md), só o texto do código.
 */
async function buildQrCodeDataUri(pixCopyPaste: string): Promise<string> {
  return QRCode.toDataURL(pixCopyPaste, { margin: 1, width: 400 });
}

/**
 * Cria uma cobrança PIX na SyncPay.
 *
 * Endpoint, payload e resposta confirmados com chamadas reais em 2026-08-19
 * contra a API de produção (ver PROJECT_STATE.md para o log completo):
 *   POST https://api.syncpayments.com.br/api/partner/v1/cash-in
 *   body: { amount (REAIS, não centavos — ver correção abaixo), description, postbackUrl }
 *   resposta: { message, pix_code, identifier }
 * Nenhum dado do comprador (nome/email/CPF) é exigido — diferente do que a
 * doc espelhada usada antes sugeria. Isso bate com o modelo real do negócio
 * (bot vende para qualquer um, sem cadastro do comprador).
 *
 * BUG CORRIGIDO em 2026-08-19: a suposição inicial de que `amount` era em
 * centavos estava errada — mandar `amountCents` direto gerou uma cobrança
 * 100x maior na SyncPay (plano de R$1,00 virou cobrança de R$100,00, visto
 * em teste real no dashboard deles). O campo é em reais (decimal).
 */
export async function createCharge(
  params: CreateChargeParams
): Promise<CreateChargeResult> {
  const accessToken = await getAccessToken();
  const endpoint = new URL("/api/partner/v1/cash-in", config.SYNCPAY_API_BASE_URL).toString();

  const body = {
    amount: params.amountCents / 100,
    description: params.description,
    postbackUrl: buildPostbackUrl(),
  };

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new SyncPayError(
        "Timeout ao contatar a SyncPay — gateway pode estar fora do ar. Pode tentar novamente.",
        "network",
        err
      );
    }
    throw new SyncPayError(
      "Falha de rede ao contatar a SyncPay. Pode tentar novamente.",
      "network",
      err
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (err) {
    throw new SyncPayError(
      `Resposta inválida da SyncPay (HTTP ${response.status}, corpo não é JSON).`,
      "gateway",
      err
    );
  }

  if (!response.ok) {
    const message = extractErrorMessage(payload) ?? `HTTP ${response.status}`;
    // 5xx/429: problema do lado da gateway, vale tentar de novo depois.
    // 4xx restante: dado que enviamos está errado (ou, ex: limite de valor
    // da conta — "max_cashin_without_fee", visto em teste real), repetir com
    // o mesmo valor não resolve.
    const kind: SyncPayErrorKind =
      response.status >= 500 || response.status === 429 ? "gateway" : "validation";
    throw new SyncPayError(
      `SyncPay recusou a criação da cobrança: ${message}`,
      kind,
      payload
    );
  }

  const raw = payload as RawChargeResponse;
  if (!raw.identifier || !raw.pix_code) {
    throw new SyncPayError(
      `Resposta da SyncPay não contém os campos esperados (identifier/pix_code). Corpo: ${JSON.stringify(payload)}`,
      "gateway",
      payload
    );
  }

  return {
    externalId: raw.identifier,
    pixCopyPaste: raw.pix_code,
    qrCodeUrl: await buildQrCodeDataUri(raw.pix_code),
    expiresAt: null,
  };
}

interface RawTransactionResponse {
  data?: {
    status?: string;
  };
}

/**
 * Consulta o status atual de uma cobrança diretamente na SyncPay. Usado pelo
 * polling de reconciliação (src/payments/reconciliation.ts) — não depende do
 * webhook deles chegar, que na prática nunca chegou no primeiro pagamento
 * real testado (ver PROJECT_STATE.md, 2026-08-19), apesar do endpoint de
 * webhook local funcionar (confirmado via chamada direta).
 * Endpoint e formato de resposta confirmados em teste real:
 *   GET /api/partner/v1/transaction/{identifier}
 *   → { data: { reference_id, currency, amount, status, description, pix_code } }
 */
export async function getTransactionStatus(externalId: string): Promise<string | undefined> {
  const accessToken = await getAccessToken();
  const endpoint = new URL(
    `/api/partner/v1/transaction/${encodeURIComponent(externalId)}`,
    config.SYNCPAY_API_BASE_URL
  ).toString();

  let response: Response;
  try {
    response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new SyncPayError("Falha de rede ao consultar status na SyncPay.", "network", err);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (err) {
    throw new SyncPayError(
      `Resposta de status inválida da SyncPay (HTTP ${response.status}).`,
      "gateway",
      err
    );
  }

  if (!response.ok) {
    throw new SyncPayError(
      `SyncPay recusou a consulta de status: ${extractErrorMessage(payload) ?? `HTTP ${response.status}`}`,
      response.status >= 500 ? "gateway" : "validation",
      payload
    );
  }

  return (payload as RawTransactionResponse).data?.status;
}

export type NormalizedChargeStatus = "PAID" | "REFUSED" | "EXPIRED" | "PENDING" | "UNKNOWN";

const PAID_TOKENS = ["PAID", "APPROVED", "COMPLETED", "CONFIRMED", "SUCCESS"];
const REFUSED_TOKENS = ["REFUSED", "DECLINED", "REJECTED", "FAILED", "CANCEL", "CHARGEBACK"];
const EXPIRED_TOKENS = ["EXPIRED"];

/**
 * Normaliza o status de transação vindo do webhook da SyncPay pro nosso
 * OrderStatus. Confirmado por teste real (GET /api/partner/v1/transaction/:id,
 * ver PROJECT_STATE.md): o status de uma cobrança recém-criada é "pending"
 * (minúsculo). Os valores de PAID/REFUSED/EXPIRED ainda não foram observados
 * — nenhum pagamento real foi completado no teste. Matching por substring
 * (case-insensitive) é uma aproximação tolerante até isso ser confirmado
 * contra um webhook de pagamento de verdade.
 */
export function normalizeChargeStatus(
  rawStatus: string | undefined | null
): NormalizedChargeStatus {
  if (!rawStatus) return "UNKNOWN";
  const upper = rawStatus.toUpperCase();
  if (EXPIRED_TOKENS.some((t) => upper.includes(t))) return "EXPIRED";
  if (REFUSED_TOKENS.some((t) => upper.includes(t))) return "REFUSED";
  if (PAID_TOKENS.some((t) => upper.includes(t))) return "PAID";
  if (upper.includes("WAITING") || upper.includes("PENDING")) return "PENDING";
  return "UNKNOWN";
}
