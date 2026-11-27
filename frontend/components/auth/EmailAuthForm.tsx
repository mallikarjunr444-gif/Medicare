'use client'

import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'react-hot-toast'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth/AuthProvider'

type Mode = 'signin' | 'signup' | 'forgot' | 'otp'

const input = 'mt-1.5 block w-full min-h-11 rounded-xl border border-[#d2d2d7] bg-white px-3.5 text-[15px] text-[#1d1d1f] placeholder:text-[#86868b] focus-visible:border-[#0071e3] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#0071e3]/25'
const btn = 'inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-full bg-[#0071e3] px-6 text-sm font-medium text-white transition hover:bg-[#0077ed] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#0071e3]/30 disabled:cursor-not-allowed disabled:bg-[#0071e3]/40'
const link = 'font-medium text-[#0071e3] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0071e3]/40 rounded'

/** Email + password sign-in / sign-up / forgot-password / authenticator-code step. Passwords never touch storage or URLs. */
export function EmailAuthForm() {
  const { signInWithPassword, signUpWithPassword, busy, error, clearError } = useAuth()
  const [mode, setMode] = useState<Mode>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [username, setUsername] = useState('')
  const [fullName, setFullName] = useState('')
  const [otp, setOtp] = useState('')
  const [sentReset, setSentReset] = useState(false)
  const [sending, setSending] = useState(false)
  const go = (m: Mode) => { clearError(); setMode(m); setSentReset(false) }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      if (mode === 'signup') {
        await signUpWithPassword({ email: email.trim(), username: username.trim(), password, full_name: fullName.trim() || undefined })
        toast.success('Account created. Check your email to verify your address.')
      } else if (mode === 'signin') {
        const r = await signInWithPassword(email, password)
        if (r.mfaRequired) setMode('otp')
      } else if (mode === 'otp') {
        await signInWithPassword(email, password, otp.trim())
      } else if (mode === 'forgot') {
        setSending(true)
        await api.forgotPassword(email.trim()).catch(() => undefined) // same message either way
        setSentReset(true)
      }
    } catch {
      /* the provider has put a readable message in `error` */
    } finally {
      setSending(false)
    }
  }

  if (mode === 'forgot' && sentReset) {
    return (
      <div className="mt-4 space-y-3 text-sm text-[#1d1d1f]" role="status">
        <p>If that address has an account, we have sent a link to reset the password. It expires in 1 hour.</p>
        <button type="button" className={link} onClick={() => go('signin')}>Back to sign in</button>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="mt-4 space-y-3" noValidate>
      {mode === 'signup' && (
        <>
          <div>
            <label htmlFor="ea-name" className="text-sm font-medium text-[#1d1d1f]">Full name <span className="font-normal text-[#6e6e73]">(optional)</span></label>
            <input id="ea-name" className={input} autoComplete="name" value={fullName} onChange={(e) => setFullName(e.target.value)} maxLength={100} />
          </div>
          <div>
            <label htmlFor="ea-user" className="text-sm font-medium text-[#1d1d1f]">Username</label>
            <input id="ea-user" className={input} autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} minLength={3} maxLength={39} required />
            <p className="mt-1.5 text-xs text-[#6e6e73]">3-39 characters. Start and end with a letter or number; underscores and hyphens are allowed between.</p>
          </div>
        </>
      )}
      {mode !== 'otp' && (
        <div>
          <label htmlFor="ea-email" className="text-sm font-medium text-[#1d1d1f]">Email</label>
          <input id="ea-email" type="email" className={input} autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
      )}
      {(mode === 'signin' || mode === 'signup') && (
        <div>
          <label htmlFor="ea-pass" className="text-sm font-medium text-[#1d1d1f]">Password</label>
          <input id="ea-pass" type="password" className={input} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} maxLength={128} required />
          {mode === 'signup' && <p className="mt-1.5 text-xs text-[#6e6e73]">8-128 characters.</p>}
        </div>
      )}
      {mode === 'otp' && (
        <div>
          <label htmlFor="ea-otp" className="text-sm font-medium text-[#1d1d1f]">Authenticator or recovery code</label>
          <input id="ea-otp" className={input} inputMode="text" autoComplete="one-time-code" value={otp} onChange={(e) => setOtp(e.target.value)} maxLength={16} required autoFocus />
          <p className="mt-1.5 text-xs text-[#6e6e73]">Enter the 6-digit code from your authenticator app, or one of your recovery codes.</p>
        </div>
      )}
      {error && <p role="alert" className="rounded-xl bg-[#fff2f0] px-3.5 py-2.5 text-[13px] leading-5 text-[#b3261e]">{error}</p>}
      <button type="submit" className={btn} disabled={busy || sending}>
        {(busy || sending) && <Loader2 size={15} className="animate-spin" aria-hidden="true" />}
        {mode === 'signup' ? 'Create account' : mode === 'forgot' ? 'Send reset link' : mode === 'otp' ? 'Verify and sign in' : 'Sign in'}
      </button>
      <div className="flex flex-wrap items-center justify-between gap-2 text-[13px] text-[#6e6e73]">
        {mode === 'signin' && (<><button type="button" className={link} onClick={() => go('forgot')}>Forgot password?</button><button type="button" className={link} onClick={() => go('signup')}>Create an account</button></>)}
        {mode === 'signup' && <button type="button" className={link} onClick={() => go('signin')}>Already have an account? Sign in</button>}
        {(mode === 'forgot' || mode === 'otp') && <button type="button" className={link} onClick={() => go('signin')}>Back to sign in</button>}
      </div>
    </form>
  )
}
