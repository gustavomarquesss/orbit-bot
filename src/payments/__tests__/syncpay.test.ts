import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createCharge, normalizeChargeStatus, _resetTokenCacheForTests } from "../syncpay.js";

const originalFetch = global.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const authTokenResponse = () =>
  jsonResponse({ access_token: "test-access-token", expires_in: 3600 });

// createCharge agora busca um Bearer token (POST /api/partner/v1/auth-token)
// antes de criar a cobrança — o mock precisa distinguir as duas chamadas por
// URL em vez de responder a mesma coisa pra tudo.
function mockFetchForCharge(chargeResponse: () => Response): typeof fetch {
  return vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("auth-token")) return authTokenResponse();
    return chargeResponse();
  }) as unknown as typeof fetch;
}

const baseParams = {
  amountCents: 1990,
  description: "Produto Teste",
};

describe("normalizeChargeStatus", () => {
  it.each([
    ["PAID_OUT", "PAID"],
    ["approved", "PAID"],
    ["COMPLETED", "PAID"],
    ["REFUSED", "REFUSED"],
    ["CANCELED", "REFUSED"],
    ["EXPIRED", "EXPIRED"],
    ["WAITING_FOR_APPROVAL", "PENDING"],
    ["algo-nunca-documentado", "UNKNOWN"],
    [undefined, "UNKNOWN"],
  ] as const)("normaliza %s para %s", (input, expected) => {
    expect(normalizeChargeStatus(input)).toBe(expected);
  });
});

describe("createCharge", () => {
  beforeEach(() => {
    _resetTokenCacheForTests();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("faz parse de uma resposta bem-sucedida (identifier/pix_code) e gera o QR a partir do código", async () => {
    global.fetch = mockFetchForCharge(() =>
      jsonResponse({
        message: "Cashin request successfully submitted",
        identifier: "f7f3ac07-a772-4bf3-8932-6e604786ddc2",
        pix_code: "00020126850014br.gov.bcb.pix...",
      })
    );

    const result = await createCharge(baseParams);

    expect(result.externalId).toBe("f7f3ac07-a772-4bf3-8932-6e604786ddc2");
    expect(result.pixCopyPaste).toBe("00020126850014br.gov.bcb.pix...");
    // A API não devolve imagem — geramos o QR nós mesmos a partir do pix_code.
    expect(result.qrCodeUrl).toMatch(/^data:image\/png;base64,/);
    expect(result.expiresAt).toBeNull();
  });

  it("lança SyncPayError kind=validation em erro 4xx", async () => {
    global.fetch = mockFetchForCharge(() => jsonResponse({ message: "cpf inválido" }, 400));

    await expect(createCharge(baseParams)).rejects.toMatchObject({ kind: "validation" });
  });

  it("lança SyncPayError kind=gateway em erro 5xx", async () => {
    global.fetch = mockFetchForCharge(() => jsonResponse({ message: "erro interno" }, 502));

    await expect(createCharge(baseParams)).rejects.toMatchObject({ kind: "gateway" });
  });

  it("lança SyncPayError kind=gateway em erro 429 (rate limit)", async () => {
    global.fetch = mockFetchForCharge(() => jsonResponse({ message: "too many requests" }, 429));

    await expect(createCharge(baseParams)).rejects.toMatchObject({ kind: "gateway" });
  });

  it("lança SyncPayError kind=network em falha de rede", async () => {
    global.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("auth-token")) return authTokenResponse();
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    await expect(createCharge(baseParams)).rejects.toMatchObject({ kind: "network" });
  });

  it("lança SyncPayError kind=gateway quando resposta 200 não tem os campos esperados", async () => {
    global.fetch = mockFetchForCharge(() => jsonResponse({ status: "success" }));

    await expect(createCharge(baseParams)).rejects.toMatchObject({ kind: "gateway" });
  });

  it("lança SyncPayError kind=gateway quando o corpo da resposta não é JSON", async () => {
    global.fetch = mockFetchForCharge(
      () =>
        new Response("<html>não é json</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        })
    );

    await expect(createCharge(baseParams)).rejects.toMatchObject({ kind: "gateway" });
  });

  it("lança SyncPayError se a autenticação (auth-token) falhar", async () => {
    global.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("auth-token")) return jsonResponse({ message: "credenciais inválidas" }, 401);
      throw new Error("não deveria chamar a cobrança sem token");
    }) as unknown as typeof fetch;

    await expect(createCharge(baseParams)).rejects.toMatchObject({ kind: "validation" });
  });
});
