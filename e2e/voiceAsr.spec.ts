import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect, openToday } from './fixtures'
import { openVoice } from './support/flows'
import { setFakeMicClip } from './support/fakeMic'
import { wer } from '../src/lib/asr/wer'

/**
 * On-device voice acceptance (NUTRYOS Phase 2), through the real UI and the real Web Worker:
 *   - 12 synthetic Piper sentences covering the 15-food list -> fake mic -> Stop -> on-device
 *     transcript -> Send -> confirm screen. Reports WER, app-level outcome, per-clip time.
 *   - model cache: a reload makes ZERO requests for model/runtime files, and still transcribes.
 *   - slow 3G first load (Chromium CDP): progress bar shows and moves, typed fallback still works.
 * Chromium runs Pixel 7 emulation with 6x CPU throttle; Firefox cannot be throttled (stated in report).
 * Synthetic speech is cleaner than a real voice: WER here is optimistic.
 */
const SHOTS = process.env.SHOTS_DIR
const FIX = resolve(process.cwd(), 'e2e/fixtures/voice')
const SENTENCES = JSON.parse(readFileSync(`${FIX}/sentences.json`, 'utf8')) as Array<{ id: string; voice: string; text: string; expect: string[] }>
const CURATED = (JSON.parse(readFileSync(resolve(process.cwd(), 'src/data/curatedFoods.json'), 'utf8')) as { foods: Array<{ id: string; name: string }> }).foods
const nameOf = (id: string) => CURATED.find((f) => f.id === id)!.name
const engine = (name: string) => (name.startsWith('chromium') ? 'chromium' : 'firefox')
// Open Food Facts is the resolution chain's step 3 (food NAME only) for a word the table cannot match; fonts.googleapis.com is the known Phase 6 item.
const ALLOWED_HOST = /^(127\.0\.0\.1:\d+|[a-z0-9]+\.supabase\.co|world\.openfoodfacts\.org|fonts\.googleapis\.com|fonts\.gstatic\.com)$/
const MODEL_FILE = /\/(models\/|assets\/ort-wasm)/

function logRequests(page: Page) {
  const log = { hosts: new Set<string>(), modelRequests: [] as string[] }
  page.on('request', (r) => {
    const u = new URL(r.url())
    if (u.protocol === 'data:' || u.protocol === 'blob:') return
    log.hosts.add(u.host)
    if (MODEL_FILE.test(u.pathname)) log.modelRequests.push(u.pathname)
  })
  return log
}

/** CPU throttle for the page AND for the Web Worker the recogniser runs in (a page-level rate alone
 * does not slow dedicated workers, so the worker target is attached and throttled separately). */
async function throttleCpu(page: Page, rate: number) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate })
  cdp.on('Target.attachedToTarget', async (ev: { sessionId: string; targetInfo: { type: string } }) => {
    if (ev.targetInfo.type !== 'worker') return
    try {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate }, ev.sessionId as never)
    } catch {
      /* worker target without the Emulation domain */
    }
  })
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
  return cdp
}

/** One spoken clip through the UI. Returns the transcript the user would see in the box. */
async function speakClip(page: Page, id: string, shot?: (name: string) => Promise<void>) {
  const seconds = await setFakeMicClip(page, `${FIX}/${id}.wav`)
  await openVoice(page)
  await expect(page.getByText('Listening…')).toBeVisible()
  if (shot) await page.waitForTimeout(1500).then(() => shot('listening'))
  await page.waitForTimeout(Math.max(0, seconds * 1000 + 1200 - (shot ? 1500 : 0))) // 0.6 s lead-in + clip + margin
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  const t0 = Date.now()
  await expect(page.getByTestId('transcribing')).toBeVisible()
  if (shot) await shot('transcribing')
  const box = page.getByRole('textbox')
  await expect(box).toBeVisible({ timeout: 120_000 })
  if (process.env.VOICE_DEBUG) console.log('NOTE', await page.getByTestId('asr-fallback-note').allTextContents())
  const filled = await expect.poll(async () => (await box.inputValue()).trim().length, { timeout: 5_000 }).toBeGreaterThan(0).then(() => true, () => false)
  if (!filled) {
    // Keep the evidence: the recording the page actually captured.
    const b64 = await page.evaluate(async () => {
      const src = document.querySelector('audio')?.getAttribute('src')
      if (!src) return null
      const buf = new Uint8Array(await (await fetch(src)).arrayBuffer())
      let s = ''
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000))
      return btoa(s)
    })
    mkdirSync('test-results/voice', { recursive: true })
    if (b64) writeFileSync(`test-results/voice/failed-${id}.bin`, Buffer.from(b64, 'base64'))
    throw new Error(`empty transcript for ${id}`)
  }
  const wall = Date.now() - t0
  const ms = Number(await page.getByTestId('asr-meta').getAttribute('data-ms'))
  return { transcript: (await box.inputValue()).trim(), workerMs: ms, wallMs: wall, seconds: seconds - 0.7 }
}

