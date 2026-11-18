import { api, apiClient } from '@/lib/api'
import { useStore } from '@/store/useStore'

export interface Instrument {
  id: string; name: string; full_name: string; version: string; purpose: string; intro: string
  options: string[]; items: string[]; notice: string
}
export interface Assignment {
  id: string; instrument: string; name: string
  status: 'assigned' | 'active' | 'paused' | 'completed' | 'ended'
  total_items: number; answered_count: number; draft?: Record<string, number>
}
export interface ResultRow {
  assignment_id: string; instrument: string; name: string; version: string
  total: number | null; severity: string; label: string; screening: 'positive' | 'negative' | null
  flags: { item9Positive?: boolean; shadedCount?: number }; notice: string
  answers: Record<string, number>; corrected: boolean; submitted_at: string
}
export interface Alert { id: string; assignment_id: string; kind: string; message: string; created_at: string; acknowledged_at: string | null }
export interface Intake { full_name: string | null; preferred_name: string | null; dob: string | null; contact: string | null; preferred_language: string | null; occupation: string | null; age: number | null }
export interface ConsultationState {
  id: string; role: 'psychologist' | 'patient'; status: 'scheduled' | 'active' | 'ended'; room: string
  patient_joined: boolean; intake: Intake | null; consents: Record<string, boolean>; assignments: Assignment[]
  join_code?: string; results?: ResultRow[]; alerts?: Alert[]
}

const P = '/api/v1/psych'
const get = async <T,>(url: string) => (await apiClient.get<T>(P + url)).data
const send = async <T,>(method: 'post' | 'put', url: string, body?: unknown) => (await apiClient[method]<T>(P + url, body ?? {})).data

/** The app starts with a placeholder identity; the API needs a real (guest or signed-in) one. */
export async function ensureIdentity(): Promise<void> {
  const token = api.getToken()
  const placeholder = !token || /direct-token|patient-direct/.test(token)
  const store = useStore.getState()
  if (placeholder) {
    const guest = await api.createGuest()
    store.setAuth(guest.access_token, { id: '', email: '', username: 'Guest', is_guest: true })
    store.setAuth(guest.access_token, await api.getProfile())
    return
  }
  try { store.setAuth(token, await api.getProfile()) } catch { /* 401 handler clears; caller retries */ }
}

export async function signIn(email: string, password: string) {
  const data = await api.login(email, password)
  useStore.getState().setAuth(data.access_token, { id: '', email, username: email, is_guest: false })
  useStore.getState().setAuth(data.access_token, await api.getProfile())
}

export const psych = {
  me: () => get<{ is_psychologist: boolean }>('/me'),
  instruments: () => get<Instrument[]>('/instruments'),
  list: () => get<{ id: string; status: string; role: string; join_code?: string; created_at: string; patient_joined: boolean }[]>('/consultations'),
  create: () => send<{ id: string; join_code: string }>('post', '/consultations'),
  join: (code: string) => send<{ id: string }>('post', '/consultations/join', { code }),
  state: (id: string) => get<ConsultationState>(`/consultations/${id}`),
  setStatus: (id: string, action: 'start' | 'end') => send('post', `/consultations/${id}/status`, { action }),
  saveIntake: (id: string, body: Record<string, unknown>) => send<{ age: number | null }>('put', `/consultations/${id}/intake`, body),
  setConsent: (id: string, kind: string, granted: boolean) => send('put', `/consultations/${id}/consents`, { kind, granted }),
  assign: (id: string, instrument: string) => send('post', `/consultations/${id}/assignments`, { instrument }),
  action: (aid: string, action: 'start' | 'pause' | 'resume' | 'end') => send('post', `/assignments/${aid}/action`, { action }),
  saveDraft: (aid: string, answers: Record<string, number>) => send('put', `/assignments/${aid}/draft`, { answers }),
  submit: (aid: string, answers: Record<string, number>) => send<{ status: string; support_message: string | null }>('post', `/assignments/${aid}/submit`, { answers }),
  ack: (alertId: string) => send('post', `/alerts/${alertId}/ack`),
}

export function errorMessage(e: unknown): string {
  const d = (e as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail
  if (typeof d === 'string') return d
  if (Array.isArray(d) && d[0]?.msg) return String(d[0].msg)
  return 'Something went wrong. Please try again.'
}
