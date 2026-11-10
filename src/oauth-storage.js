import { DurableObject } from "cloudflare:workers";
import { encryptJson, decryptJson, readStoredCredentials } from "./credential-crypto.js";

export { encryptJson, decryptJson };

// Per-grant credential store used by grants made before 2026-11-09. New sign-ins keep their
// credentials only in the grant's encrypted props, which the OAuth provider deletes with the
// grant. An old grant's copy here is deleted the next time that grant gets a token (see
// upgradeGrantProps); until then it stays readable as a fallback.
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
    return readStoredCredentials(this.ctx.storage, this.env.DATA_ENCRYPTION_KEY);
  }

  async clear() {
    await this.ctx.storage.deleteAll();
    return { ok: true };
  }
}
