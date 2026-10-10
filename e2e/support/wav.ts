import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export const FAKE_MIC_PATH = resolve(process.cwd(), 'test-results/fixtures/fake-mic.wav')

/** 16-bit mono PCM WAV: a 2 s two-tone chirp-ish signal (440 Hz + 660 Hz), clearly non-silent. */
export function makeToneWav(seconds = 2, rate = 16000): Buffer {
  const n = seconds * rate
  const data = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) {
    const t = i / rate
    const v = 0.35 * Math.sin(2 * Math.PI * 440 * t) + 0.25 * Math.sin(2 * Math.PI * 660 * t)
    data.writeInt16LE(Math.round(v * 32767), i * 2)
  }
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + data.length, 4)
  h.write('WAVEfmt ', 8)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}

export function ensureFakeMicWav(): string {
  if (!existsSync(FAKE_MIC_PATH)) {
    mkdirSync(dirname(FAKE_MIC_PATH), { recursive: true })
    writeFileSync(FAKE_MIC_PATH, makeToneWav())
  }
  return FAKE_MIC_PATH
}
