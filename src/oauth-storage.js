import { DurableObject } from "cloudflare:workers";

async function getEncryptionKey(rawKey) {
  const enc = new TextEncoder();
  const keyBytes = enc.encode(rawKey.padEnd(32, "0").slice(0, 32));
  return await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptJson(data, secretKey) {
  const key = await getEncryptionKey(secretKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(data));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintext
  );
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...combined));
}

export async function decryptJson(encoded, secretKey) {
  const key = await getEncryptionKey(secretKey);
  const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  const iv = bytes.slice(0, 12);
  const ciphertext = bytes.slice(12);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext
  );
  return JSON.parse(new TextDecoder().decode(decrypted));
}

// Durable Object to store credentials per grant/session
export class OAuthCredentials extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
  }

  async setCredentials(credentials) {
    const encrypted = await encryptJson(credentials, this.env.DATA_ENCRYPTION_KEY);
    await this.ctx.storage.put("credentials", encrypted);
    return { ok: true };
  }

  async getCredentials() {
    const encrypted = await this.ctx.storage.get("credentials");
    if (!encrypted) return null;
    return await decryptJson(encrypted, this.env.DATA_ENCRYPTION_KEY);
  }

  async clear() {
    await this.ctx.storage.deleteAll();
    return { ok: true };
  }
}
