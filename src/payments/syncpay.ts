import { config } from "../config.js";

const REQUEST_TIMEOUT_MS = 15_000;

// Prazo padrão de expiração da cobrança PIX. A API da SyncPay não devolve um
// timestamp de expiração no corpo da resposta de criação (ver doc pesquisada
// em syncpay.apidog.io/cashin-20187696e0), só recebe `pix.expiresInDays` como
// input — então calculamos `expiresAt` localmente a partir desse mesmo valor.
const PIX_EXPIRATION_DAYS = 1;

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
  customer: {
    name: string;
    email: string;
    cpf?: string;
    phone?: string;
  };
  externalRef?: string;
}

export interface CreateChargeResult {
  externalId: string;
  pixCopyPaste: string;
  qrCodeUrl: string;
  expiresAt: Date;
}

function buildPostbackUrl(): string {
  const url = new URL("/webhooks/syncpay", config.PUBLIC_BASE_URL);
  // A doc oficial (web.syncpay.pro/documentacao/) não estava acessível a partir
  // deste ambiente e a doc espelhada (syncpay.apidog.io) não expõe nenhum
  // mecanismo de assinatura (HMAC/etc) para o postback. Até confirmar isso com
  // credenciais reais, usamos SYNCPAY_WEBHOOK_SECRET como shared-secret embutido
  // na própria postbackUrl — validado em src/payments/webhook.ts. Ver relatório
  // da task para o checklist de validação manual.
  url.searchParams.set("secret", config.SYNCPAY_WEBHOOK_SECRET);
  return url.toString();
}

interface RawChargeResponse {
  idTransaction?: string;
  id?: string;
  transaction_id?: string;
  paymentCode?: string;
  pix_code?: string;
  paymentCodeBase64?: string;
  qr_code_base64?: string;
  status_transaction?: string;
  status?: string;
  message?: string;
}

function extractErrorMessage(payload: unknown): string | undefined {
  if (typeof payload === "object" && payload !== null) {
    const obj = payload as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.error === "string") return obj.error;
  }
  return undefined;
}

// Nomes de campo com mais de uma variante: a doc real da SyncPay não estava
// totalmente acessível na pesquisa (ver relatório). Parsing defensivo aceita
// as variantes encontradas nas fontes consultadas (syncpay.apidog.io) e no
// SDK não-oficial (github.com/b7k3/syncpay) sem quebrar se um campo mudar de nome.
function parseChargeResponse(payload: unknown): CreateChargeResult {
  if (typeof payload !== "object" || payload === null) {
    throw new SyncPayError(
      "Resposta da SyncPay não é um objeto JSON válido.",
      "gateway",
      payload
    );
  }

  const raw = payload as RawChargeResponse;
  const externalId = raw.idTransaction ?? raw.id ?? raw.transaction_id;
  const pixCopyPaste = raw.paymentCode ?? raw.pix_code;
  const qrCodeBase64 = raw.paymentCodeBase64 ?? raw.qr_code_base64;

  if (!externalId || !pixCopyPaste) {
    throw new SyncPayError(
      `Resposta da SyncPay não contém os campos esperados (idTransaction/paymentCode). Corpo: ${JSON.stringify(
        payload
      )}`,
      "gateway",
      payload
    );
  }

  return {
    externalId,
    pixCopyPaste,
    // A API devolve o QR code como imagem em base64, não uma URL hospedada.
    // Convertido pra data URI pra manter o campo utilizável como "qrCodeUrl"
    // (ex: <img src>) sem precisar hospedar a imagem nós mesmos.
    qrCodeUrl: qrCodeBase64 ? `data:image/png;base64,${qrCodeBase64}` : "",
    expiresAt: new Date(Date.now() + PIX_EXPIRATION_DAYS * 24 * 60 * 60 * 1000),
  };
}

/**
 * Cria uma cobrança PIX na SyncPay.
 *
 * Endpoint e formato de payload baseados na doc espelhada em
 * syncpay.apidog.io/cashin-20187696e0 (a doc oficial não estava acessível
 * neste ambiente — DNS de web.syncpay.pro falhou). CONFIRMAR contra a API
 * real com credenciais de produção antes de ir pra produção.
 */
export async function createCharge(
  params: CreateChargeParams
): Promise<CreateChargeResult> {
  const endpoint = new URL("/v1/gateway/api", config.SYNCPAY_API_BASE_URL).toString();

  const body = {
    amount: params.amountCents,
    // A SyncPay exige IP do cliente no payload; não existe um IP real de
    // origem em compras feitas dentro do Telegram, então usamos um placeholder.
    // CONFIRMAR se a gateway aceita isso sem rejeitar a cobrança.
    ip: "0.0.0.0",
    items: [
      {
        title: params.description,
        quantity: 1,
        tangible: false,
        unitPrice: params.amountCents,
      },
    ],
    pix: {
      expiresInDays: String(PIX_EXPIRATION_DAYS),
    },
    customer: {
      name: params.customer.name,
      email: params.customer.email,
      cpf: params.customer.cpf,
      phone: params.customer.phone,
      externaRef: params.externalRef,
    },
    postbackUrl: buildPostbackUrl(),
    traceable: true,
  };

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // SYNCPAY_API_KEY tratada como Bearer token estático. A doc espelhada
        // mostra um fluxo de troca client_id+client_secret -> access_token
        // (POST /api/partner/v1/auth-token, expira em 1h) que nosso config.ts
        // atual (só SYNCPAY_API_KEY) não suporta. CONFIRMAR com credenciais
        // reais qual dos dois modelos a conta do usuário usa — ver relatório.
        Authorization: `Bearer ${config.SYNCPAY_API_KEY}`,
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
    // 4xx restante: dado que enviamos está errado, repetir não resolve.
    const kind: SyncPayErrorKind =
      response.status >= 500 || response.status === 429 ? "gateway" : "validation";
    throw new SyncPayError(
      `SyncPay recusou a criação da cobrança: ${message}`,
      kind,
      payload
    );
  }

  return parseChargeResponse(payload);
}

export type NormalizedChargeStatus = "PAID" | "REFUSED" | "EXPIRED" | "PENDING" | "UNKNOWN";

const PAID_TOKENS = ["PAID", "APPROVED", "COMPLETED", "CONFIRMED", "SUCCESS"];
const REFUSED_TOKENS = ["REFUSED", "DECLINED", "REJECTED", "FAILED", "CANCEL", "CHARGEBACK"];
const EXPIRED_TOKENS = ["EXPIRED"];

/**
 * Normaliza o status de transação vindo do webhook da SyncPay pro nosso
 * OrderStatus. A doc consultada não deixou claro o conjunto exato de valores
 * de `status_transaction` (só documentou "WAITING_FOR_APPROVAL" na criação);
 * por isso o matching é por substring (case-insensitive) em vez de valor
 * exato — mais tolerante a variações não documentadas, mas precisa ser
 * validado contra webhooks reais (ver relatório).
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
