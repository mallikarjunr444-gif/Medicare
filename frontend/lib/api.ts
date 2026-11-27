import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios'
import type { ConsultationItem, ProfileUpdate, UserProfile } from '@/lib/types'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

const STORAGE_KEY = 'avatar-system-storage'

// Firebase ID tokens live ~1 hour and are refreshed by the Firebase SDK. AuthProvider keeps this cache
// current (onIdTokenChanged) and registers a provider that can force a refresh, so a long session never
// sends an expired token. While someone is signed in with Google this always wins over the guest token.
let firebaseToken: string | null = null
let firebaseTokenProvider: (() => Promise<string | null>) | null = null

export function setFirebaseAuth(token: string | null, provider: (() => Promise<string | null>) | null) {
  firebaseToken = token
  firebaseTokenProvider = provider
}

function readToken(): string | null {
  if (typeof window === 'undefined') return null
  if (firebaseToken) return firebaseToken
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) return null
    const { state } = JSON.parse(stored)
    const token = state?.token
    // Guests hold a real JWT now (POST /api/v1/users/guest), so there is no
    // longer a synthetic 'guest' sentinel to filter out. The old sentinel is
    // still discarded so a browser holding stale persisted state re-registers
    // as a guest instead of sending an unusable token forever.
    if (!token || token === 'guest' || /direct-token|patient-direct/.test(token)) return null
    return token
  } catch {
    return null
  }
}

// Create axios instance with defaults
const apiClient = axios.create({
  baseURL: API_URL,
  timeout: 30000,
  // Send the httpOnly auth cookie the backend sets on login. Combined with
  // the bearer header (kept for cross-origin API use), this lets the browser
  // authenticate via the XSS-safe cookie. Requires the backend's CORS
  // allow_credentials=true + explicit origin (both already configured).
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
})

// Request interceptor — attach auth token
apiClient.interceptors.request.use(
  async (config: InternalAxiosRequestConfig) => {
    let token: string | null = null
    if (firebaseTokenProvider) {
      try {
        token = await firebaseTokenProvider() // refreshes automatically when close to expiry
        if (token) firebaseToken = token
      } catch {
        token = null
      }
    }
    token = token ?? readToken()
    if (token && !config.headers.Authorization) {
      config.headers.Authorization = `Bearer ${token}`
    }
    return config
  },
  (error) => Promise.reject(error)
)

// Response interceptor — handle 401 globally
apiClient.interceptors.response.use(
  (response) => response,
  (error: AxiosError) => {
    if (error.response?.status === 401) {
      // A signed-in Google user keeps their Firebase session; AuthProvider surfaces the problem instead of wiping state.
      if (typeof window !== 'undefined' && !firebaseToken) {
        localStorage.removeItem(STORAGE_KEY)
        window.dispatchEvent(new CustomEvent('auth:logout'))
      }
    }
    return Promise.reject(error)
  }
)

