import type { Env } from "./env";

/**
 * Firebase ID-token verification for Cloudflare Workers.
 *
 * The Firebase Admin SDK needs Node APIs that Workers do not have, so this does
 * exactly what the Admin SDK's verifyIdToken() does, with Web Crypto: RS256
 * signature against Google's public securetoken keys, plus the documented claim
 * checks (iss, aud, exp, iat, auth_time, sub). No service-account credential is
 * needed or stored anywhere; only the public project id.
 * https://firebase.google.com/docs/auth/admin/verify-id-tokens
 */
const JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const CLOCK_SKEW_S = 60;

export interface FirebaseClaims {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
}

type Jwk = JsonWebKey & { kid?: string };
type KeyFetcher = () => Promise<{ keys: Jwk[]; maxAgeS: number }>;

const dec = new TextDecoder();
const b64uBytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const b64uJson = (s: string) => JSON.parse(dec.decode(b64uBytes(s)));

async function fetchGoogleKeys() {
  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new Error(`jwks_${res.status}`);
  const body = (await res.json()) as { keys: Jwk[] };
  const m = /max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "");
  return { keys: body.keys, maxAgeS: m ? Number(m[1]) : 3600 };
}

let fetcher: KeyFetcher = fetchGoogleKeys;
let cache: { keys: Map<string, CryptoKey>; expires: number; fetchedAt: number } | null = null;

/** Tests inject their own key source; production always uses Google's. */
export function setKeyFetcherForTests(f: KeyFetcher | null): void {
  fetcher = f ?? fetchGoogleKeys;
  cache = null;
}

async function keyFor(kid: string): Promise<CryptoKey | null> {
  const now = Date.now();
  const fresh = cache && now < cache.expires;
  if (fresh && cache!.keys.has(kid)) return cache!.keys.get(kid)!;
  // Unknown kid: Google may have rotated. Refetch, but at most once a minute so a
  // flood of forged kids cannot turn into a flood of upstream requests.
  if (cache && fresh && now - cache.fetchedAt < 60_000) return null;
  const { keys, maxAgeS } = await fetcher();
  const map = new Map<string, CryptoKey>();
  for (const k of keys) {
    if (!k.kid) continue;
    map.set(k.kid, await crypto.subtle.importKey("jwk", k, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
  }
  cache = { keys: map, expires: now + maxAgeS * 1000, fetchedAt: now };
  return map.get(kid) ?? null;
}

/** True when the token header says RS256, i.e. it is a Firebase token and not one of our HS256 tokens. */
export function looksLikeFirebaseToken(token: string): boolean {
  try {
    return b64uJson(token.split(".")[0]).alg === "RS256";
  } catch {
    return false;
  }
}

/** Verified claims, or null for anything invalid, expired, for another project, or when Firebase auth is not configured. */
export async function verifyFirebaseToken(env: Env, token: string): Promise<FirebaseClaims | null> {
  const projectId = env.FIREBASE_PROJECT_ID;
  if (!projectId) return null;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const header = b64uJson(parts[0]);
    if (header.alg !== "RS256" || typeof header.kid !== "string") return null;
    const key = await keyFor(header.kid);
    if (!key) return null;
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64uBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!ok) return null;

    const p = b64uJson(parts[1]);
    const now = Math.floor(Date.now() / 1000);
    if (p.aud !== projectId || p.iss !== `https://securetoken.google.com/${projectId}`) return null;
    if (typeof p.exp !== "number" || p.exp <= now - CLOCK_SKEW_S) return null;
    if (typeof p.iat !== "number" || p.iat > now + CLOCK_SKEW_S) return null;
    if (typeof p.auth_time !== "number" || p.auth_time > now + CLOCK_SKEW_S) return null;
    if (typeof p.sub !== "string" || !p.sub || p.sub.length > 128) return null;

    return {
      uid: p.sub,
      email: typeof p.email === "string" ? p.email.toLowerCase() : null,
      emailVerified: p.email_verified === true,
      name: typeof p.name === "string" && p.name.trim() ? p.name.trim().slice(0, 200) : null,
      picture: typeof p.picture === "string" && /^https:\/\//.test(p.picture) ? p.picture.slice(0, 2048) : null,
    };
  } catch {
    return null;
  }
}
