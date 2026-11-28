/**
 * ALTCHA-compatible proof of work, solved in the browser with Web Crypto. No third-party service, no cookies, no tracking.
 * The server (workers/api/src/captcha.ts) issues a signed challenge; we find the number n with SHA-256(salt + n) == challenge
 * and send back base64(JSON). The wire format is the ALTCHA protocol (https://altcha.org), so the official widget also works.
 */
export interface AltchaChallenge { algorithm: 'SHA-256'; challenge: string; maxnumber: number; salt: string; signature: string }

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('')

export async function solveChallenge(ch: AltchaChallenge): Promise<string> {
  const enc = new TextEncoder()
  for (let n = 0; n <= ch.maxnumber; n++) {
    if (hex(await crypto.subtle.digest('SHA-256', enc.encode(`${ch.salt}${n}`))) === ch.challenge) {
      return btoa(JSON.stringify({ algorithm: ch.algorithm, challenge: ch.challenge, number: n, salt: ch.salt, signature: ch.signature }))
    }
    if (n % 2000 === 1999) await new Promise((r) => setTimeout(r, 0)) // keep the page responsive
  }
  throw new Error('captcha_unsolved')
}
