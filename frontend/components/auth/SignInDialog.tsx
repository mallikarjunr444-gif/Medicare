'use client'

import { useEffect, useRef } from 'react'
import { ShieldCheck, X } from 'lucide-react'
import { useAuth } from '@/lib/auth/AuthProvider'
import { GoogleSignInButton } from './GoogleSignInButton'

/** One screen for both sign-in and sign-up: Google creates the account the first time. */
export function SignInDialog({ onClose }: Readonly<{ onClose: () => void }>) {
  const { status, busy, error, signInWithGoogle, clearError } = useAuth()
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (status === 'signed-in') onClose()
  }, [status, onClose])

  useEffect(() => {
    clearError()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onClose, clearError])

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/40 p-0 backdrop-blur-md sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby="signin-title" className="relative w-full max-w-md rounded-t-[28px] bg-white p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] text-[#1d1d1f] shadow-2xl sm:rounded-[28px] sm:p-8">
        <button ref={closeRef} type="button" onClick={onClose} aria-label="Close" className="absolute right-4 top-4 rounded-full p-2 text-[#6e6e73] transition hover:bg-[#f5f5f7] hover:text-[#1d1d1f] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#0071e3]/30">
          <X size={18} aria-hidden="true" />
        </button>
        <div className="text-center">
          <span className="block text-[26px] font-semibold leading-none tracking-[-0.045em]">MediCare</span>
          <h2 id="signin-title" className="mt-5 text-[22px] font-semibold tracking-tight">Sign in or create your account</h2>
          <p className="mx-auto mt-2 max-w-xs text-sm leading-6 text-[#6e6e73]">
            One tap with Google. Your consultations, reports and health records are saved to your account and waiting for you next time.
          </p>
        </div>

        <div className="mt-6">
          <GoogleSignInButton onClick={signInWithGoogle} loading={busy || status === 'loading'} />
          {error && (
            <p role="alert" className="mt-3 rounded-xl bg-[#fff2f0] px-3.5 py-2.5 text-[13px] leading-5 text-[#b3261e]">
              {error}
            </p>
          )}
        </div>

        <div className="mt-6 flex items-start gap-2.5 rounded-2xl bg-[#f5f5f7] p-3.5 text-xs leading-5 text-[#6e6e73]">
          <ShieldCheck size={16} className="mt-0.5 shrink-0 text-[#0071e3]" aria-hidden="true" />
          <span>We only receive your name, email and photo from Google. We never see your Google password, and your records are visible only to you.</span>
        </div>
        <p className="mt-4 text-center text-[11px] leading-relaxed text-[#6e6e73]">
          By continuing you agree to the <a href="/terms" target="_blank" rel="noreferrer" className="text-[#0071e3] hover:underline">Terms</a> and <a href="/privacy" target="_blank" rel="noreferrer" className="text-[#0071e3] hover:underline">Privacy Policy</a>.
        </p>
        <button type="button" onClick={onClose} className="mx-auto mt-3 block text-[13px] font-medium text-[#0071e3] hover:underline focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#0071e3]/30">
          Not now, continue without signing in
        </button>
      </div>
    </div>
  )
}
