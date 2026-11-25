'use client'

import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, ArrowRight, FileText, Loader2, MessageSquare, Stethoscope } from 'lucide-react'
import { api } from '@/lib/api'
import type { ConsultationItem } from '@/lib/types'

const TRIAGE: Record<number, { label: string; cls: string }> = {
  1: { label: 'General', cls: 'bg-[#eaf6ee] text-[#1b6b3a]' },
  2: { label: 'Assessment', cls: 'bg-[#eaf2fd] text-[#0058b0]' },
  3: { label: 'Urgent', cls: 'bg-[#fff4e0] text-[#9a5b00]' },
  4: { label: 'Emergency', cls: 'bg-[#fff2f0] text-[#b3261e]' },
}

function when(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}

interface Props {
  limit?: number
  onViewAll?: () => void
  onStart?: () => void
}

/** The signed-in user's saved consultations, straight from Neon (the API only ever returns their own). */
export function ConsultationHistory({ limit = 5, onViewAll, onStart }: Readonly<Props>) {
  const { data, isLoading, isError, refetch, isFetching } = useQuery<ConsultationItem[]>({
    queryKey: ['my-consultations', limit],
    queryFn: () => api.getMyConsultations(limit),
  })

  if (isLoading) {
    return (
      <div className="space-y-3" role="status" aria-label="Loading your consultations">
        {[0, 1, 2].map((i) => <div key={i} className="h-[74px] animate-pulse rounded-2xl bg-[#f0f0f3]" />)}
      </div>
    )
  }

  if (isError) {
    return (
      <div role="alert" className="flex flex-col items-start gap-3 rounded-2xl border border-[#f3c9c4] bg-[#fff8f7] p-5 sm:flex-row sm:items-center">
        <AlertTriangle size={20} className="shrink-0 text-[#b3261e]" aria-hidden="true" />
        <p className="text-sm text-[#1d1d1f]">We couldn’t load your consultations right now.</p>
        <button type="button" onClick={() => void refetch()} className="inline-flex min-h-10 items-center gap-2 rounded-full border border-[#d2d2d7] bg-white px-4 text-sm font-medium transition hover:bg-[#f5f5f7] sm:ml-auto">
          {isFetching && <Loader2 size={14} className="animate-spin" aria-hidden="true" />} Try again
        </button>
      </div>
    )
  }

  if (!data?.length) {
    return (
      <div className="rounded-2xl border border-dashed border-[#d2d2d7] bg-white p-8 text-center">
        <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-[#f5f5f7] text-[#0058b0]"><Stethoscope size={20} aria-hidden="true" /></span>
        <p className="mt-3 text-base font-semibold text-[#1d1d1f]">No consultations yet</p>
        <p className="mx-auto mt-1 max-w-xs text-sm leading-6 text-[#6e6e73]">When you talk to a doctor while signed in, the conversation is saved here.</p>
        {onStart && <button type="button" onClick={onStart} className="mt-4 inline-flex min-h-10 items-center gap-2 rounded-full bg-[#0071e3] px-5 text-sm font-medium text-white transition hover:bg-[#0077ed] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#0071e3]/30">Start a consultation <ArrowRight size={14} aria-hidden="true" /></button>}
      </div>
    )
  }

  return (
    <div>
      <ul className="space-y-3">
        {data.map((c) => {
          const triage = c.triage_level ? TRIAGE[c.triage_level] : null
          return (
            <li key={c.id} className="rounded-2xl border border-[#d2d2d7] bg-white p-4 shadow-[0_2px_8px_rgba(0,0,0,.03)]">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <p className="text-sm font-semibold text-[#1d1d1f]">{c.title && c.title !== 'New Conversation' ? c.title : `Consultation with ${c.doctor_name}`}</p>
                {triage && <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${triage.cls}`}>{triage.label}</span>}
                {c.has_report && <span className="inline-flex items-center gap-1 rounded-full bg-[#f5f5f7] px-2.5 py-0.5 text-[11px] font-medium text-[#6e6e73]"><FileText size={11} aria-hidden="true" />Report saved</span>}
              </div>
              <p className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-[#6e6e73]">
                <span>{c.doctor_name}</span>
                <span>{when(c.started_at)}</span>
                <span className="inline-flex items-center gap-1"><MessageSquare size={11} aria-hidden="true" />{c.message_count} message{c.message_count === 1 ? '' : 's'}</span>
              </p>
              {c.summary && <p className="mt-2 line-clamp-2 text-sm leading-6 text-[#424245]">{c.summary}</p>}
            </li>
          )
        })}
      </ul>
      {onViewAll && <button type="button" onClick={onViewAll} className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-[#0058b0] hover:underline focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#0071e3]/30">Open full history <ArrowRight size={14} aria-hidden="true" /></button>}
    </div>
  )
}