export const api = {
  // Expose the token getter so non-axios code (WebSocket) can authenticate
  getToken: readToken,

  // Auth
  register: async (data: { email: string; username: string; password: string; full_name?: string }) => {
    const response = await apiClient.post('/api/v1/users/register', data)
    return response.data
  },

  login: async (email: string, password: string, otp?: string) => {
    const formData = new URLSearchParams()
    formData.append('username', email)
    formData.append('password', password)
    if (otp) formData.append('otp', otp)
    const response = await apiClient.post('/api/v1/users/login', formData, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })
    return response.data
  },

  /**
   * Start an anonymous session. The backend creates a real (throwaway) user
   * row and returns its JWT, so a guest's avatars and transcripts are scoped
   * to them alone rather than pooled into one shared account.
   */
  createGuest: async () => {
    const response = await apiClient.post('/api/v1/users/guest')
    return response.data
  },

  logout: async () => {
    // Clears the server-set httpOnly cookie. Best-effort — ignore failures.
    try {
      await apiClient.post('/api/v1/users/logout')
    } catch {
      /* network error on logout is non-fatal */
    }
  },

  // ── Account protection ────────────────────────────────────────────────────
  forgotPassword: async (email: string) => (await apiClient.post('/api/v1/users/forgot-password', { email })).data as { detail: string },
  resetPassword: async (token: string, password: string) => (await apiClient.post('/api/v1/users/reset-password', { token, password })).data as { detail: string },
  verifyEmail: async (token: string) => (await apiClient.post('/api/v1/users/verify-email', { token })).data as { detail: string },
  requestVerification: async () => (await apiClient.post('/api/v1/users/request-verification', {})).data as { detail: string; sent: boolean },
  mfaSetup: async (password: string) => (await apiClient.post('/api/v1/users/me/mfa/setup', { password })).data as { secret: string; otpauth_uri: string },
  mfaEnable: async (code: string) => (await apiClient.post('/api/v1/users/me/mfa/enable', { code })).data as { recovery_codes: string[] },
  mfaDisable: async (password: string, code: string) => (await apiClient.post('/api/v1/users/me/mfa/disable', { password, code })).data as { detail: string },
  logoutAll: async () => (await apiClient.post('/api/v1/users/logout-all', {})).data as { detail: string },
  exportMyData: async (): Promise<Blob> => (await apiClient.get('/api/v1/users/me/export', { responseType: 'blob' })).data as Blob,
  deleteAccount: async (password: string | undefined, code: string | undefined) =>
    (await apiClient.delete('/api/v1/users/me', { data: { confirm: 'DELETE', password, code } })).data as { detail: string },
  changePassword: async (currentPassword: string, password: string) => {
    const r = (await apiClient.put('/api/v1/users/me', { current_password: currentPassword, password })).data as { access_token?: string }
    return r.access_token ?? null
  },

  getProfile: async () => {
    const response = await apiClient.get('/api/v1/users/me')
    return response.data
  },

  // Google / Firebase account. The backend derives the user from the verified ID token only.
  syncFirebaseProfile: async (idToken: string): Promise<{ profile: UserProfile; created: boolean }> => {
    const response = await apiClient.post('/api/v1/auth/firebase', {}, { headers: { Authorization: `Bearer ${idToken}` } })
    return response.data
  },

  getMyProfile: async (): Promise<UserProfile> => {
    const response = await apiClient.get('/api/v1/profile')
    return response.data
  },

  updateMyProfile: async (data: ProfileUpdate): Promise<UserProfile> => {
    const response = await apiClient.put('/api/v1/profile', data)
    return response.data
  },

  getMyConsultations: async (limit = 30): Promise<ConsultationItem[]> => {
    const response = await apiClient.get('/api/v1/profile/consultations', { params: { limit } })
    return response.data
  },

  updateProfile: async (data: { email?: string; username?: string; full_name?: string; password?: string }) => {
    const response = await apiClient.put('/api/v1/users/me', data)
    return response.data
  },

  // Avatars
  uploadAvatar: async (formData: FormData) => {
    const response = await apiClient.post('/api/v1/avatars/upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
    return response.data
  },

  getAvatars: async () => {
    const response = await apiClient.get('/api/v1/avatars/')
    return response.data
  },

  deleteAvatar: async (avatarId: string) => {
    const response = await apiClient.delete(`/api/v1/avatars/${avatarId}`)
    return response.data
  },

  setAvatarVoice: async (avatarId: string, voiceId: string) => {
    const response = await apiClient.put(`/api/v1/avatars/${avatarId}/voice?voice_id=${encodeURIComponent(voiceId)}`)
    return response.data
  },

  unsetAvatarVoice: async (avatarId: string) => {
    // Empty voice_id query → backend unassigns
    const response = await apiClient.put(`/api/v1/avatars/${avatarId}/voice`)
    return response.data
  },

  setAvatarMetadata: async (avatarId: string, metadata: Record<string, unknown>) => {
    const response = await apiClient.patch(`/api/v1/avatars/${avatarId}/metadata`, metadata)
    return response.data
  },

  renameAvatar: async (avatarId: string, name: string) => {
    const response = await apiClient.patch(`/api/v1/avatars/${avatarId}/name`, { name })
    return response.data
  },

  // Sessions
  createSession: async (avatarId: string) => {
    const response = await apiClient.post('/api/v1/sessions/create', {
      avatar_id: avatarId,
    })
    return response.data
  },

  getDoctorAvatar: async (doctorId: 'dr_ananya' | 'dr_arjun') => {
    const response = await apiClient.post(`/api/v1/doctors/${doctorId}/avatar`)
    return response.data
  },

  saveConsultationReport: async (
    sessionId: string,
    payload: {
      doctor_id?: string
      language?: string
      triage_level?: number
      duration_seconds?: number
      report: Record<string, unknown>
    }
  ) => {
    const response = await apiClient.put(`/api/v1/consultation-reports/${sessionId}`, payload)
    return response.data
  },

  getSpecialists: async (district = 'Chikkamagaluru') => {
    const response = await apiClient.get('/api/v1/doctor/specialists', { params: { district } })
    return response.data
  },

  requestAppointment: async (request: {
    specialist_id: string
    preferred_date: string
    preferred_time_slot: string
    reason: string
    patient_confirmed: boolean
  }) => {
    const response = await apiClient.post('/api/v1/doctor/appointments/request', request)
    return response.data
  },

  analyzeLaboratoryReport: async (request: { report_text: string; test_type?: string }) => {
    const response = await apiClient.post('/api/v1/doctor/reports/analyze', request)
    return response.data
  },

  getSessions: async () => {
    const response = await apiClient.get('/api/v1/sessions/')
    return response.data
  },

  getSession: async (sessionId: string) => {
    const response = await apiClient.get(`/api/v1/sessions/${sessionId}`)
    return response.data
  },

  endSession: async (sessionId: string) => {
    const response = await apiClient.post(`/api/v1/sessions/${sessionId}/end`)
    return response.data
  },

  deleteSession: async (sessionId: string) => {
    const response = await apiClient.delete(`/api/v1/sessions/${sessionId}`)
    return response.data
  },

  exportSession: async (sessionId: string) => {
    const response = await apiClient.get(`/api/v1/sessions/${sessionId}/export`, {
      responseType: 'blob',
    })
    return response.data as Blob
  },

  // Messages
  sendMessage: async (sessionId: string, content: string) => {
    const response = await apiClient.post('/api/v1/messages/send', {
      session_id: sessionId,
      content,
    })
    return response.data
  },

  getMessages: async (sessionId: string) => {
    const response = await apiClient.get(`/api/v1/messages/session/${sessionId}`)
    return response.data
  },

  editMessage: async (messageId: string, content: string) => {
    const response = await apiClient.patch(`/api/v1/messages/${messageId}`, { content })
    return response.data
  },

  deleteMessage: async (messageId: string) => {
    const response = await apiClient.delete(`/api/v1/messages/${messageId}`)
    return response.data
  },

  // Voices
  listVoices: async () => {
    const response = await apiClient.get('/api/v1/voices/')
    return response.data
  },

  cloneVoice: async (audio: Blob, name: string, language: string = 'en') => {
    const formData = new FormData()
    formData.append('audio', audio, 'voice_sample.webm')
    formData.append('name', name)
    formData.append('language', language)
    const response = await apiClient.post('/api/v1/voices/clone', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
    return response.data
  },

  deleteVoice: async (voiceId: string) => {
    const response = await apiClient.delete(`/api/v1/voices/${voiceId}`)
    return response.data
  },

  // Returns a fully-qualified URL for the preview WAV. Auth-protected, so the
  // caller must fetch it with credentials (the <audio> tag can't send headers,
  // so we read it via fetch and turn the blob into an object URL).
  getVoicePreviewUrl: (voiceId: string) => `${API_URL}/api/v1/voices/${encodeURIComponent(voiceId)}/preview`,

  fetchVoicePreviewBlob: async (voiceId: string) => {
    const response = await apiClient.get(`/api/v1/voices/${voiceId}/preview`, {
      responseType: 'blob',
    })
    return response.data as Blob
  },

  // Conversations
  listConversations: async () => {
    const response = await apiClient.get('/api/v1/conversations/')
    return response.data
  },

  getSessionConversations: async (sessionId: string) => {
    const response = await apiClient.get(`/api/v1/conversations/session/${sessionId}`)
    return response.data
  },

  renameConversation: async (conversationId: string, title: string) => {
    const response = await apiClient.patch(`/api/v1/conversations/${conversationId}/rename`, { title })
    return response.data
  },

  summarizeConversation: async (conversationId: string) => {
    const response = await apiClient.post(`/api/v1/conversations/${conversationId}/summarize`)
    return response.data
  },

  deleteConversation: async (conversationId: string) => {
    const response = await apiClient.delete(`/api/v1/conversations/${conversationId}`)
    return response.data
  },

  synthesizeVoicePreview: async (voiceId: string, text?: string, language?: string) => {
    const form = new FormData()
    if (text) form.append('text', text)
    if (language) form.append('language', language)
    const response = await apiClient.post(
      `/api/v1/voices/${voiceId}/synthesize`,
      form,
      { responseType: 'blob', headers: { 'Content-Type': 'multipart/form-data' } },
    )
    return response.data as Blob
  },

  // Health
  getHealth: async () => {
    const response = await apiClient.get('/health')
    return response.data
  },
}

/**
 * Build a WebSocket URL for a session, appending the JWT as a query parameter
 * (the WebSocket constructor does not let us attach an Authorization header).
 */
export function buildSessionWsUrl(sessionId: string): string {
  const rawUrl = process.env.NEXT_PUBLIC_WS_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'
  const wsBase = rawUrl.replace(/^http/, 'ws')
  const token = readToken()
  const path = `${wsBase}/ws/session/${encodeURIComponent(sessionId)}`
  return token ? `${path}?token=${encodeURIComponent(token)}` : path
}

/**
 * Preferred: exchange the session for a one-time, 60-second ticket so no long-lived credential appears in the URL.
 * Falls back to the legacy `?token=` URL only if the ticket endpoint is unavailable (e.g. API not yet redeployed).
 */
export async function getSessionWsUrl(sessionId: string): Promise<string> {
  try {
    const { data } = await apiClient.post('/api/v1/users/ws-ticket', {})
    if (data?.ticket) {
      const rawUrl = process.env.NEXT_PUBLIC_WS_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'
      return `${rawUrl.replace(/^http/, 'ws')}/ws/session/${encodeURIComponent(sessionId)}?ticket=${encodeURIComponent(data.ticket)}`
    }
  } catch {
    /* fall through */
  }
  return buildSessionWsUrl(sessionId)
}

export { apiClient }
