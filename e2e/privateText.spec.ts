import { mkdirSync } from 'node:fs'
import { test, expect } from './fixtures'
import { openTypeIt, typeAndSend } from './support/flows'
import type { Page } from '@playwright/test'

/**
 * Private text path, NOTHING on the parse path mocked: the identify-food edge function and every
 * non-local host are refused, so any attempt to reach them is counted. Both engines.
 */
const SHOTS = process.env.SHOTS_DIR
const engine = (name: string) => (name.startsWith('chromium') ? 'chromium' : 'firefox')

function watch(page: Page) {
  const seen = { functionCalls: 0, hosts: new Set<string>(), localhostOllama: 0 }
  page.on('request', (r) => {
    const u = new URL(r.url())
    if (u.protocol === 'data:' || u.protocol === 'blob:') return
    seen.hosts.add(u.host)
    if (/\/functions\/v1\//.test(u.pathname)) seen.functionCalls++
    if (u.port === '11434' || u.hostname === 'localhost') seen.localhostOllama++
  })
  return seen
}

test('"Type it" is a visible entry in the capture sheet', async ({ app: page }) => {
  await openTypeIt(page)
  await expect(page.getByRole('textbox')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible()
})

test('zorbleflax ends at "Needs numbers" with a working manual path, no AI chat, no network', async ({ app: page }, info) => {
  const seen = watch(page)
  await typeAndSend(page, 'zorbleflax')

  await expect(page.getByTestId('needs-numbers')).toHaveCount(1)
  await expect(page.getByTestId('source-badge')).toHaveText('Needs numbers')
  const log = page.getByRole('button', { name: 'Log this meal' })
  await expect(log).toBeDisabled()
  // Manual entry works: type kcal and the item becomes loggable.
  await page.getByLabel('Kcal', { exact: true }).fill('150')
  await expect(log).toBeEnabled()
  await expect(page.getByTestId('needs-numbers')).toHaveCount(0)

  expect(seen.functionCalls).toBe(0) // no Supabase/Gemini parse
  expect(seen.localhostOllama).toBe(0) // no localhost / Ollama probe
  // Allowed: the app itself, Supabase (auth/data, never the parse), Open Food Facts (resolution step 3,
  // sends only the food name). fonts.googleapis.com is the known Phase 6 self-hosting item (addendum 9).
  const allowed = /^(127\.0\.0\.1:\d+|[a-z0-9]+\.supabase\.co|world\.openfoodfacts\.org|fonts\.googleapis\.com|fonts\.gstatic\.com)$/
  expect([...seen.hosts].filter((h) => !allowed.test(h))).toEqual([])
  expect([...seen.hosts].filter((h) => /generativelanguage|googleapis\.com$/.test(h) && !/^fonts\./.test(h))).toEqual([]) // no Gemini

  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true })
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${SHOTS}/nutryos_p2_${engine(info.project.name)}_zorbleflax_manual.png` })
  }
})

test('zorbleflax: the "Log with 0 for this item" escape hatch is enabled', async ({ app: page }) => {
  await typeAndSend(page, 'zorbleflax')
  const zero = page.getByRole('button', { name: 'Log with 0 for this item' })
  await expect(zero).toBeEnabled()
  await zero.click()
  await page.getByRole('button', { name: 'Log with 0', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Log this meal' })).toBeEnabled()
})

test('the example sentence parses to four items with table grams, offline of any AI', async ({ app: page }) => {
  const seen = watch(page)
  await typeAndSend(page, 'two scrambled eggs, a flat white and 30 grams of whey protein powder, half a banana')
  const names = await page.locator('input[placeholder="Food name"]').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value))
  expect(names).toHaveLength(4)
  const grams = await page.getByTestId('portion-input').evaluateAll((els) => els.map((e) => Number((e as HTMLInputElement).value)))
  expect(grams).toEqual([120, 220, 30, 60])
  await expect(page.getByTestId('needs-numbers')).toHaveCount(0)
  expect(seen.functionCalls).toBe(0)
  expect(seen.localhostOllama).toBe(0)
})

test('text the parser cannot read stays in the box with a note (no chat) and "Add by hand"', async ({ app: page }) => {
  const seen = watch(page)
  await openTypeIt(page)
  await page.getByRole('textbox').fill('um okay so')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByTestId('parse-note')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Add by hand' })).toBeEnabled()
  expect(seen.functionCalls).toBe(0)
})
