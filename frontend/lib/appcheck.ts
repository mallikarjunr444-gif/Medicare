import { initializeAppCheck, getToken, ReCaptchaV3Provider, type AppCheck } from 'firebase/app-check'
import { getFirebase } from '@/lib/firebase'

/**
 * Firebase App Check (free) proves requests come from the genuine MediCare web app. Active only when the build has
 * NEXT_PUBLIC_APPCHECK_SITE_KEY (a reCAPTCHA v3 *site* key, public by design). Without it every call here is a no-op,
 * and the API only enforces App Check when its APPCHECK_ENFORCE is "true" — turn that on after tokens are flowing.
 */
const siteKey = process.env.NEXT_PUBLIC_APPCHECK_SITE_KEY
let instance: AppCheck | null | undefined

function init(): AppCheck | null {
  if (instance !== undefined) return instance
  instance = null
  const fb = getFirebase()
  if (fb && siteKey) {
    try {
      instance = initializeAppCheck(fb.app, { provider: new ReCaptchaV3Provider(siteKey), isTokenAutoRefreshEnabled: true })
    } catch {
      instance = null
    }
  }
  return instance
}

export async function getAppCheckToken(): Promise<string | null> {
  if (typeof window === 'undefined' || !siteKey) return null
  const ac = init()
  if (!ac) return null
  try {
    return (await getToken(ac, false)).token
  } catch {
    return null // never block the app because attestation is unavailable; the server decides
  }
}
