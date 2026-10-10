import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { ensureFakeMicWav } from './wav'

/**
 * Engine-independent fake microphone. Replaces navigator.mediaDevices.getUserMedia({audio}) with a
 * MediaStream produced by WebAudio from a decoded WAV (looped), so it needs no browser flags and
 * behaves the same in Chromium and Firefox. Chromium additionally has the native fake-device flags
 * set in playwright.config.ts; call this with `force` only when the scripted path is wanted there.
 * Video requests are passed through to the real implementation untouched.
 */
export async function installFakeMic(page: Page): Promise<void> {
  const wavB64 = readFileSync(ensureFakeMicWav()).toString('base64')
  await page.addInitScript((b64: string) => {
    const md = navigator.mediaDevices
    if (!md) return
    const realGUM = md.getUserMedia?.bind(md)
    md.getUserMedia = async (constraints?: MediaStreamConstraints) => {
      if (!constraints || !constraints.audio) {
        if (!realGUM) throw new DOMException('getUserMedia unavailable', 'NotSupportedError')
        return realGUM(constraints)
      }
      // A per-test clip (window.__fakeMicClip) plays ONCE after a short lead-in so the recorder is
      // already running when the speech starts; with no clip the default tone loops as before.
      const clip = (window as unknown as { __fakeMicClip?: string }).__fakeMicClip
      const bytes = Uint8Array.from(atob(clip ?? b64), (c) => c.charCodeAt(0))
      const ctx = new AudioContext()
      const buf = await ctx.decodeAudioData(bytes.buffer.slice(0))
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.loop = !clip
      const dest = ctx.createMediaStreamDestination()
      src.connect(dest)
      src.start(clip ? ctx.currentTime + 0.6 : 0)
      if (ctx.state === 'suspended') await ctx.resume().catch(() => {})
      ;(window as unknown as { __fakeMicCtx?: AudioContext }).__fakeMicCtx = ctx
      return dest.stream
    }
    ;(window as unknown as { __fakeMicInstalled?: boolean }).__fakeMicInstalled = true
  }, wavB64)
}

/** Makes the NEXT getUserMedia({audio}) play this WAV once (speech clip) instead of the looping tone. */
export async function setFakeMicClip(page: Page, wavPath: string): Promise<number> {
  const buf = readFileSync(wavPath)
  await page.evaluate((b64: string) => {
    ;(window as unknown as { __fakeMicClip?: string }).__fakeMicClip = b64
  }, buf.toString('base64'))
  return (buf.length - 44) / 32000 // seconds, 16 kHz mono 16-bit
}
