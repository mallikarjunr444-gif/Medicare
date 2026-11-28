const enc = new TextEncoder();
const dec = new TextDecoder();

export const b64u = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const b64uDecode = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export async function sha256Hex(input: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(input)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 256-bit URL-safe random token. */
export function randomToken(bytes = 32): string {
  return b64u(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function timingSafeEqual(a: string, b: string): boolean {
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

async function aesKey(secret: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode("medicare-mfa-v1"), info: enc.encode("totp-secret") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** AES-256-GCM; format `v1.<iv>.<ciphertext>`. Key is derived from `secret` with HKDF. */
export async function encryptSecret(secret: string, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(secret), enc.encode(plaintext)));
  return `v1.${b64u(iv)}.${b64u(ct)}`;
}

export async function decryptSecret(secret: string, blob: string): Promise<string | null> {
  try {
    const [v, iv, ct] = blob.split(".");
    if (v !== "v1") return null;
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64uDecode(iv) }, await aesKey(secret), b64uDecode(ct));
    return dec.decode(pt);
  } catch {
    return null;
  }
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Uniform random integer in [0, max) without modulo bias. */
export function randomInt(max: number): number {
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf);
  while (buf[0] >= limit);
  return buf[0] % max;
}
