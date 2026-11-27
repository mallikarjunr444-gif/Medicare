// RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30 s) on Web Crypto. Compatible with Google Authenticator, Authy, 1Password.
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Uint8Array {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, "").toUpperCase()) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error("bad base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

export const newTotpSecret = () => base32Encode(crypto.getRandomValues(new Uint8Array(20)));

export async function hotp(secretB32: string, counter: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", base32Decode(secretB32), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setUint32(0, Math.floor(counter / 2 ** 32));
  new DataView(msg.buffer).setUint32(4, counter >>> 0);
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const o = h[19] & 15;
  const code = (((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1_000_000;
  return String(code).padStart(6, "0");
}

export const totpStep = (nowMs = Date.now()) => Math.floor(nowMs / 30_000);

/** Returns the matching time step (within ±1 step of clock drift) or null. */
export async function verifyTotp(secretB32: string, code: string, nowMs = Date.now()): Promise<number | null> {
  if (!/^\d{6}$/.test(code)) return null;
  const now = totpStep(nowMs);
  let hit: number | null = null;
  for (const step of [now - 1, now, now + 1]) {
    if ((await hotp(secretB32, step)) === code) hit = step; // no early exit: constant work
  }
  return hit;
}

export const otpauthUri = (secretB32: string, account: string, issuer = "MediCare") =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

/** 10 recovery codes, 50 bits each, formatted XXXXX-XXXXX. */
export function newRecoveryCodes(n = 10): string[] {
  return Array.from({ length: n }, () => {
    const s = base32Encode(crypto.getRandomValues(new Uint8Array(7))).slice(0, 10);
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}
export const normalizeRecovery = (c: string) => c.replace(/[\s-]/g, "").toUpperCase();
