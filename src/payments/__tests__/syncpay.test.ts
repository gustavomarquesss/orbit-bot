import { describe, it, expect, vi, afterEach } from "vitest";
import { createCharge, normalizeChargeStatus } from "../syncpay.js";

const originalFetch = global.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const baseParams = {
  amountCents: 1990,
  description: "Produto Teste",
  customer: { name: "Fulano", email: "fulano@example.com" },
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
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("faz parse de uma resposta bem-sucedida (idTransaction/paymentCode/paymentCodeBase64)", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        status: "success",
        idTransaction: "tx-abc",
        paymentCode: "00020126...",
        paymentCodeBase64: "aGVsbG8=",
        status_transaction: "WAITING_FOR_APPROVAL",
      })
    ) as unknown as typeof fetch;

    const result = await createCharge(baseParams);

    expect(result.externalId).toBe("tx-abc");
    expect(result.pixCopyPaste).toBe("00020126...");
    expect(result.qrCodeUrl).toBe("data:image/png;base64,aGVsbG8=");
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("aceita nomes de campo alternativos (id/pix_code/qr_code_base64)", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse({ id: "tx-xyz", pix_code: "codigo-alt", qr_code_base64: "d29ybGQ=" })
    ) as unknown as typeof fetch;

    const result = await createCharge(baseParams);

    expect(result.externalId).toBe("tx-xyz");
    expect(result.pixCopyPaste).toBe("codigo-alt");
  });

  it("lança SyncPayError kind=validation em erro 4xx", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse({ message: "cpf inválido" }, 400)
    ) as unknown as typeof fetch;

    await expect(createCharge(baseParams)).rejects.toMatchObject({ kind: "validation" });
  });

  it("lança SyncPayError kind=gateway em erro 5xx", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse({ message: "erro interno" }, 502)
    ) as unknown as typeof fetch;

    await expect(createCharge(baseParams)).rejects.toMatchObject({ kind: "gateway" });
  });

  it("lança SyncPayError kind=gateway em erro 429 (rate limit)", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse({ message: "too many requests" }, 429)
    ) as unknown as typeof fetch;

    await expect(createCharge(baseParams)).rejects.toMatchObject({ kind: "gateway" });
  });

  it("lança SyncPayError kind=network em falha de rede", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch;

    await expect(createCharge(baseParams)).rejects.toMatchObject({ kind: "network" });
  });

  it("lança SyncPayError kind=gateway quando resposta 200 não tem os campos esperados", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse({ status: "success" })
    ) as unknown as typeof fetch;

    await expect(createCharge(baseParams)).rejects.toMatchObject({ kind: "gateway" });
  });

  it("lança SyncPayError kind=gateway quando o corpo da resposta não é JSON", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response("<html>não é json</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })
    ) as unknown as typeof fetch;

    await expect(createCharge(baseParams)).rejects.toMatchObject({ kind: "gateway" });
  });
});
