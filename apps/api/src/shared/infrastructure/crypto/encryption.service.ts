import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

/**
 * Encrypts PiKVM device credentials (and their TOTP secrets, when a device has 2FA enabled)
 * before they ever reach the database. This is the only place plaintext PiKVM credentials
 * exist outside of memory during an active connection -- they are never sent to the browser,
 * never logged, and never appear in an API response (see Equipment presentation DTOs, which
 * omit these fields entirely rather than redacting them).
 */
@Injectable()
export class EncryptionService {
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    const secret = config.getOrThrow<string>("CREDENTIALS_ENCRYPTION_KEY");
    if (Buffer.from(secret, "base64").length !== 32) {
      throw new Error("CREDENTIALS_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
    }
    this.key = Buffer.from(secret, "base64");
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    // iv.ciphertext.authTag, all base64 -- self-contained so decrypt needs nothing but this key.
    return [iv, ciphertext, authTag].map((b) => b.toString("base64")).join(".");
  }

  decrypt(payload: string): string {
    const [ivB64, ciphertextB64, authTagB64] = payload.split(".");
    if (!ivB64 || !ciphertextB64 || !authTagB64) {
      throw new Error("Malformed encrypted payload");
    }
    const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(authTagB64, "base64"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextB64, "base64")), decipher.final()]);
    return plaintext.toString("utf8");
  }
}
