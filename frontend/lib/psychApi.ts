import { api, apiClient } from '@/lib/api'
import { useStore } from '@/store/useStore'

export interface Instrument {
  id: string; name: string; full_name: string; version: string; purpose: string; intro: string
  options: string[]; items: string[]; notice: string; attribution?: string | null
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

// ---------- stages 7-15 ----------
export interface TaskRun { id: string; task: 'reaction' | 'digitspan' | 'stroop' | 'nback'; name: string; status: 'assigned' | 'active' | 'completed'; result?: { summary: Record<string, unknown> } }
export interface NoteRow { id: string; kind: string; body: string; created_at: string; updated_at: string }
export interface Dashboard {
  assessments: { id: string; instrument: string; name: string; status: string; result: null | { total: number | null; severity: string; label: string | null; screening: string | null; notice: string; submitted_at: string; corrected: boolean } }[]
  missing: string[]
  comparison: { instrument: string; name: string; total_score: number | null; severity: string; submitted_at: string }[]
  observers: { id: string; label: string; relationship: string | null; status: string; submitted_at: string | null; answers: { answers: Record<string, number>; comment: string } | null }[]
  tasks: { id: string; name: string; status: string; summary: Record<string, unknown> | null; note: string }[]
  forms: { id: string; title: string; status: string; items: string[]; options: string[]; answers: Record<string, number> | null }[]
  external: { id: string; name: string; administered_on: string; administered_by: string; authorization_ref: string; scores: { label: string; value: string; note?: string }[]; comments: string | null }[]
  alerts: { id: string; message: string; acknowledged_at: string | null }[]
}
export interface CustomForm { id: string; title: string; status: 'assigned' | 'active' | 'completed'; intro?: string; options?: string[]; items?: string[]; answers?: Record<string, number> | null }
export interface Report { exists: boolean; order: [string, string][]; sections?: Record<string, string>; missing?: string[]; status?: 'draft' | 'approved'; approver_name?: string; approver_credentials?: string; approved_at?: string; draft_notice?: string }
export interface ObserverForm { title: string; notice: string; options: string[]; items: string[]; observer_label: string }

export const psychX = {
  tasks: (id: string) => get<TaskRun[]>(`/consultations/${id}/tasks`),
  assignTask: (id: string, task: string) => send('post', `/consultations/${id}/tasks`, { task }),
  startTask: (tid: string) => send('post', `/tasks/${tid}/start`),
  submitTask: (tid: string, trials: unknown[]) => send('post', `/tasks/${tid}/submit`, { trials }),
  forms: (id: string) => get<CustomForm[]>(`/consultations/${id}/forms`),
  createForm: (id: string, body: { title: string; intro: string; options: string[]; items: string[] }) => send('post', `/consultations/${id}/forms`, body),
  startForm: (fid: string) => send('post', `/forms/${fid}/start`),
  submitForm: (fid: string, answers: Record<string, number>) => send('post', `/forms/${fid}/submit`, { answers }),
  invite: (id: string, label: string, relationship: string) => send<{ id: string; token: string }>('post', `/consultations/${id}/observers`, { label, relationship }),
  revokeInvite: (oid: string) => send('post', `/observers/${oid}/revoke`),
  external: (id: string, body: Record<string, unknown>) => send('post', `/consultations/${id}/external`, body),
  interview: (id: string) => get<{ data: Record<string, Record<string, string> | string> }>(`/consultations/${id}/interview`),
  saveInterview: (id: string, data: unknown) => send('put', `/consultations/${id}/interview`, { data }),
  notes: (id: string) => get<{ kinds: { notes: string[]; history: string[] }; notes: NoteRow[] }>(`/consultations/${id}/notes`),
  addNote: (id: string, kind: string, body: string) => send('post', `/consultations/${id}/notes`, { kind, body }),
  editNote: (nid: string, body: string) => send('put', `/notes/${nid}`, { body }),
  dashboard: (id: string) => get<Dashboard>(`/consultations/${id}/dashboard`),
  history: (id: string) => get<{ consultations: { id: string; status: string; created_at: string; assessments: number; approved_reports: number }[]; history: NoteRow[] }>(`/consultations/${id}/history`),
  report: (id: string) => get<Report>(`/consultations/${id}/report`),
  generateReport: (id: string) => send('post', `/consultations/${id}/report/generate`),
  saveReport: (id: string, sections: Record<string, string>) => send('put', `/consultations/${id}/report`, { sections }),
  approveReport: (id: string, body: Record<string, unknown>) => send('post', `/consultations/${id}/report/approve`, body),
}
export const observerApi = {
  form: async (token: string) => (await apiClient.get<ObserverForm>(`/api/v1/psych-observer/${token}`)).data,
  submit: async (token: string, answers: Record<string, number>, comment: string) => (await apiClient.post(`/api/v1/psych-observer/${token}`, { answers, comment })).data,
}
