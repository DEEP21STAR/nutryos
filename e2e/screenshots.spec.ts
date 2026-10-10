import { test as base, expect } from '@playwright/test'
import { test, openToday } from './fixtures'
import { blockRealtime, mockBackend } from './support/mockSupabase'
import { mkdirSync } from 'node:fs'

// Opt-in: SHOTS_DIR=/some/dir npx playwright test e2e/screenshots.spec.ts
const DIR = process.env.SHOTS_DIR
const engine = (name: string) => (name.startsWith('chromium') ? 'chromium' : 'firefox')

test.describe('screenshots 390x844', () => {
  test.skip(!DIR, 'set SHOTS_DIR to capture screenshots')
  test.use({ viewport: { width: 390, height: 844 } })

  test('today top and bottom', async ({ app: page }, info) => {
    mkdirSync(DIR!, { recursive: true })
    const e = engine(info.project.name)
    await openToday(page)
    await page.screenshot({ path: `${DIR}/nutryos_p0_${e}_today_top.png` })
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    await page.waitForTimeout(600)
    await page.screenshot({ path: `${DIR}/nutryos_p0_${e}_today_bottom.png` })
  })
})

base.describe('splash screenshot', () => {
  base.skip(!DIR, 'set SHOTS_DIR to capture screenshots')
  base.use({ viewport: { width: 390, height: 844 } })
  base('greeting splash', async ({ page, context }, info) => {
    mkdirSync(DIR!, { recursive: true })
    await mockBackend(context)
    await blockRealtime(page)
    await page.addInitScript(() => {
      try {
        localStorage.setItem('nutrios.displayName.v1', 'Deep')
      } catch {
        /* ignore */
      }
    })
    await page.goto('./')
    await expect(page.getByTestId('splash-greeting')).toHaveCSS('opacity', '1')
    await page.waitForTimeout(500)
    await page.screenshot({ path: `${DIR}/nutryos_p0_${engine(info.project.name)}_splash.png` })
  })
})