test('12 spoken sentences: WER, app-level outcome, timing, hosts', async ({ app: page }, info) => {
  test.setTimeout(20 * 60_000)
  const eng = engine(info.project.name)
  const log = logRequests(page)
  if (eng === 'chromium') await throttleCpu(page, 6)
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true })
    await page.setViewportSize({ width: 390, height: 844 }) // screenshots at the standard 390x844
  }
  await openToday(page)

  const rows: Array<Record<string, unknown>> = []
  let expectedItems = 0
  let correctItems = 0
  let werSum = 0
  const fallbackStrings: string[] = []

  for (const [i, s] of SENTENCES.entries()) {
    if (process.env.CLIPS && !process.env.CLIPS.split(',').includes(s.id)) continue
    const shot = i === 0 && SHOTS ? async (name: string) => { await page.screenshot({ path: `${SHOTS}/nutryos_p2_${eng}_${name}.png` }) } : undefined
    const r = await speakClip(page, s.id, shot)
    const w = wer(s.text, r.transcript)
    werSum += w
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Confirm meal' })).toBeVisible({ timeout: 20_000 })

    const names = await page.locator('input[placeholder="Food name"]').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value))
    const badges = await page.getByTestId('source-badge').allTextContents()
    const resolved = names.filter((_, k) => !/Needs numbers/.test(badges[k] ?? ''))
    const want = s.expect.map(nameOf)
    const pool = [...resolved]
    let ok = 0
    for (const n of want) {
      const k = pool.indexOf(n)
      if (k >= 0) { ok++; pool.splice(k, 1) }
    }
    expectedItems += want.length
    correctItems += ok
    if (i === 0 && SHOTS) {
      await page.evaluate(() => window.scrollTo(0, 0))
      await page.waitForTimeout(500)
      await page.screenshot({ path: `${SHOTS}/nutryos_p2_${eng}_confirm.png` })
    }
    if (await page.getByText(/couldn't transcribe automatically/i).count()) fallbackStrings.push(s.id)
    rows.push({ id: s.id, voice: s.voice, wer: Number((w * 100).toFixed(1)), workerMs: r.workerMs, wallMs: r.wallMs, clipSec: Number(r.seconds.toFixed(1)), items: `${ok}/${want.length}`, ref: s.text, got: r.transcript, resolvedNames: names })
    await page.getByRole('button', { name: 'Cancel' }).first().click()
    await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible()
    await page.waitForTimeout(300)
  }

  const meanWer = (werSum / SENTENCES.length) * 100
  const outcome = (correctItems / expectedItems) * 100
  const times = rows.map((r) => r.workerMs as number)
  const summary = {
    engine: eng, cpuThrottle: eng === 'chromium' ? '6x (CDP)' : 'none (Firefox cannot be throttled)',
    meanWerPct: Number(meanWer.toFixed(1)), maxWerPct: Math.max(...rows.map((r) => r.wer as number)),
    outcomePct: Number(outcome.toFixed(1)), correctItems, expectedItems,
    workerMsMean: Math.round(times.reduce((a, b) => a + b, 0) / times.length), workerMsMax: Math.max(...times),
    hosts: [...log.hosts], modelRequests: log.modelRequests.length, rows,
  }
  mkdirSync('test-results/voice', { recursive: true })
  writeFileSync(`test-results/voice/wer-${eng}.json`, JSON.stringify(summary, null, 2))
  console.log(`VOICE ${eng} meanWER=${summary.meanWerPct}% max=${summary.maxWerPct}% outcome=${summary.outcomePct}% (${correctItems}/${expectedItems}) workerMs mean=${summary.workerMsMean} max=${summary.workerMsMax} hosts=${[...log.hosts].join(',')}`)
  for (const r of rows) console.log(`  ${r.id} WER ${r.wer}% ${r.workerMs}ms/${r.clipSec}s items ${r.items} | ${r.got}`)

  expect(meanWer).toBeLessThanOrEqual(15)
  expect(outcome).toBeGreaterThanOrEqual(90)
  expect(fallbackStrings).toEqual([])
  expect([...log.hosts].filter((h) => !ALLOWED_HOST.test(h))).toEqual([]) // no third party on the voice path
})

