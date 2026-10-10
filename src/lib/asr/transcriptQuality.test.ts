import { describe, expect, it } from 'vitest'
import { assessTranscript, audioRms, cleanTranscript } from '@/lib/asr/transcriptQuality'

describe('assessTranscript', () => {
  it('accepts a normal sentence', () => expect(assessTranscript('Two eggs and a flat white.', 3, 0.05).ok).toBe(true))
  it('rejects empty on a silent clip as silence', () => expect(assessTranscript('', 3, 0.001)).toEqual({ ok: false, reason: 'silence' }))
  it('rejects empty on a loud clip as empty', () => expect(assessTranscript('  ', 3, 0.1)).toEqual({ ok: false, reason: 'empty' }))
  it('strips non-speech tags', () => {
    expect(cleanTranscript('[BLANK_AUDIO] (silence)')).toBe('')
    expect(assessTranscript('[BLANK_AUDIO]', 2, 0.1).ok).toBe(false)
  })
  it('rejects a one-word result on a long clip', () => expect(assessTranscript('Okay.', 6, 0.1).reason).toBe('too-short'))
  it('rejects hallucinated repetition', () => expect(assessTranscript('the the the the the the the the', 6, 0.1).reason).toBe('repetition'))
  it('rejects punctuation-only', () => expect(assessTranscript('...', 2, 0.1).ok).toBe(false))
  it('rms of silence is 0', () => expect(audioRms(new Float32Array(100))).toBe(0))
})

import { trimSilence } from '@/lib/asr/transcriptQuality'
describe('trimSilence', () => {
  const tone = (sec: number, amp = 0.3) => Float32Array.from({ length: sec * 16000 }, (_, i) => amp * Math.sin(i / 7))
  const silence = (sec: number) => new Float32Array(sec * 16000)
  const cat = (...p: Float32Array[]) => { const o = new Float32Array(p.reduce((a, b) => a + b.length, 0)); let k = 0; for (const x of p) { o.set(x, k); k += x.length } return o }
  it('cuts long leading and trailing silence but keeps a margin', () => {
    const out = trimSilence(cat(silence(3), tone(2), silence(2)))
    expect(out.length / 16000).toBeGreaterThan(2.4)
    expect(out.length / 16000).toBeLessThan(2.9)
  })
  it('leaves a clip with no quiet edges alone (length within one frame)', () => {
    const a = tone(2)
    expect(Math.abs(trimSilence(a).length - a.length)).toBeLessThan(400)
  })
  it('returns all-silence unchanged', () => expect(trimSilence(silence(3)).length).toBe(48000))
  it('survives very short input', () => expect(trimSilence(new Float32Array(10)).length).toBe(10))
})
