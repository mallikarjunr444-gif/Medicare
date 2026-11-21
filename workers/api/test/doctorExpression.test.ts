import { describe, expect, it } from 'vitest'
import { expressionFor, EXPRESSION_POSE } from '../../../frontend/lib/doctorExpression'
import { PortraitWarp } from '../../../frontend/lib/portraitWarp'
import { DOCTOR_FACE_DATA } from '../../../frontend/lib/doctorFaceData'

describe('doctor expression', () => {
  it('is warm while listening or speaking, neutral otherwise', () => {
    expect(expressionFor(undefined, 'listening')).toBe('warm')
    expect(expressionFor('hello', 'speaking')).toBe('warm')
    expect(expressionFor('hello', 'thinking')).toBe('neutral')
    expect(expressionFor('hello', 'disconnected')).toBe('neutral')
  })
  it('looks concerned for distress in English, Hindi and Kannada', () => {
    for (const t of ['I have severe chest pain', 'मुझे बहुत दर्द है', 'ನನಗೆ ತುಂಬಾ ಭಯ ಆಗುತ್ತಿದೆ', 'I feel very anxious']) expect(expressionFor(t, 'listening')).toBe('concerned')
    expect(expressionFor('I have a mild cold', 'listening')).toBe('warm')
  })
  it('concern lowers the smile and lifts the brows', () => {
    expect(EXPRESSION_POSE.concerned.smile).toBeLessThan(0)
    expect(EXPRESSION_POSE.concerned.brow).toBeGreaterThan(EXPRESSION_POSE.neutral.brow)
  })
})

describe('portrait smile', () => {
  it('raises the lip corners and leaves the lip centre in place', () => {
    const warp = new PortraitWarp(DOCTOR_FACE_DATA.dr_ananya) as unknown as {
      a: { mouth: { cx: number; cy: number; w: number } }
      displace(x: number, y: number, z: string, pose: object, openPx: number): [number, number]
    }
    const { cx, cy, w } = warp.a.mouth
    const flat = { blink: 0, open: 0, wide: 1, brow: 0 }
    const smile = { ...flat, smile: 1 }
    const corner = warp.displace(cx + w * 0.8, cy, 'mouth', smile, 0)
    const cornerFlat = warp.displace(cx + w * 0.8, cy, 'mouth', flat, 0)
    expect(corner[1]).toBeLessThan(cornerFlat[1])
    const mid = warp.displace(cx, cy, 'mouth', smile, 0)
    expect(Math.abs(mid[1] - cy)).toBeLessThan(0.5)
    const frown = warp.displace(cx + w * 0.8, cy, 'mouth', { ...flat, smile: -0.5 }, 0)
    expect(frown[1]).toBeGreaterThan(cornerFlat[1])
  })
})
