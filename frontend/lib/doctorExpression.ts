/** Facial expression for the digital doctor. Driven only by the doctor's state and by simple keywords in what the patient wrote. */
export type DoctorExpression = 'neutral' | 'warm' | 'concerned'

// English, Hindi and Kannada words for pain, fear, sadness or distress. Deliberately short and cautious.
const CONCERN = /\b(pain|hurts?|bleeding|chest|breath|dizzy|faint|scared|afraid|anxious|worried|depress\w*|hopeless|sad|crying|cry|panic|stress\w*|can'?t sleep|suicid\w*|emergency|severe)\b|दर्द|डर|घबराहट|चिंता|उदास|तनाव|सांस|ನೋವು|ಭಯ|ಆತಂಕ|ಚಿಂತೆ|ದುಃಖ|ಒತ್ತಡ|ಉಸಿರು/i

export function expressionFor(lastPatientText: string | undefined, state: string): DoctorExpression {
  if (state === 'disconnected') return 'neutral'
  if (lastPatientText && CONCERN.test(lastPatientText)) return 'concerned'
  if (state === 'listening' || state === 'speaking') return 'warm'
  return 'neutral'
}

/** Target pose offsets for each expression. smile: -0.5 (corners down) .. 1 (broad smile). brow: 0..1 lift. */
export const EXPRESSION_POSE: Record<DoctorExpression, { smile: number; brow: number }> = {
  neutral: { smile: 0.05, brow: 0 },
  warm: { smile: 0.4, brow: 0.05 },
  concerned: { smile: -0.25, brow: 0.35 },
}
