import { getApps, initializeApp, type FirebaseApp } from 'firebase/app'
import { browserLocalPersistence, browserSessionPersistence, getAuth, GoogleAuthProvider, setPersistence, type Auth } from 'firebase/auth'

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
}

export const isFirebaseConfigured = Boolean(config.apiKey && config.authDomain && config.projectId && config.appId)

let cached: { app: FirebaseApp; auth: Auth } | null = null

/** Browser only. Returns null when the build has no Firebase config (sign-in then reports "not configured"). */
export function getFirebase(): { app: FirebaseApp; auth: Auth } | null {
  if (typeof window === 'undefined' || !isFirebaseConfigured) return null
  if (!cached) {
    const app = getApps()[0] ?? initializeApp(config)
    const auth = getAuth(app)
    // Stay signed in across reloads and browser restarts. Falls back to per-tab storage if IndexedDB/localStorage is blocked.
    setPersistence(auth, browserLocalPersistence).catch(() => setPersistence(auth, browserSessionPersistence).catch(() => undefined))
    cached = { app, auth }
  }
  return cached
}

export function googleProvider(): GoogleAuthProvider {
  const p = new GoogleAuthProvider()
  p.addScope('email')
  p.addScope('profile')
  p.setCustomParameters({ prompt: 'select_account' })
  return p
}