test.beforeEach(({ app: page }) => { if (process.env.VOICE_DEBUG) page.on('console', (m) => console.log('PAGE', m.type(), m.text().slice(0, 300))) })
test('second load: zero requests for model files, and it still transcribes (cache works offline)', async ({ app: page }, info) => {
  test.setTimeout(10 * 60_000)
  const eng = engine(info.project.name)
  if (eng === 'chromium') await throttleCpu(page, 6)
  const first = logRequests(page)
  await openToday(page)
  const a = await speakClip(page, 's07')
  expect(first.modelRequests.length).toBeGreaterThan(0) // the first use really downloaded them
  expect(a.transcript.toLowerCase()).toContain('sourdough')

  // Reload: new JS context, new worker. Anything under /models/ or the ORT wasm is now refused,
  // so a passing run proves the files came from the cache, and the request log proves none were asked for.
  await page.reload()
  const second = logRequests(page)
  await page.route(/\/(models\/|assets\/ort-wasm)/, (route) => route.abort('internetdisconnected'))
  await openToday(page)
  const b = await speakClip(page, 's07')
  console.log(`CACHE ${eng}: first-run model requests=${first.modelRequests.length}, second-run model requests=${second.modelRequests.length}, second transcript="${b.transcript}" workerMs=${b.workerMs}`)
  expect(second.modelRequests).toEqual([])
  expect(b.transcript.toLowerCase()).toContain('sourdough')
})

test('slow 3G first load: progress shows and moves, typing still works while it downloads', async ({ app: page }, info) => {
  test.skip(engine(info.project.name) !== 'chromium', 'CDP network throttling is Chromium-only; Firefox is out of scope for throttling')
  test.setTimeout(3 * 60_000)
  const cdp = await page.context().newCDPSession(page)
  await openToday(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 400, downloadThroughput: (400 * 1024) / 8, uploadThroughput: (400 * 1024) / 8 })
  const t0 = Date.now()
  await setFakeMicClip(page, `${FIX}/s07.wav`)
  await openVoice(page)
  const bar = page.getByTestId('asr-progress')
  await expect(bar).toBeVisible({ timeout: 30_000 })
  const samples: Array<{ s: number; pct: number }> = []
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(4000)
    const pct = Number((await bar.getAttribute('data-pct')) ?? '-1')
    samples.push({ s: Math.round((Date.now() - t0) / 1000), pct })
    if (SHOTS && i === 2) await page.screenshot({ path: `${SHOTS}/nutryos_p2_chromium_slow3g_progress.png` })
  }
  console.log('SLOW3G progress samples', JSON.stringify(samples))
  const pcts = samples.map((x) => x.pct)
  expect(pcts[pcts.length - 1]).toBeGreaterThan(pcts[0]) // it moves
  expect(pcts[pcts.length - 1]).toBeLessThan(100) // and is genuinely throttled (not instant)
  await expect(page.getByText(/first time only/)).toBeVisible()

  // The download does not trap the user: Stop -> "Type it instead" -> Send works with the model still loading.
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(page.getByTestId('transcribing')).toBeVisible()
  await page.getByRole('button', { name: 'Type it instead' }).click()
  await page.getByRole('textbox').fill('a banana')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Confirm meal' })).toBeVisible({ timeout: 20_000 })
  const rate = (pcts[pcts.length - 1] - pcts[0]) / (samples[samples.length - 1].s - samples[0].s) // pct per second
  console.log(`SLOW3G rate ~${rate.toFixed(2)} %/s => full download ~${Math.round(100 / Math.max(rate, 0.01) / 60)} min`)
})
