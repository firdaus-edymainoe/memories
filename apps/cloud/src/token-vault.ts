import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * Seals small secrets (drive refresh tokens, hand-off codes) with AES-256-GCM, so the database
 * and URLs only ever hold ciphertext. The key comes from the server secret; each purpose gets its
 * own key, so a sealed value made for one purpose can't be opened as another.
 */
export class TokenVault {
  private readonly key: Buffer;

  constructor(secret: string, purpose: string) {
    if (secret.length < 32) throw new Error("The vault secret must be at least 32 characters");
    this.key = Buffer.from(hkdfSync("sha256", secret, "memories-token-vault", purpose, 32));
  }

  seal(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
  }

  /** The sealed value, or null if it was not sealed by this vault or was changed. */
  open<T>(sealed: string): T | null {
    try {
      const data = Buffer.from(sealed, "base64url");
      if (data.length < 29) return null;
      const decipher = createDecipheriv("aes-256-gcm", this.key, data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(12, 28));
      const plain = Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8");
      return JSON.parse(plain) as T;
    } catch {
      return null;
    }
  }
}
