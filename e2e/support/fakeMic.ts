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
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const ctx = new AudioContext()
      const buf = await ctx.decodeAudioData(bytes.buffer.slice(0))
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.loop = true
      const dest = ctx.createMediaStreamDestination()
      src.connect(dest)
      src.start()
      if (ctx.state === 'suspended') await ctx.resume().catch(() => {})
      ;(window as unknown as { __fakeMicCtx?: AudioContext }).__fakeMicCtx = ctx
      return dest.stream
    }
    ;(window as unknown as { __fakeMicInstalled?: boolean }).__fakeMicInstalled = true
  }, wavB64)
}
