import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

// scrypt nativo do Node — sem dependência nova (bcrypt/argon2), mesmo
// espírito de src/lib/crypto.ts. Formato gravado: "salt.hash", ambos hex.
export async function hashPassword(plainText: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derivedKey = (await scryptAsync(plainText, salt, KEY_LENGTH)) as Buffer;
  return `${salt.toString("hex")}.${derivedKey.toString("hex")}`;
}

export async function verifyPassword(plainText: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(".");
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const derivedKey = (await scryptAsync(plainText, salt, KEY_LENGTH)) as Buffer;
  if (derivedKey.length !== expected.length) return false;
  return timingSafeEqual(derivedKey, expected);
}
