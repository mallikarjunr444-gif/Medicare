'use client'

import { useCallback, useEffect, useState } from 'react'
import { Download, Loader2, Share2 } from 'lucide-react'
import { toast } from 'react-hot-toast'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth/AuthProvider'

const card = 'mt-6 rounded-[1.75rem] border border-[#d2d2d7] bg-white p-5 shadow-[0_4px_20px_rgba(0,0,0,.04)] sm:p-8'
const field = 'mt-1.5 block w-full min-h-11 rounded-xl border border-[#d2d2d7] bg-white px-3.5 text-[15px] text-[#1d1d1f] focus-visible:border-[#0071e3] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#0071e3]/25'
const primary = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-[#0071e3] px-6 text-sm font-medium text-white transition hover:bg-[#0077ed] disabled:cursor-not-allowed disabled:bg-[#0071e3]/40 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#0071e3]/30'
const ghost = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-[#d2d2d7] px-5 text-sm font-medium text-[#1d1d1f] transition hover:bg-[#f5f5f7] disabled:opacity-60 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#0071e3]/30'
const msg = (e: unknown, fallback: string) => {
  const d = (e as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail
  return typeof d === 'string' ? d : fallback
}

const CONSENTS: { purpose: string; label: string; help: string }[] = [
  { purpose: 'ai_processing', label: 'AI assistance', help: 'Let the AI assistant process what you type or say to answer you.' },
  { purpose: 'doctor_sharing', label: 'Share with doctors I choose', help: 'Required before you can give a doctor access. Turning it off removes all doctor access at once.' },
  { purpose: 'analytics', label: 'Anonymous usage statistics', help: 'Cookieless page-view counts. No health information is ever included.' },
]
const SCOPES = [
  { id: 'health_records', label: 'Health records' },
  { id: 'reports', label: 'Consultation reports' },
]

type Grant = Awaited<ReturnType<typeof api.listAccessGrants>>[number]

/** Consent choices, doctor access management and FHIR download. Registered accounts only. */
export function PrivacySharing() {
  const { profile } = useAuth()
  const [consents, setConsents] = useState<Record<string, boolean>>({})
  const [grants, setGrants] = useState<Grant[]>([])
  const [email, setEmail] = useState('')
  const [scopes, setScopes] = useState<string[]>(['health_records'])
  const [days, setDays] = useState(30)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const signedIn = !!profile && !profile.is_guest

  const load = useCallback(async () => {
    try {
      const [c, g] = await Promise.all([api.getConsents(), api.listAccessGrants()])
      setConsents(Object.fromEntries(c.map((x) => [x.purpose, x.granted])))
      setGrants(g)
    } catch {
      setError('Could not load your privacy settings.')
    }
  }, [])
  useEffect(() => { if (signedIn) void load() }, [signedIn, load])
  if (!signedIn) return null

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key); setError(null)
    try { await fn() } catch (e) { setError(msg(e, 'That did not work. Please try again.')) } finally { setBusy(null) }
  }
  const active = grants.filter((g) => !g.revoked && (!g.expires_at || new Date(g.expires_at) > new Date()))

  return (
    <div className={card}>
      <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight text-[#1d1d1f]"><Share2 size={18} aria-hidden="true" />Privacy and sharing</h2>
      <p className="mt-1 text-sm text-[#6e6e73]">You decide who can see your records. Every doctor view is recorded in your activity log.</p>

      <ul className="mt-4 space-y-3">
        {CONSENTS.map((c) => (
          <li key={c.purpose} className="flex items-start gap-3">
            <input id={`consent-${c.purpose}`} type="checkbox" className="mt-1 size-5 accent-[#0071e3]" checked={!!consents[c.purpose]} disabled={busy === c.purpose}
              onChange={(e) => void run(c.purpose, async () => { await api.setConsent(c.purpose, e.target.checked); await load() })} />
            <label htmlFor={`consent-${c.purpose}`} className="text-sm text-[#1d1d1f]"><span className="font-medium">{c.label}</span><span className="block text-[#6e6e73]">{c.help}</span></label>
          </li>
        ))}
      </ul>

      <h3 className="mt-6 text-sm font-semibold text-[#1d1d1f]">Give a doctor access</h3>
      <form className="mt-2 max-w-md" onSubmit={(e) => { e.preventDefault(); void run('grant', async () => {
        await api.grantAccess(email.trim(), scopes, days); setEmail(''); toast.success('Access granted'); await load()
      }) }}>
        <label htmlFor="pg-email" className="text-sm font-medium text-[#1d1d1f]">Doctor’s MediCare email</label>
        <input id="pg-email" type="email" className={field} value={email} onChange={(e) => setEmail(e.target.value)} required disabled={!consents.doctor_sharing} />
        <fieldset className="mt-3" disabled={!consents.doctor_sharing}>
          <legend className="text-sm font-medium text-[#1d1d1f]">They may see</legend>
          {SCOPES.map((s) => (
            <label key={s.id} className="mr-5 inline-flex items-center gap-2 py-1.5 text-sm"><input type="checkbox" className="size-4 accent-[#0071e3]" checked={scopes.includes(s.id)} onChange={(e) => setScopes((p) => e.target.checked ? [...p, s.id] : p.filter((x) => x !== s.id))} />{s.label}</label>
          ))}
        </fieldset>
        <label htmlFor="pg-days" className="mt-2 block text-sm font-medium text-[#1d1d1f]">For how long</label>
        <select id="pg-days" className={field} value={days} onChange={(e) => setDays(Number(e.target.value))} disabled={!consents.doctor_sharing}>
          <option value={1}>1 day</option><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option>
        </select>
        {!consents.doctor_sharing && <p className="mt-2 text-xs text-[#6e6e73]">Turn on “Share with doctors I choose” first.</p>}
        <button type="submit" className={`${primary} mt-4`} disabled={busy === 'grant' || !consents.doctor_sharing || scopes.length === 0}>
          {busy === 'grant' && <Loader2 size={15} className="animate-spin" aria-hidden="true" />}Grant access
        </button>
      </form>

      {active.length > 0 && (
        <ul className="mt-5 divide-y divide-[#e8e8ed] rounded-2xl border border-[#e8e8ed]" aria-label="Doctors with access">
          {active.map((g) => (
            <li key={g.id} className="flex flex-wrap items-center justify-between gap-3 p-3.5 text-sm">
              <span><span className="font-medium text-[#1d1d1f]">{g.doctor_name || g.doctor_email}</span>
                <span className="block text-[#6e6e73]">{g.scopes.join(', ').replace(/_/g, ' ')}{g.expires_at ? ` · until ${new Date(g.expires_at).toLocaleDateString()}` : ''}</span></span>
              <button type="button" className={ghost} disabled={busy === `r${g.id}`} onClick={() => void run(`r${g.id}`, async () => { await api.revokeAccess(g.id); toast.success('Access removed'); await load() })}>Remove access</button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-6 border-t border-[#e8e8ed] pt-5">
        <p className="text-sm text-[#6e6e73]">Take your records to another provider in the standard FHIR format. It is a plain export of what you typed, not a clinical document.</p>
        <button type="button" className={`${ghost} mt-3`} disabled={busy === 'fhir'} onClick={() => void run('fhir', async () => {
          const blob = await api.exportFhir()
          const a = document.createElement('a')
          a.href = URL.createObjectURL(blob); a.download = 'medicare-fhir-export.json'; a.click()
          URL.revokeObjectURL(a.href)
        })}>
          {busy === 'fhir' ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Download size={15} aria-hidden="true" />}Download FHIR export
        </button>
      </div>
      {error && <p role="alert" className="mt-4 text-sm text-[#b3261e]">{error}</p>}
    </div>
  )
}
