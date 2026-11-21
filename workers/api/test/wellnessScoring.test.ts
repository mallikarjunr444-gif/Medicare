import { describe, expect, it } from 'vitest'
import { CRISIS_RESOURCES, EMPTY_CHECKIN, PSS10, WHO5, checkInComplete, needsSafetySupport, scoreQuestionnaire } from '../../../frontend/lib/wellness/instruments'

describe('WHO-5', () => {
  it('scores raw x4', () => {
    expect(scoreQuestionnaire(WHO5, [5, 5, 5, 5, 5])).toMatchObject({ raw: 25, percent: 100, band: 'Within the usual range' })
    expect(scoreQuestionnaire(WHO5, [0, 0, 0, 0, 0])).toMatchObject({ raw: 0, percent: 0, band: 'Lower than usual well-being' })
    expect(scoreQuestionnaire(WHO5, [3, 3, 3, 3, 3])?.percent).toBe(60)
    expect(scoreQuestionnaire(WHO5, [2, 2, 2, 2, 2])?.percent).toBe(40)
  })
  it('refuses incomplete or invalid answers', () => {
    expect(scoreQuestionnaire(WHO5, [5, 5, 5, 5, null])).toBeNull()
    expect(scoreQuestionnaire(WHO5, [5, 5, 5, 5, 9])).toBeNull()
    expect(scoreQuestionnaire(WHO5, [5, 5, 5])).toBeNull()
  })
})

describe('PSS-10', () => {
  it('reverse scores items 4, 5, 7 and 8', () => {
    expect(scoreQuestionnaire(PSS10, [0, 0, 0, 4, 4, 0, 4, 4, 0, 0])?.raw).toBe(0)
    expect(scoreQuestionnaire(PSS10, [4, 4, 4, 0, 0, 4, 0, 0, 4, 4])?.raw).toBe(40)
    expect(scoreQuestionnaire(PSS10, Array(10).fill(2))?.raw).toBe(20)
  })
  it('bands', () => {
    expect(scoreQuestionnaire(PSS10, [1, 1, 1, 3, 3, 1, 3, 3, 1, 0])?.band).toBe('Lower perceived stress')
    expect(scoreQuestionnaire(PSS10, Array(10).fill(2))?.band).toBe('Moderate perceived stress')
    expect(scoreQuestionnaire(PSS10, [4, 4, 4, 0, 0, 4, 0, 0, 4, 4])?.band).toBe('Higher perceived stress')
  })
  it('refuses incomplete', () => {
    expect(scoreQuestionnaire(PSS10, Array(10).fill(null))).toBeNull()
  })
})

describe('check-in and safety', () => {
  const full = { ...EMPTY_CHECKIN, mood: 3, energy: 3, sleep: 3, stress: 3, selfHarm: 'no' as const }
  it('needs every answer', () => {
    expect(checkInComplete(EMPTY_CHECKIN)).toBe(false)
    expect(checkInComplete(full)).toBe(true)
    expect(checkInComplete({ ...full, selfHarm: null })).toBe(false)
  })
  it('flags a yes answer or crisis wording', () => {
    expect(needsSafetySupport(full)).toBe(false)
    expect(needsSafetySupport({ ...full, selfHarm: 'yes' })).toBe(true)
    expect(needsSafetySupport({ ...full, note: 'I want to die' })).toBe(true)
    expect(needsSafetySupport({ ...full, note: 'Tired from exams' })).toBe(false)
  })
  it('lists emergency resources', () => {
    expect(CRISIS_RESOURCES.map((r) => r.contact)).toContain('112')
  })
})
