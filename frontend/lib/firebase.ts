import type { FirebaseApp } from 'firebase/app'
import type { Auth, GoogleAuthProvider } from 'firebase/auth'

export type AuthSdk = typeof import('firebase/auth')

/**
 * Firebase web config. These values identify the project and are PUBLIC by design (they ship in every
 * Firebase web app); access is controlled by the authorized-domains list and by the backend, which
 * verifies every ID token. Never put a service-account key or database URL here.
 */
const config = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID,
}

export const isFirebaseConfigured = Boolean(config.apiKey && config.authDomain && config.projectId && config.appId)

let loading: Promise<{ app: FirebaseApp; auth: Auth; sdk: AuthSdk } | null> | null = null

/**
 * Browser only. The Firebase SDK (about 110 KB) is fetched on demand instead of with the first page load, which keeps the
 * landing page fast. Returns null when the build has no Firebase config (sign-in then reports "not configured").
 */
export function loadFirebase(): Promise<{ app: FirebaseApp; auth: Auth; sdk: AuthSdk } | null> {
  if (typeof window === 'undefined' || !isFirebaseConfigured) return Promise.resolve(null)
  if (!loading) {
    loading = (async () => {
      const [{ getApps, initializeApp }, sdk] = await Promise.all([import('firebase/app'), import('firebase/auth')])
      const app = getApps()[0] ?? initializeApp(config)
      const auth = sdk.getAuth(app)
      // Stay signed in across reloads and browser restarts. Falls back to per-tab storage if IndexedDB/localStorage is blocked.
      sdk.setPersistence(auth, sdk.browserLocalPersistence).catch(() => sdk.setPersistence(auth, sdk.browserSessionPersistence).catch(() => undefined))
      return { app, auth, sdk }
    })().catch((e) => { loading = null; throw e })
  }
  return loading
}

export function googleProvider(sdk: AuthSdk): GoogleAuthProvider {
  const p = new sdk.GoogleAuthProvider()
  p.addScope('email')
  p.addScope('profile')
  p.setCustomParameters({ prompt: 'select_account' })
  return p
}
