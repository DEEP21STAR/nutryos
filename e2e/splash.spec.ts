import { test as base, expect } from '@playwright/test'
import { blockRealtime, mockBackend } from './support/mockSupabase'

const test = base.extend({})

test.beforeEach(async ({ page, context }) => {
  await mockBackend(context)
  await blockRealtime(page)
})

test('greeting splash shows the greeting and has no progress dashes', async ({ page }) => {
  // First run (no intro-seen flag) is the case where the dashes used to appear under the greeting.
  await page.addInitScript(() => {
    try {
      localStorage.clear()
    } catch {
      /* ignore */
    }
  })
  await page.goto('./')
  const greeting = page.getByTestId('splash-greeting')
  await expect(greeting).toBeVisible()
  await expect(greeting).toContainText(/Good (Morning|Afternoon|Evening)/)
  await expect(page.getByTestId('splash-progress-dash')).toHaveCount(0)
  // Still zero a moment later while the greeting is held.
  await page.waitForTimeout(800)
  await expect(greeting).toHaveCSS('opacity', '1')
  await expect(page.getByTestId('splash-progress-dash')).toHaveCount(0)
})

test('category tour (first run) still shows its six progress dashes after the greeting', async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.clear()
    } catch {
      /* ignore */
    }
  })
  await page.goto('./')
  await expect(page.getByTestId('splash-progress-dash')).toHaveCount(6, { timeout: 8000 })
})
