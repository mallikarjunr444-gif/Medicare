'use client'

import { useEffect, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import { toast } from 'react-hot-toast'
import { api } from '@/lib/api'

/**
 * Handles the links in verification / password-reset emails (`/#verify=…`, `/#reset=…`).
 * The token is read once, then removed from the address bar and history so it cannot leak via screenshots,
 * shoulder-surfing, or being copied from the URL later. Fragments are never sent to any server.
 */
export function AccountLinkHandler() {
  const [resetToken, setResetToken] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    const m = window.location.hash.match(/^#(verify|reset)=([\w-]{20,200})$/)
    if (!m) return
    window.history.replaceState(null, '', window.location.pathname + window.location.search)
    if (m[1] === 'verify') {
      api.verifyEmail(m[2]).then(() => toast.success('Email verified. Thank you!')).catch(() => toast.error('That verification link is invalid or has expired.'))
    } else {
      setResetToken(m[2])
    }
  }, [])

  if (!resetToken) return null

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (password.length < 8) return setErr('Use at least 8 characters.')
    if (password !== confirm) return setErr('The two passwords do not match.')
    setBusy(true)
    setErr(null)
    try {
      await api.resetPassword(resetToken, password)
      toast.success('Password updated. Please sign in with your new password.')
      setResetToken(null)
    } catch {
      setErr('This reset link is invalid or has expired. Request a new one from the sign-in screen.')
    } finally {
      setBusy(false)
    }
  }
  const field = 'mt-1.5 block w-full min-h-11 rounded-xl border border-[#d2d2d7] bg-white px-3.5 text-[15px] text-[#1d1d1f] focus-visible:border-[#0071e3] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#0071e3]/25'
  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/40 p-0 backdrop-blur-md sm:items-center sm:p-4">
      <form onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="reset-title" className="relative w-full max-w-md rounded-t-[28px] bg-white p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] text-[#1d1d1f] shadow-2xl sm:rounded-[28px] sm:p-8">
        <button type="button" onClick={() => setResetToken(null)} aria-label="Close" className="absolute right-4 top-4 rounded-full p-2 text-[#6e6e73] hover:bg-[#f5f5f7]"><X size={18} aria-hidden="true" /></button>
        <h2 id="reset-title" className="text-[22px] font-semibold tracking-tight">Choose a new password</h2>
        <p className="mt-2 text-sm text-[#6e6e73]">You will be signed out everywhere and asked to sign in again.</p>
        <label htmlFor="rp-new" className="mt-5 block text-sm font-medium">New password</label>
        <input id="rp-new" type="password" autoComplete="new-password" className={field} value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} maxLength={128} required autoFocus />
        <label htmlFor="rp-confirm" className="mt-3 block text-sm font-medium">Confirm new password</label>
        <input id="rp-confirm" type="password" autoComplete="new-password" className={field} value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        {err && <p role="alert" className="mt-3 rounded-xl bg-[#fff2f0] px-3.5 py-2.5 text-[13px] text-[#b3261e]">{err}</p>}
        <button type="submit" disabled={busy} className="mt-5 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-full bg-[#0071e3] px-6 text-sm font-medium text-white hover:bg-[#0077ed] disabled:bg-[#0071e3]/40">
          {busy && <Loader2 size={15} className="animate-spin" aria-hidden="true" />}Update password
        </button>
      </form>
    </div>
  )
}
