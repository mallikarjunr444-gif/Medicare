'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { getRedirectResult, onIdTokenChanged, signInWithPopup, signInWithRedirect, signOut as firebaseSignOut, type User } from 'firebase/auth'
import { toast } from 'react-hot-toast'
import { api, setFirebaseAuth } from '@/lib/api'
import { getFirebase, googleProvider, isFirebaseConfigured } from '@/lib/firebase'
import type { ProfileUpdate, UserProfile } from '@/lib/types'
import { useStore } from '@/store/useStore'

export type AuthStatus = 'loading' | 'signed-out' | 'signed-in' | 'error'

interface AuthContextValue {
  status: AuthStatus
  profile: UserProfile | null
  /** Last sign-in / profile-sync problem, in plain words. */
  error: string | null
  /** A sign-in popup or redirect is in progress. */
  busy: boolean
  signInWithGoogle: () => Promise<void>
  signOut: () => Promise<void>
  /** Retry the profile sync after a failure (e.g. the API was briefly unreachable). */
  retry: () => Promise<void>
  updateProfile: (data: ProfileUpdate) => Promise<UserProfile>
  clearError: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

const FRIENDLY: Record<string, string> = {
  'auth/unauthorized-domain':
    'This website address is not yet allowed for Google sign-in. Add it under Firebase Console → Authentication → Settings → Authorized domains.',
  'auth/network-request-failed': 'Network problem. Check your connection and try again.',
  'auth/too-many-requests': 'Too many attempts. Please wait a moment and try again.',
  'auth/user-disabled': 'This account has been disabled. Contact support if you think this is a mistake.',
  'auth/account-exists-with-different-credential': 'An account already exists with this email using a different sign-in method.',
  'auth/operation-not-allowed': 'Google sign-in is not enabled for this project yet (Firebase Console → Authentication → Sign-in method).',
  'auth/internal-error': 'Google sign-in hit an unexpected problem. Please try again.',
}
// The user closing the popup is a choice, not an error.
const SILENT = new Set(['auth/popup-closed-by-user', 'auth/cancelled-popup-request', 'auth/user-cancelled'])
// Popups are unavailable (blocked, in-app browsers, some mobile webviews): use the full-page redirect instead.
const USE_REDIRECT = new Set(['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment'])

const codeOf = (e: unknown): string => (typeof e === 'object' && e && 'code' in e ? String((e as { code: unknown }).code) : '')

function describe(e: unknown): string {
  const code = codeOf(e)
  if (FRIENDLY[code]) return FRIENDLY[code]
  const res = (e as { response?: { status?: number; data?: { detail?: unknown } } })?.response
  if (res?.status === 503) return 'Sign-in is not configured on the server yet.'
  if (res?.status === 403 && typeof res.data?.detail === 'string') return res.data.detail
  if (res?.status === 401) return 'Your session could not be verified. Please sign in again.'
  if (res) return 'We could not load your profile. Please try again.'
  if ((e as { code?: string })?.code === 'ERR_NETWORK') return 'We could not reach MediCare. Check your connection and try again.'
  return 'Something went wrong while signing in. Please try again.'
}

export function AuthProvider({ children }: Readonly<{ children: React.ReactNode }>) {
  const queryClient = useQueryClient()
  const [status, setStatus] = useState<AuthStatus>('loading')
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const userRef = useRef<User | null>(null)
  const syncedUid = useRef<string | null>(null)
  const inflight = useRef<Promise<void> | null>(null)

  const resetLocalState = useCallback(() => {
    // Nothing from one person's session may be visible to the next: drop cached API data and the guest identity.
    queryClient.clear()
    useStore.getState().clearAuth()
  }, [queryClient])

  const sync = useCallback(async (user: User) => {
    if (inflight.current) return inflight.current
    const run = (async () => {
      try {
        const token = await user.getIdToken()
        const { profile: p, created } = await api.syncFirebaseProfile(token)
        syncedUid.current = user.uid
        setProfile(p)
        setError(null)
        setStatus('signed-in')
        if (created) toast.success(`Welcome to MediCare, ${(p.full_name ?? '').split(' ')[0] || 'there'}!`)
      } catch (e) {
        setError(describe(e))
        setStatus('error')
      } finally {
        inflight.current = null
      }
    })()
    inflight.current = run
    return run
  }, [])

  useEffect(() => {
    const fb = getFirebase()
    if (!fb) {
      setStatus('signed-out')
      return
    }
    // Finishes a redirect sign-in (and reports its errors) when the page loads after Google sends the user back.
    getRedirectResult(fb.auth).catch((e) => {
      const code = codeOf(e)
      if (!SILENT.has(code)) setError(describe(e))
    })
    return onIdTokenChanged(fb.auth, async (user) => {
      userRef.current = user
      if (!user) {
        const hadUser = syncedUid.current !== null
        syncedUid.current = null
        setFirebaseAuth(null, null)
        setProfile(null)
        setStatus('signed-out')
        if (hadUser) resetLocalState()
        return
      }
      const token = await user.getIdToken()
      setFirebaseAuth(token, () => user.getIdToken())
      if (syncedUid.current !== user.uid) {
        if (syncedUid.current !== null) resetLocalState() // account switched in another tab
        await sync(user)
      }
    })
  }, [sync, resetLocalState])

  const signInWithGoogle = useCallback(async () => {
    const fb = getFirebase()
    if (!fb) {
      const msg = isFirebaseConfigured ? 'Sign-in is only available in the browser.' : 'Google sign-in is not configured for this build yet.'
      setError(msg)
      toast.error(msg)
      return
    }
    setBusy(true)
    setError(null)
    try {
      await signInWithPopup(fb.auth, googleProvider())
    } catch (e) {
      const code = codeOf(e)
      if (USE_REDIRECT.has(code)) {
        try {
          await signInWithRedirect(fb.auth, googleProvider()) // leaves the page; result is handled on return
          return
        } catch (re) {
          setError(describe(re))
        }
      } else if (!SILENT.has(code)) {
        setError(describe(e)) // shown inline by the dialog / guard
      }
    } finally {
      setBusy(false)
    }
  }, [])

  const signOut = useCallback(async () => {
    const fb = getFirebase()
    try {
      if (fb) await firebaseSignOut(fb.auth)
      await api.logout() // clears any server cookie from the older email/password flow
    } catch {
      toast.error('Could not sign out. Please try again.')
      return
    }
    toast.success('Signed out')
  }, [])

  // Stable identity: consumers call this from effects, and a new function per error change would re-run them and wipe the message.
  const clearError = useCallback(() => setError(null), [])

  const retry = useCallback(async () => {
    const user = userRef.current
    if (user) {
      setStatus('loading')
      await sync(user)
    }
  }, [sync])

  const updateProfile = useCallback(async (data: ProfileUpdate) => {
    const updated = await api.updateMyProfile(data)
    setProfile(updated)
    return updated
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({ status, profile, error, busy, signInWithGoogle, signOut, retry, updateProfile, clearError }),
    [status, profile, error, busy, signInWithGoogle, signOut, retry, updateProfile, clearError],
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
