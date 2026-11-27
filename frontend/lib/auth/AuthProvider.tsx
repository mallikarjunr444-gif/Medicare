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
  /** Email + password sign-in. Resolves { mfaRequired: true } when the account needs an authenticator/recovery code. */
  signInWithPassword: (email: string, password: string, otp?: string) => Promise<{ mfaRequired: boolean }>
  signUpWithPassword: (data: { email: string; username: string; password: string; full_name?: string }) => Promise<void>
  /** True for email/password sessions (as opposed to Google). */
  isPasswordAccount: boolean
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

const SIGNUP_FIELD_MESSAGES: Record<string, string> = {
  email: 'Enter a valid email address.',
  username: 'Username must be 3-39 characters, start and end with a letter or number, and may use _ or - between characters.',
  password: 'Password must be 8-128 characters.',
  full_name: 'Full name must be 200 characters or fewer.',
}

function signupValidationMessage(detail: unknown): string {
  if (!Array.isArray(detail)) return 'Please check your email, username, and password.'
  const fields = detail.flatMap((item) => {
    if (!item || typeof item !== 'object' || !('loc' in item)) return []
    const loc = (item as { loc?: unknown }).loc
    return Array.isArray(loc) && loc[0] === 'body' && typeof loc[1] === 'string' ? [loc[1]] : []
  })
  const messages = [...new Set(fields)].map((field) => SIGNUP_FIELD_MESSAGES[field]).filter(Boolean)
  return messages.length ? messages.join(' ') : 'Please check your email, username, and password.'
}

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
  const emailSession = useRef(false)
  const [isPasswordAccount, setIsPasswordAccount] = useState(false)

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

  const finishEmailSession = useCallback(async () => {
    const me = await api.getProfile()
    if (me.is_guest) throw new Error('guest')
    const p = await api.getMyProfile()
    emailSession.current = true
    setIsPasswordAccount(true)
    setProfile(p)
    setError(null)
    setStatus('signed-in')
  }, [])

  // Restore an email/password session (httpOnly cookie or stored bearer) after a reload.
  const restoredEmail = useRef(false)
  useEffect(() => {
    if (restoredEmail.current) return
    restoredEmail.current = true
    if (!api.getToken()) return
    finishEmailSession().catch(() => {
      /* not an email account (guest/expired): leave state to the Firebase listener */
    })
  }, [finishEmailSession])

  useEffect(() => {
    const fb = getFirebase()
    if (!fb) {
      if (!emailSession.current) setStatus((st) => (st === 'signed-in' ? st : 'signed-out'))
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
        if (emailSession.current) return // an email/password session is active; Firebase has nothing to say
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
      await api.logout() // revokes the server token and clears the cookie
      if (emailSession.current) {
        emailSession.current = false
        setIsPasswordAccount(false)
        setProfile(null)
        setStatus('signed-out')
        resetLocalState()
      }
    } catch {
      toast.error('Could not sign out. Please try again.')
      return
    }
    toast.success('Signed out')
  }, [resetLocalState])

  const signInWithPassword = useCallback(async (email: string, password: string, otp?: string) => {
    setBusy(true)
    setError(null)
    try {
      const res = await api.login(email.trim(), password, otp)
      useStore.getState().setAuth(res.access_token, { id: '', email, username: '', is_guest: false })
      await finishEmailSession()
      return { mfaRequired: false }
    } catch (e) {
      const r = (e as { response?: { status?: number; data?: { detail?: unknown } } }).response
      if (r?.status === 403 && r.data?.detail === 'mfa_required') return { mfaRequired: true }
      const detail = typeof r?.data?.detail === 'string' ? r.data.detail : ''
      if (r?.status === 401) setError(otp ? 'That code was not accepted. Try again or use a recovery code.' : 'Incorrect email or password.')
      else if (r?.status === 429) setError(detail || 'Too many attempts. Please wait a few minutes and try again.')
      else setError(detail || 'We could not sign you in. Please try again.')
      throw e
    } finally {
      setBusy(false)
    }
  }, [finishEmailSession])

  const signUpWithPassword = useCallback(async (data: { email: string; username: string; password: string; full_name?: string }) => {
    setBusy(true)
    setError(null)
    try {
      await api.register(data)
    } catch (e) {
      const r = (e as { response?: { status?: number; data?: { detail?: unknown } } }).response
      const d = r?.data?.detail
      if (r?.status === 409 && typeof d === 'string') setError(d)
      else if (r?.status === 422) setError(signupValidationMessage(d))
      else setError('We could not create your account. Please try again.')
      setBusy(false)
      throw e
    }
    setBusy(false)
    await signInWithPassword(data.email, data.password)
  }, [signInWithPassword])

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
    () => ({ status, profile, error, busy, signInWithGoogle, signInWithPassword, signUpWithPassword, isPasswordAccount, signOut, retry, updateProfile, clearError }),
    [status, profile, error, busy, signInWithGoogle, signInWithPassword, signUpWithPassword, isPasswordAccount, signOut, retry, updateProfile, clearError],
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
