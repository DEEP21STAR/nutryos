import { test, expect, openToday } from './fixtures'

test('app boots and reports speech/barcode API availability', async ({ app: page, browserName }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openToday(page)

  const caps = await page.evaluate(() => ({
    speechRecognition: typeof (window as any).SpeechRecognition !== 'undefined',
    webkitSpeechRecognition: typeof (window as any).webkitSpeechRecognition !== 'undefined',
    barcodeDetector: typeof (window as any).BarcodeDetector !== 'undefined',
    getUserMedia: typeof navigator.mediaDevices?.getUserMedia === 'function',
  }))
  const line = `[caps:${browserName}] ${JSON.stringify(caps)}`
  console.log(line)
  testInfo.annotations.push({ type: 'capabilities', description: JSON.stringify(caps) })
  for (const v of Object.values(caps)) expect(typeof v).toBe('boolean')
  expect(errors).toEqual([])
})

test('fake microphone yields a live, non-silent audio stream', async ({ app: page }) => {
  await openToday(page)
  const rms = await page.evaluate(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const track = stream.getAudioTracks()[0]
    if (!track || track.readyState !== 'live') return -1
    const ctx = new AudioContext()
    await ctx.resume().catch(() => {})
    const an = ctx.createAnalyser()
    ctx.createMediaStreamSource(stream).connect(an)
    const buf = new Float32Array(an.fftSize)
    let best = 0
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 50))
      an.getFloatTimeDomainData(buf)
      const r = Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length)
      if (r > best) best = r
    }
    return best
  })
  expect(rms).toBeGreaterThan(0.01)
})
