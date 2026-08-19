import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { config } from "../config.js";

// AES-256-GCM com o Node nativo — sem dependência nova. A chave em
// BOT_TOKEN_ENCRYPTION_KEY pode ser qualquer string; normalizamos pra 32
// bytes com SHA-256 pra não exigir que o usuário gere um hex de 64 chars.
const key = createHash("sha256").update(config.BOT_TOKEN_ENCRYPTION_KEY).digest();
const IV_LENGTH = 12;

/** Formato: base64(iv) + "." + base64(authTag) + "." + base64(ciphertext) */
export function encryptSecret(plainText: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${authTag.toString("base64")}.${ciphertext.toString("base64")}`;
}

export function decryptSecret(encrypted: string): string {
  const [ivB64, authTagB64, ciphertextB64] = encrypted.split(".");
  if (!ivB64 || !authTagB64 || !ciphertextB64) {
    throw new Error("decryptSecret: formato inválido (esperado iv.authTag.ciphertext)");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(authTagB64, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
