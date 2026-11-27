'use client'

import { useState } from 'react'
import { Download, KeyRound, Loader2, LogOut, ShieldCheck, Trash2 } from 'lucide-react'
import { toast } from 'react-hot-toast'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth/AuthProvider'

const card = 'mt-6 rounded-[1.75rem] border border-[#d2d2d7] bg-white p-5 shadow-[0_4px_20px_rgba(0,0,0,.04)] sm:p-8'
const field = 'mt-1.5 block w-full min-h-11 rounded-xl border border-[#d2d2d7] bg-white px-3.5 text-[15px] text-[#1d1d1f] focus-visible:border-[#0071e3] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#0071e3]/25'
const primary = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-[#0071e3] px-6 text-sm font-medium text-white transition hover:bg-[#0077ed] disabled:cursor-not-allowed disabled:bg-[#0071e3]/40 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#0071e3]/30'
const ghost = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-[#d2d2d7] px-6 text-sm font-medium text-[#1d1d1f] transition hover:bg-[#f5f5f7] disabled:opacity-60 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#0071e3]/30'
const msg = (e: unknown, fallback: string) => {
  const d = (e as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail
  return typeof d === 'string' ? d : fallback
}

type MfaStep = 'idle' | 'password' | 'code' | 'done' | 'disable'

/** Security controls: MFA (email/password accounts), sign out everywhere, data export, account deletion. */
export function SecuritySettings() {
  const { profile, isPasswordAccount, signOut } = useAuth()
  const [mfaOn, setMfaOn] = useState<boolean | null>(null)
  const [step, setStep] = useState<MfaStep>('idle')
  const [pw, setPw] = useState('')
  const [code, setCode] = useState('')
  const [secret, setSecret] = useState('')
  const [uri, setUri] = useState('')
  const [recovery, setRecovery] = useState<string[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [delOpen, setDelOpen] = useState(false)
  const [delPw, setDelPw] = useState('')
  const [delCode, setDelCode] = useState('')

  if (!profile || profile.is_guest) return null
  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key); setError(null)
    try { await fn() } catch (e) { setError(msg(e, 'That did not work. Please try again.')) } finally { setBusy(null) }
  }
  const enabled = mfaOn ?? profile.mfa_enabled ?? false

  return (
    <>
      {isPasswordAccount && profile.email_verified === false && (
        <div className={card} role="status">
          <p className="text-sm text-[#1d1d1f]">Your email address is not verified yet.</p>
          <button type="button" className={`${ghost} mt-3`} disabled={busy === 'verify'} onClick={() => void run('verify', async () => { const r = await api.requestVerification(); toast[r.sent ? 'success' : 'error'](r.detail) })}>Send verification email</button>
        </div>
      )}
      {isPasswordAccount ? (
        <div className={card}>
          <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight text-[#1d1d1f]"><ShieldCheck size={18} aria-hidden="true" />Two-step verification</h2>
          <p className="mt-1 text-sm text-[#6e6e73]">Add an authenticator app (Google Authenticator, Authy, 1Password) so a stolen password alone cannot open your account.</p>
          {step === 'idle' && (
            <div className="mt-4 flex flex-wrap gap-3">
              {!enabled ? <button type="button" className={primary} onClick={() => { setError(null); setStep('password') }}>Set up two-step verification</button>
                : <button type="button" className={ghost} onClick={() => { setError(null); setStep('disable') }}>Turn off</button>}
            </div>
          )}
          {step === 'password' && (
            <form className="mt-4 max-w-sm" onSubmit={(e) => { e.preventDefault(); void run('setup', async () => { const r = await api.mfaSetup(pw); setSecret(r.secret); setUri(r.otpauth_uri); setPw(''); setStep('code') }) }}>
              <label htmlFor="mfa-pw" className="text-sm font-medium">Confirm your password</label>
              <input id="mfa-pw" type="password" autoComplete="current-password" className={field} value={pw} onChange={(e) => setPw(e.target.value)} required />
              <button type="submit" className={`${primary} mt-3`} disabled={busy === 'setup'}>{busy === 'setup' && <Loader2 size={15} className="animate-spin" aria-hidden="true" />}Continue</button>
            </form>
          )}
          {step === 'code' && (
            <form className="mt-4 max-w-sm" onSubmit={(e) => { e.preventDefault(); void run('enable', async () => { const r = await api.mfaEnable(code.trim()); setRecovery(r.recovery_codes); setMfaOn(true); setCode(''); setStep('done') }) }}>
              <p className="text-sm text-[#1d1d1f]">Add this key to your authenticator app, then enter the 6-digit code it shows.</p>
              <p className="mt-2 break-all rounded-xl bg-[#f5f5f7] p-3 font-mono text-sm tracking-wider" aria-label="Setup key">{secret}</p>
              <p className="mt-1 text-xs text-[#6e6e73]">On a phone you can open <a className="text-[#0071e3] underline" href={uri}>this setup link</a> instead.</p>
              <label htmlFor="mfa-code" className="mt-3 block text-sm font-medium">6-digit code</label>
              <input id="mfa-code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} className={field} value={code} onChange={(e) => setCode(e.target.value)} required />
              <button type="submit" className={`${primary} mt-3`} disabled={busy === 'enable'}>{busy === 'enable' && <Loader2 size={15} className="animate-spin" aria-hidden="true" />}Turn on</button>
            </form>
          )}
          {step === 'done' && (
            <div className="mt-4" role="status">
              <p className="text-sm font-medium text-[#1d1d1f]">Two-step verification is on. Your other devices were signed out.</p>
              <p className="mt-2 text-sm text-[#6e6e73]">Save these recovery codes somewhere safe. Each works once and they will not be shown again.</p>
              <ul className="mt-3 grid grid-cols-2 gap-2 rounded-xl bg-[#f5f5f7] p-3 font-mono text-sm">{recovery.map((r) => <li key={r}>{r}</li>)}</ul>
              <button type="button" className={`${ghost} mt-3`} onClick={() => { setRecovery([]); setStep('idle') }}>I have saved them</button>
            </div>
          )}
          {step === 'disable' && (
            <form className="mt-4 max-w-sm" onSubmit={(e) => { e.preventDefault(); void run('disable', async () => { await api.mfaDisable(pw, code.trim()); setMfaOn(false); setPw(''); setCode(''); setStep('idle'); toast.success('Two-step verification turned off') }) }}>
              <label htmlFor="mfa-dpw" className="text-sm font-medium">Password</label>
              <input id="mfa-dpw" type="password" autoComplete="current-password" className={field} value={pw} onChange={(e) => setPw(e.target.value)} required />
              <label htmlFor="mfa-dcode" className="mt-3 block text-sm font-medium">Authenticator or recovery code</label>
              <input id="mfa-dcode" autoComplete="one-time-code" className={field} value={code} onChange={(e) => setCode(e.target.value)} required />
              <div className="mt-3 flex gap-3"><button type="submit" className={primary} disabled={busy === 'disable'}>Turn off</button><button type="button" className={ghost} onClick={() => setStep('idle')}>Cancel</button></div>
            </form>
          )}
        </div>
      ) : (
        <div className={card}>
          <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight text-[#1d1d1f]"><ShieldCheck size={18} aria-hidden="true" />Sign-in security</h2>
          <p className="mt-1 text-sm text-[#6e6e73]">You sign in with Google, so password and two-step verification are managed in your Google Account security settings.</p>
        </div>
      )}

      <div className={card}>
        <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight text-[#1d1d1f]"><KeyRound size={18} aria-hidden="true" />Your data</h2>
        <div className="mt-4 flex flex-wrap gap-3">
          {isPasswordAccount && (
            <button type="button" className={ghost} disabled={busy === 'all'} onClick={() => void run('all', async () => { await api.logoutAll(); await signOut() })}>
              <LogOut size={15} aria-hidden="true" />Sign out of all devices
            </button>
          )}
          <button type="button" className={ghost} disabled={busy === 'export'} onClick={() => void run('export', async () => {
            const blob = await api.exportMyData()
            const a = document.createElement('a')
            a.href = URL.createObjectURL(blob); a.download = 'medicare-data-export.json'; a.click()
            URL.revokeObjectURL(a.href)
          })}>
            {busy === 'export' ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Download size={15} aria-hidden="true" />}Download my data
          </button>
          <button type="button" className={`${ghost} text-[#b3261e]`} onClick={() => { setError(null); setDelOpen((o) => !o) }}><Trash2 size={15} aria-hidden="true" />Delete my account</button>
        </div>
        {delOpen && (
          <form className="mt-5 max-w-sm rounded-2xl border border-[#f3c9c4] bg-[#fff8f7] p-4" onSubmit={(e) => { e.preventDefault(); void run('delete', async () => {
            await api.deleteAccount(isPasswordAccount ? delPw : undefined, delCode.trim() || undefined)
            toast.success('Your account and data were deleted')
            await signOut()
          }) }}>
            <p className="text-sm text-[#1d1d1f]">This permanently deletes your account, consultations, reports and health records. It cannot be undone.</p>
            {isPasswordAccount && (<>
              <label htmlFor="del-pw" className="mt-3 block text-sm font-medium">Password</label>
              <input id="del-pw" type="password" autoComplete="current-password" className={field} value={delPw} onChange={(e) => setDelPw(e.target.value)} required />
              {enabled && (<><label htmlFor="del-code" className="mt-3 block text-sm font-medium">Authenticator or recovery code</label><input id="del-code" className={field} value={delCode} onChange={(e) => setDelCode(e.target.value)} required /></>)}
            </>)}
            <button type="submit" disabled={busy === 'delete'} className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-full bg-[#b3261e] px-6 text-sm font-medium text-white hover:bg-[#9c2019] disabled:opacity-60">
              {busy === 'delete' && <Loader2 size={15} className="animate-spin" aria-hidden="true" />}Permanently delete
            </button>
          </form>
        )}
        {error && <p role="alert" className="mt-4 rounded-xl bg-[#fff2f0] px-3.5 py-2.5 text-[13px] text-[#b3261e]">{error}</p>}
      </div>
    </>
  )
}
