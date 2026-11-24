'use client'

import { Loader2, LockKeyhole, RefreshCw } from 'lucide-react'
import { useAuth } from '@/lib/auth/AuthProvider'
import { GoogleSignInButton } from './GoogleSignInButton'

interface Props {
  /** What the person is trying to open, e.g. "your care dashboard". */
  what: string
  children: React.ReactNode
}

/** Client-side gate for account pages. The API enforces the same rule on the server, this only chooses what to show. */
export function AuthGuard({ what, children }: Readonly<Props>) {
  const { status, busy, error, signInWithGoogle, retry } = useAuth()

  if (status === 'signed-in') return <>{children}</>

  const shell = 'mx-auto flex min-h-[calc(100dvh-8rem)] max-w-md flex-col items-center justify-center px-4 py-12 text-center'

  if (status === 'loading') {
    return (
      <div className={shell} role="status" aria-live="polite">
        <Loader2 className="animate-spin text-[#0071e3]" size={28} aria-hidden="true" />
        <p className="mt-4 text-sm font-medium text-[#6e6e73]">Checking your sign-in…</p>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div className={shell}>
        <p role="alert" className="text-lg font-semibold text-[#1d1d1f]">We couldn’t load your account</p>
        <p className="mt-2 text-sm leading-6 text-[#6e6e73]">{error ?? 'Something went wrong.'}</p>
        <button type="button" onClick={() => void retry()} className="mt-6 inline-flex min-h-11 items-center gap-2 rounded-full bg-[#0071e3] px-6 text-sm font-medium text-white transition hover:bg-[#0077ed] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#0071e3]/30">
          <RefreshCw size={15} aria-hidden="true" /> Try again
        </button>
      </div>
    )
  }

  return (
    <div className={shell}>
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white text-[#0071e3] shadow-[0_2px_10px_rgba(0,0,0,.06)]">
        <LockKeyhole size={24} aria-hidden="true" />
      </span>
      <h1 className="mt-5 text-2xl font-semibold tracking-tight text-[#1d1d1f]">Sign in to see {what}</h1>
      <p className="mt-2 text-sm leading-6 text-[#6e6e73]">Your consultations, reports and health records are private to you and saved to your account.</p>
      <div className="mt-6 w-full max-w-xs">
        <GoogleSignInButton onClick={signInWithGoogle} loading={busy} />
        {error && <p role="alert" className="mt-3 rounded-xl bg-[#fff2f0] px-3.5 py-2.5 text-[13px] leading-5 text-[#b3261e]">{error}</p>}
      </div>
    </div>
  )
}
