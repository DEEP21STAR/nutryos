/** Heuristics for "is this on-device transcript trustworthy enough to skip the review step's attention?" */

export interface TranscriptAssessment {
  ok: boolean
  reason?: 'empty' | 'silence' | 'too-short' | 'repetition' | 'no-letters'
}

export function audioRms(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / samples.length)
}

/** Strips bracketed non-speech tags some models emit ("[BLANK_AUDIO]", "(silence)"). */
export function cleanTranscript(text: string): string {
  return text.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()
}

export function assessTranscript(text: string, seconds: number, rms: number): TranscriptAssessment {
  const t = cleanTranscript(text)
  if (!t) return { ok: false, reason: rms < 0.004 ? 'silence' : 'empty' }
  if (!/[a-z]{2}/i.test(t)) return { ok: false, reason: 'no-letters' }
  const words = t.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean)
  if (seconds >= 3 && words.length < 2) return { ok: false, reason: 'too-short' }
  if (words.length >= 6) {
    const distinct = new Set(words).size
    if (distinct / words.length < 0.34) return { ok: false, reason: 'repetition' }
  }
  return { ok: true }
}

/**
 * Trims leading/trailing quiet from 16 kHz mono audio before it reaches the model. Measured finding
 * (2026-10-10): Moonshine-tiny returns an EMPTY transcript when a clip has roughly 1.5 s+ of leading
 * silence, which is a normal thing for a person to do after tapping the mic. Keeps 0.25 s before the
 * first speech and 0.35 s after the last. Threshold adapts to the clip's own noise floor.
 */
export function trimSilence(audio: Float32Array, sampleRate = 16000): Float32Array {
  const frame = Math.round(sampleRate * 0.02)
  const n = Math.floor(audio.length / frame)
  if (n < 4) return audio
  const rms: number[] = []
  for (let i = 0; i < n; i++) rms.push(audioRms(audio.subarray(i * frame, (i + 1) * frame)))
  const sorted = [...rms].sort((a, b) => a - b)
  const floor = sorted[Math.floor(n * 0.1)]
  const peak = sorted[n - 1]
  const threshold = Math.max(0.01, floor * 3, peak * 0.08)
  let first = rms.findIndex((v) => v > threshold)
  if (first < 0) return audio // nothing above threshold: leave it to the silence check
  let last = n - 1
  while (last > first && rms[last] <= threshold) last--
  first = Math.max(0, first - Math.round(0.25 / 0.02))
  last = Math.min(n - 1, last + Math.round(0.35 / 0.02))
  return audio.slice(first * frame, (last + 1) * frame)
}
