import { mkdirSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { test, expect, openToday } from './fixtures'

/**
 * NUTRYOS Phase 1 "never a silent 0", through the real text-capture UI in both engines.
 * The text->items parse is the identify-food edge function, mocked here (Supabase is mocked by the
 * fixture); the food NUMBERS come from the real resolution chain in the built app (curated table;
 * Open Food Facts is unreachable because the fixture blocks third-party origins; cloud AI is off).
 * Screenshots: SHOTS_DIR=/some/dir (opt-in, same convention as screenshots.spec.ts).
 */
const SHOTS = process.env.SHOTS_DIR
const engine = (name: string) => (name.startsWith('chromium') ? 'chromium' : 'firefox')
const GRAMS: Record<string, number> = { 'whey protein powder': 30, milk: 250, banana: 120 }

async function logByText(page: Page, text: string): Promise<{ estimateCalls: number }> {
  const seen = { estimateCalls: 0 }
  // The voice/text path tries Ollama on localhost first: keep it out so the mocked parse is used.
  await page.route(/^https?:\/\/(localhost|127\.0\.0\.1):11434\//, (r) => r.abort())
  await page.route(/\.supabase\.co\/functions\/v1\/identify-food/, async (route) => {
    if (route.request().method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } })
    }
    const body = route.request().postDataJSON() as { conversation?: Array<{ content: string }>; estimate?: unknown }
    if (body.estimate) seen.estimateCalls++
    const said = body.conversation?.at(-1)?.content ?? ''
    const items = said
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((name) => ({ name, estimated_grams: GRAMS[name] ?? 100 }))
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ type: 'items', items }),
    })
  })

  await openToday(page)
  // The orb pulses forever (GSAP), so it never counts as "stable" for Playwright's actionability check.
  await page.locator('[data-tour="orb"] button').click({ force: true })
  await page.getByRole('button', { name: 'Voice', exact: true }).click()
  await page.getByRole('button', { name: /type (it )?instead/i }).click()
  await page.getByRole('textbox').fill(text)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Confirm meal' })).toBeVisible({ timeout: 20_000 })
  return seen
}

test('typed "whey protein powder, milk, banana" resolves all three with source badges', async ({ app: page }, info) => {
  const seen = await logByText(page, 'whey protein powder, milk, banana')

  const badges = page.getByTestId('source-badge')
  await expect(badges).toHaveCount(3)
  for (const text of await badges.allTextContents()) expect(text).toMatch(/^NZ\/AU food table · (high|medium)$/)
  await expect(page.getByTestId('needs-numbers')).toHaveCount(0)

  const kcal = await page.getByLabel('Kcal').evaluateAll((els) => els.map((e) => Number((e as HTMLInputElement).value)))
  expect(kcal).toHaveLength(3)
  for (const v of kcal) expect(v).toBeGreaterThan(0)
  expect(kcal[0]).toBeGreaterThanOrEqual(100) // whey, 30 g
  expect(kcal[0]).toBeLessThanOrEqual(140)

  await expect(page.getByRole('button', { name: 'Log this meal' })).toBeEnabled()
  expect(seen.estimateCalls).toBe(0)

  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true })
    await page.getByTestId('source-badge').first().evaluate((el) => el.closest('.glass-card')?.scrollIntoView({ block: 'center' }))
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${SHOTS}/nutryos_p1_${engine(info.project.name)}_confirm.png` })
  }
})

test('an unknown food shows "Needs numbers" and blocks logging until the user decides', async ({ app: page }, info) => {
  const seen = await logByText(page, 'zorbleflax')

  await expect(page.getByTestId('needs-numbers')).toHaveCount(1)
  await expect(page.getByTestId('source-badge')).toHaveText('Needs numbers')
  const log = page.getByRole('button', { name: 'Log this meal' })
  await expect(log).toBeDisabled()
  await expect(page.getByTestId('log-blocked-reason')).toHaveText(/1 item needs numbers/)
  expect(seen.estimateCalls).toBe(0) // private by default: no AI call without opt-in

  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true })
    await page.getByTestId('needs-numbers').scrollIntoViewIfNeeded()
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${SHOTS}/nutryos_p1_${engine(info.project.name)}_needs_numbers.png` })
  }

  // Explicit escape hatch: "Log with 0 for this item" -> confirm dialog -> enabled.
  await page.getByRole('button', { name: 'Log with 0 for this item' }).click()
  await expect(page.getByRole('alertdialog')).toBeVisible()
  await page.getByRole('button', { name: 'Log with 0', exact: true }).click()
  await expect(log).toBeEnabled()
})
