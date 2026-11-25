export interface Avatar {
  id: string
  name: string
  status: 'ready' | 'processing' | 'failed' | 'pending'
  thumbnail_url?: string
  image_url?: string
  s3_key?: string
  voice_id?: string | null
  avatar_metadata?: {
    system_prompt?: string
    personality?: string
    background_color?: string
    animation_style?: string
  }
  created_at?: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  created_at: string
}

export interface SessionSummary {
  id: string
  user_id: string
  avatar_id: string
  status: 'active' | 'paused' | 'ended'
  started_at: string
  ended_at?: string | null
}

export type WsMessageType =
  | 'token'
  | 'transcription'
  | 'message'
  | 'audio_chunk'
  | 'audio_stream_end'
  | 'audio_error'
  | 'video_chunk_start'
  | 'video_chunk'
  | 'video_chunk_end'
  | 'status'
  | 'error'
  | 'pong'
  | 'tts_fallback'
  | 'video_error'
  | 'interrupted'

// Discriminated union — each WS event has a well-typed payload so the handler
// can rely on field presence without optional-chaining everywhere.
export type WsMessage =
  | { type: 'token'; token: string }
  | { type: 'transcription'; text: string }
  | { type: 'message'; role: 'assistant'; content: string; triage?: 4; is_emergency?: boolean; sources?: { title: string; year: string; url: string }[] }
  | { type: 'audio_chunk'; chunk_index: number; mime_type: string; text: string; audio_data: string }
  | { type: 'audio_stream_end' }
  | { type: 'audio_error'; message: string }
  | { type: 'video_chunk_start'; total_chunks: number }
  | { type: 'video_chunk'; chunk_index: number; total_chunks: number; video_url: string; text: string }
  | { type: 'video_chunk_end'; sent_chunks: number }
  | { type: 'status'; message: string; stage?: string }
  | { type: 'error'; message: string; code?: string; recoverable?: boolean }
  | { type: 'pong' }
  | { type: 'tts_fallback'; engine: string; voice_cloned: boolean; message: string }
  | { type: 'video_error'; message: string }
  | { type: 'interrupted'; message: string }

export interface VoiceApiResponse {
  id: string
  name: string
  language: string
  duration: number
  created_at?: string
}

export interface ApiError {
  response?: {
    data?: {
      detail?: string
    }
  }
  message?: string
}

export type Gender = 'female' | 'male' | 'non_binary' | 'other' | 'prefer_not_to_say'

/** The signed-in user's profile as stored in Neon (keyed by Firebase UID). */
export interface UserProfile {
  id: string
  firebase_uid: string | null
  full_name: string | null
  email: string
  photo_url: string | null
  phone: string | null
  date_of_birth: string | null
  gender: Gender | null
  is_guest: boolean
  created_at: string | null
  updated_at: string | null
  last_login_at: string | null
}

export type ProfileUpdate = Partial<Pick<UserProfile, 'full_name' | 'phone' | 'date_of_birth' | 'gender'>>

export interface ConsultationItem {
  id: string
  status: string
  doctor_name: string
  doctor_id: string | null
  title: string | null
  summary: string | null
  message_count: number
  triage_level: number | null
  duration_seconds: number | null
  has_report: boolean
  started_at: string | null
  ended_at: string | null
}
