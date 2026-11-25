'use client'

import { useEffect, useMemo, useState } from 'react'
import { CalendarClock, Check, Loader2, LogOut, Mail, ShieldCheck } from 'lucide-react'
import { toast } from 'react-hot-toast'
import { UserAvatar } from '@/components/auth/UserAvatar'
import { useAuth } from '@/lib/auth/AuthProvider'
import type { Gender, ProfileUpdate } from '@/lib/types'

const GENDERS: { value: Gender; label: string }[] = [
  { value: 'female', label: 'Female' },
  { value: 'male', label: 'Male' },
  { value: 'non_binary', label: 'Non-binary' },
  { value: 'other', label: 'Other' },
  { value: 'prefer_not_to_say', label: 'Prefer not to say' },
]

const field = 'mt-1.5 w-full rounded-xl border border-[#d2d2d7] bg-white px-3.5 py-3 text-[15px] text-[#1d1d1f] outline-none transition placeholder:text-[#a1a1a6] focus:border-[#0071e3] focus:ring-4 focus:ring-[#0071e3]/15 disabled:bg-[#f5f5f7] disabled:text-[#6e6e73]'
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : '—')

/** Turns the API's validation list ({ loc: ['body','phone'], msg }) into per-field messages. */
function fieldErrors(e: unknown): Record<string, string> {
  const detail = (e as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail
  const out: Record<string, string> = {}
  if (Array.isArray(detail)) for (const d of detail) if (Array.isArray(d?.loc) && typeof d.msg === 'string') out[String(d.loc[d.loc.length - 1])] = d.msg
  return out
}

export function ProfilePage() {
  const { profile, updateProfile, signOut } = useAuth()
  const initial = useMemo(() => ({
    full_name: profile?.full_name ?? '', phone: profile?.phone ?? '', date_of_birth: profile?.date_of_birth ?? '', gender: profile?.gender ?? '',
  }), [profile])
  const [form, setForm] = useState(initial)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [signingOut, setSigningOut] = useState(false)

  useEffect(() => setForm(initial), [initial])

  if (!profile) return null
  const dirty = (Object.keys(initial) as (keyof typeof initial)[]).some((k) => form[k] !== initial[k])
  const set = (k: keyof typeof form, v: string) => {
    setForm((f) => ({ ...f, [k]: v }))
    setErrors((e) => ({ ...e, [k]: '' }))
  }

  const save = async (ev: React.FormEvent) => {
    ev.preventDefault()
    const next: Record<string, string> = {}
    if (!form.full_name.trim()) next.full_name = 'Please enter your name'
    if (Object.keys(next).length) return setErrors(next)
    const patch: ProfileUpdate = {}
    if (form.full_name !== initial.full_name) patch.full_name = form.full_name.trim()
    if (form.phone !== initial.phone) patch.phone = form.phone.trim() || null
    if (form.date_of_birth !== initial.date_of_birth) patch.date_of_birth = form.date_of_birth || null
    if (form.gender !== initial.gender) patch.gender = (form.gender || null) as Gender | null
    setSaving(true)
    try {
      await updateProfile(patch)
      toast.success('Profile saved')
    } catch (e) {
      const fe = fieldErrors(e)
      setErrors(fe)
      if (!Object.keys(fe).length) toast.error('Could not save your profile. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  const today = new Date().toISOString().slice(0, 10)

  return (
    <section className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
      <div className="flex items-center gap-4">
        <UserAvatar name={profile.full_name} email={profile.email} photoUrl={profile.photo_url} size={72} />
        <div className="min-w-0">
          <h1 className="truncate text-[28px] font-semibold leading-tight tracking-[-0.03em] text-[#1d1d1f] sm:text-[34px]">{profile.full_name || 'Your profile'}</h1>
          <p className="mt-0.5 flex items-center gap-1.5 truncate text-sm text-[#6e6e73]"><Mail size={14} aria-hidden="true" />{profile.email}</p>
        </div>
      </div>

      <form onSubmit={save} noValidate className="mt-8 rounded-[1.75rem] border border-[#d2d2d7] bg-white p-5 shadow-[0_4px_20px_rgba(0,0,0,.04)] sm:p-8">
        <h2 className="text-lg font-semibold tracking-tight text-[#1d1d1f]">Personal information</h2>
        <p className="mt-1 text-sm text-[#6e6e73]">Only you can see this. It helps your doctor give better guidance.</p>
        <div className="mt-6 grid gap-5 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label htmlFor="pf-name" className="text-sm font-medium text-[#1d1d1f]">Full name</label>
            <input id="pf-name" className={field} value={form.full_name} maxLength={200} autoComplete="name" onChange={(e) => set('full_name', e.target.value)} aria-invalid={Boolean(errors.full_name)} aria-describedby={errors.full_name ? 'pf-name-err' : undefined} />
            {errors.full_name && <p id="pf-name-err" role="alert" className="mt-1.5 text-[13px] text-[#b3261e]">{errors.full_name}</p>}
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="pf-email" className="text-sm font-medium text-[#1d1d1f]">Email</label>
            <input id="pf-email" className={field} value={profile.email} disabled readOnly />
            <p className="mt-1.5 text-xs text-[#6e6e73]">From your Google account, so it can’t be edited here.</p>
          </div>
          <div>
            <label htmlFor="pf-phone" className="text-sm font-medium text-[#1d1d1f]">Phone <span className="font-normal text-[#6e6e73]">(optional)</span></label>
            <input id="pf-phone" type="tel" inputMode="tel" autoComplete="tel" placeholder="+91 98765 43210" className={field} value={form.phone} onChange={(e) => set('phone', e.target.value)} aria-invalid={Boolean(errors.phone)} aria-describedby={errors.phone ? 'pf-phone-err' : undefined} />
            {errors.phone && <p id="pf-phone-err" role="alert" className="mt-1.5 text-[13px] text-[#b3261e]">{errors.phone}</p>}
          </div>
          <div>
            <label htmlFor="pf-dob" className="text-sm font-medium text-[#1d1d1f]">Date of birth <span className="font-normal text-[#6e6e73]">(optional)</span></label>
            <input id="pf-dob" type="date" min="1900-01-01" max={today} autoComplete="bday" className={field} value={form.date_of_birth} onChange={(e) => set('date_of_birth', e.target.value)} aria-invalid={Boolean(errors.date_of_birth)} aria-describedby={errors.date_of_birth ? 'pf-dob-err' : undefined} />
            {errors.date_of_birth && <p id="pf-dob-err" role="alert" className="mt-1.5 text-[13px] text-[#b3261e]">{errors.date_of_birth}</p>}
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="pf-gender" className="text-sm font-medium text-[#1d1d1f]">Gender <span className="font-normal text-[#6e6e73]">(optional)</span></label>
            <select id="pf-gender" className={field} value={form.gender} onChange={(e) => set('gender', e.target.value)}>
              <option value="">Not specified</option>
              {GENDERS.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
            </select>
            {errors.gender && <p role="alert" className="mt-1.5 text-[13px] text-[#b3261e]">{errors.gender}</p>}
          </div>
        </div>
        <div className="mt-7 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-end">
          {dirty && <button type="button" onClick={() => { setForm(initial); setErrors({}) }} className="min-h-11 rounded-full px-5 text-sm font-medium text-[#6e6e73] transition hover:text-[#1d1d1f]">Discard changes</button>}
          <button type="submit" disabled={!dirty || saving} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-[#0071e3] px-7 text-sm font-medium text-white transition hover:bg-[#0077ed] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#0071e3]/30 disabled:cursor-not-allowed disabled:bg-[#0071e3]/40">
            {saving ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}{saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>

      <div className="mt-6 rounded-[1.75rem] border border-[#d2d2d7] bg-white p-5 shadow-[0_4px_20px_rgba(0,0,0,.04)] sm:p-8">
        <h2 className="text-lg font-semibold tracking-tight text-[#1d1d1f]">Account</h2>
        <dl className="mt-4 divide-y divide-[#f0f0f3] text-sm">
          <div className="flex items-center justify-between gap-4 py-3"><dt className="flex items-center gap-2 text-[#6e6e73]"><ShieldCheck size={15} aria-hidden="true" />Sign-in method</dt><dd className="font-medium text-[#1d1d1f]">Google</dd></div>
          <div className="flex items-center justify-between gap-4 py-3"><dt className="flex items-center gap-2 text-[#6e6e73]"><CalendarClock size={15} aria-hidden="true" />Member since</dt><dd className="font-medium text-[#1d1d1f]">{fmt(profile.created_at)}</dd></div>
          <div className="flex items-center justify-between gap-4 py-3"><dt className="flex items-center gap-2 text-[#6e6e73]"><CalendarClock size={15} aria-hidden="true" />Last sign-in</dt><dd className="font-medium text-[#1d1d1f]">{fmt(profile.last_login_at)}</dd></div>
          <div className="flex items-center justify-between gap-4 py-3"><dt className="text-[#6e6e73]">Account ID</dt><dd className="font-mono text-xs text-[#1d1d1f]">…{(profile.firebase_uid ?? profile.id).slice(-8)}</dd></div>
        </dl>
        <button type="button" disabled={signingOut} onClick={async () => { setSigningOut(true); await signOut(); setSigningOut(false) }} className="mt-5 inline-flex min-h-11 items-center gap-2 rounded-full border border-[#d2d2d7] px-6 text-sm font-medium text-[#b3261e] transition hover:bg-[#fff8f7] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#b3261e]/20 disabled:opacity-60">
          {signingOut ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <LogOut size={15} aria-hidden="true" />}Sign out
        </button>
      </div>
    </section>
  )
}
