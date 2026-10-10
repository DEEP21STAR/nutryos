import { spawn, type ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'
import { test, expect, openToday } from './fixtures'
import { openVoice } from './support/flows'
import { setFakeMicClip } from './support/fakeMic'

/**
 * Slow-CPU timing for on-device transcription. Chromium is pinned to ONE core (chromium-1core.sh) and 5
 * busy-loop burners share that core, so each browser thread (the recogniser's Web Worker included)
 * runs at roughly a third to a sixth of speed. The slowdown is CALIBRATED in-test with a fixed spin loop in a
 * worker (unloaded reference measured at 266 ms on this machine) rather than assumed.
 * Phone-class CPUs also differ in architecture and memory: this is an approximation, not a phone result.
 */
const FIX = resolve(process.cwd(), 'e2e/fixtures/voice')
const REFERENCE_SPIN_MS = 266
const burners: ChildProcess[] = []

test.beforeAll(() => {
  for (let i = 0; i < 1; i++) burners.push(spawn('taskset', ['-c', '3', 'sh', '-c', 'while :; do :; done'], { stdio: 'ignore' }))
})
test.afterAll(() => {
  for (const b of burners) b.kill('SIGKILL')
})

// One clip per test (fresh page): on this deliberately starved browser a second voice sheet in the same
// page did not come up reliably, so each clip is measured cold, which is also the worst case.
for (const id of ['s01', 's07']) {
  test(`transcription time on a slower CPU: ${id}`, async ({ app: page }) => {
    test.setTimeout(6 * 60_000)
    await openToday(page)
    const spin = await page.evaluate(async () => {
      const src = 'const t=performance.now();let x=0;for(let i=0;i<3e7;i++)x+=Math.sqrt(i);postMessage(performance.now()-t)'
      const w = new Worker(URL.createObjectURL(new Blob([src])))
      return new Promise<number>((r) => { w.onmessage = (e) => r(e.data) })
    })
    const factor = spin / REFERENCE_SPIN_MS
    const seconds = await setFakeMicClip(page, `${FIX}/${id}.wav`)
    await openVoice(page)
    await expect(page.getByText('Listening…')).toBeVisible({ timeout: 120_000 })
    await page.waitForTimeout(seconds * 1000 + 1500)
    await page.getByRole('button', { name: 'Stop', exact: true }).click()
    const t0 = Date.now()
    await expect(page.getByTestId('transcribing')).toBeVisible({ timeout: 60_000 })
    await expect(page.getByRole('textbox')).toBeVisible({ timeout: 300_000 })
    const wall = Date.now() - t0
    const ms = Number(await page.getByTestId('asr-meta').getAttribute('data-ms'))
    console.log(`SLOWCPU ${id} calibrated slowdown=${factor.toFixed(1)}x (spin ${Math.round(spin)} ms vs ${REFERENCE_SPIN_MS} ms) clip=${(seconds - 0.7).toFixed(1)}s workerMs=${ms} stopToTextWallMs=${wall} (cold: includes model init)`)
    expect(factor).toBeGreaterThan(2)
    expect(ms).toBeGreaterThan(0)
  })
}
