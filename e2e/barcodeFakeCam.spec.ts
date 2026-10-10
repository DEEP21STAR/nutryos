import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, devices, expect, test } from '@playwright/test'
import { blockRealtime, mockBackend } from './support/mockSupabase'
import { FIXTURES, fixturePath, lookupCode, mockOff, okProduct } from './support/barcode'

/**
 * Live-camera path, Chromium only: Chromium's own fake video capture plays each sample photo as a
 * camera feed (--use-file-for-fake-video-capture with an Y4M made by ffmpeg), so getUserMedia,
 * <video>, the frame loop and the decoder all run for real. One browser launch per image because
 * the flag is per browser. The app itself is unmodified (no camera stub in the page).
 */
const dir = mkdtempSync(join(tmpdir(), 'nutryos-fakecam-'))

function toY4m(png: string, name: string): string {
  const out = join(dir, `${name}.y4m`)
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-loop', '1', '-i', png, '-t', '2', '-r', '5', '-vf', 'scale=800:600', '-pix_fmt', 'yuv420p', '-f', 'yuv4mpegpipe', out])
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`)
  return out
}

test.describe('fake camera (Chromium)', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium fake-capture flags only')
  test.skip(() => spawnSync('ffmpeg', ['-version']).status !== 0, 'ffmpeg not installed (needed to make the fake camera feed)')
  test.setTimeout(90_000)

  for (const f of FIXTURES) {
    test(`${f.file}`, async () => {
      const video = toY4m(fixturePath(f), f.file.replace(/\.png$/, ''))
      const browser = await chromium.launch({
        args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`],
      })
      try {
        const context = await browser.newContext({ ...devices['Pixel 7'], serviceWorkers: 'block', permissions: ['camera'] })
        await mockBackend(context)
        const code = lookupCode(f)
        const off = await mockOff(context, { [code]: okProduct(code) })
        const page = await context.newPage()
        await blockRealtime(page)
        await page.addInitScript(() => {
          localStorage.setItem('nutryos:tour-seen:v1', '1')
          localStorage.setItem('nutrios.introSeen.v1', '1')
        })
        const base = 'http://127.0.0.1:4173/nutryos/'
        await page.goto(base)
        await page.getByRole('button', { name: 'Skip' }).click()
        await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible()
        await page.waitForTimeout(700)
        await page.locator('[data-tour="orb"] button').click({ force: true })
        await page.getByRole('button', { name: 'Scan barcode', exact: true }).click()
        // No tap, no photo: the live frames alone must produce the lookup.
        await expect(page.getByRole('heading', { name: 'Confirm meal' })).toBeVisible({ timeout: 40_000 })
        expect(off.requested).toEqual([code])
      } finally {
        await browser.close()
      }
    })
  }
})
