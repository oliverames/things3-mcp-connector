// Encryption of stored Things credentials. Pure WebCrypto, so it runs in Workers and in Node tests.
//
// The AES-256-GCM key is derived from the DATA_ENCRYPTION_KEY secret with HKDF-SHA-256. Records
// written before that used the first 32 characters of the secret as the key (zero-padded when
// shorter); they still decrypt, and callers re-encrypt them the first time they are read.

const enc = new TextEncoder();
const HKDF_SALT = enc.encode("things3-mcp-connector");
const HKDF_INFO = enc.encode("stored-credentials:aes-256-gcm:v2");

async function derivedKey(secret) {
  if (typeof secret !== "string" || !secret) throw new Error("DATA_ENCRYPTION_KEY is not set.");
  const material = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: HKDF_SALT, info: HKDF_INFO }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

// The derivation used before HKDF. Only ever used to read old records.
async function legacyKey(secret) {
  return crypto.subtle.importKey("raw", enc.encode(secret.padEnd(32, "0").slice(0, 32)), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function seal(data, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(data)));
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...combined));
}

async function open(encoded, key) {
  const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, key, bytes.slice(12));
  return JSON.parse(new TextDecoder().decode(decrypted));
}

export async function encryptJson(data, secretKey) {
  return seal(data, await derivedKey(secretKey));
}

// Encrypts the way records were written before HKDF. Exists so tests can make an old record.
export async function encryptJsonLegacy(data, secretKey) {
  return seal(data, await legacyKey(secretKey));
}

// { data, legacy }: legacy is true when the record only opened with the old key and should be
// re-encrypted. AES-GCM authenticates, so a record never opens with the wrong key. A record
// that opens with neither key fails with one fixed message that carries nothing from the record.
export async function decryptJsonDetailed(encoded, secretKey) {
  try {
    return { data: await open(encoded, await derivedKey(secretKey)), legacy: false };
  } catch {
    try {
      return { data: await open(encoded, await legacyKey(secretKey)), legacy: true };
    } catch {
      throw new Error("Stored credentials could not be decrypted with the current key. Please re-authenticate.");
    }
  }
}

export async function decryptJson(encoded, secretKey) {
  return (await decryptJsonDetailed(encoded, secretKey)).data;
}

// Reads the credential record of a per-grant store (`storage` is Durable Object storage) and
// rewrites it under the current key when it was still encrypted the old way.
export async function readStoredCredentials(storage, secretKey) {
  const encrypted = await storage.get("credentials");
  if (!encrypted) return null;
  const { data, legacy } = await decryptJsonDetailed(encrypted, secretKey);
  if (legacy) await storage.put("credentials", await encryptJson(data, secretKey));
  return data;
}

// Runs when a token is issued or refreshed (the provider's tokenExchangeCallback). The grant's
// props are the one place credentials live: the provider deletes them with the grant when it is
// revoked or replaced by a new sign-in. This brings an older grant in line:
//   - props encrypted with the old key are re-encrypted with the derived key;
//   - the second copy older grants kept in a per-grant Durable Object is deleted, and the pointer
//     to it (grantId) is dropped, once the props are known to hold readable credentials.
// Returns the new props, or null when nothing needs to change. `clearStore(grantId)` deletes the
// Durable Object copy.
export async function upgradeGrantProps(props, secretKey, clearStore) {
  if (!props?.encryptedCredentials || !secretKey) return null;
  const { data, legacy } = await decryptJsonDetailed(props.encryptedCredentials, secretKey);
  if (!data?.email || !data?.password) return null;
  if (!legacy && !props.grantId) return null;
  const next = { ...props };
  if (legacy) next.encryptedCredentials = await encryptJson(data, secretKey);
  if (props.grantId) {
    await clearStore(props.grantId);
    delete next.grantId;
  }
  return next;
}
