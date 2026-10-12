import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Page, Route } from '@playwright/test'
import { expect } from '@playwright/test'
import { openToday } from '../fixtures'

/**
 * Phase 4 capture-sheet helpers. Everything the real photo path would get from Gemini comes from
 * e2e/fixtures/meals/responses.json, which is SIMULATED (hand-written to the new schema, not recorded):
 * the Phase 4 edge function is not deployed, so the real model path cannot be exercised here.
 */
export const MEALS_DIR = resolve(process.cwd(), 'e2e/fixtures/meals')
export const photoPath = (file: string) => `${MEALS_DIR}/${file}`

interface Fixture {
  photos: Record<string, { known: string[]; response: unknown }>
  scenarios: Record<string, { known: string[]; response: unknown }>
  fixCloud: { request: string; response: unknown }
}
export const FIXTURE = JSON.parse(readFileSync(`${MEALS_DIR}/responses.json`, 'utf8')) as Fixture

const CORS = { 'access-control-allow-origin': '*' }

export interface ServiceLog {
  /** JSON bodies the app sent to the identify-food edge function, in order. */
  bodies: Array<Record<string, unknown>>
  /** Every request URL that went to generativelanguage.googleapis.com (must stay empty: the key lives server-side). */
  directGoogle: string[]
}

/** Answers identify-food from the simulated fixtures. `fix` = answer for the cloud fix mode (default: 400 like the old deployed function). */
export async function mockPlateService(
  page: Page,
  pick: (body: Record<string, unknown>) => unknown,
  opts: { fix?: 'fixture' | 'old-function' } = {},
): Promise<ServiceLog> {
  const log: ServiceLog = { bodies: [], directGoogle: [] }
  page.on('request', (r) => {
    if (/generativelanguage\.googleapis\.com/.test(r.url())) log.directGoogle.push(r.url())
  })
  await page.route(/\/functions\/v1\/identify-food/, async (route: Route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fallback()
    const body = req.postDataJSON() as Record<string, unknown>
    log.bodies.push(body)
    if (body.fix) {
      if (opts.fix === 'fixture') return route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(FIXTURE.fixCloud.response) })
      // The function deployed before Phase 4 has no fix mode: it falls through to its photo path and answers 400.
      return route.fulfill({ status: 400, contentType: 'application/json', headers: CORS, body: JSON.stringify({ error: 'imageBase64 and mimeType are required' }) })
    }
    return route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(pick(body)) })
  })
  return log
}

export const photoResponse = (file: string) => () => FIXTURE.photos[file].response
export const scenarioResponse = (name: string) => () => FIXTURE.scenarios[name].response

/** Echoes inserted meals back (the base UI mock returns an empty object) and records what was saved. */
export async function mockMealSave(page: Page): Promise<Array<Record<string, unknown>>> {
  const saved: Array<Record<string, unknown>> = []
  await page.route(/\/rest\/v1\/meals/, async (route: Route) => {
    const req = route.request()
    if (req.method() !== 'POST') return route.fallback()
    const row = req.postDataJSON() as Record<string, unknown>
    saved.push(row)
    return route.fulfill({
      status: 201,
      contentType: 'application/json',
      headers: CORS,
      body: JSON.stringify({ id: crypto.randomUUID(), logged_at: new Date().toISOString(), ...row, photo_url: null }),
    })
  })
  return saved
}

/** Counts every real user tap (trusted pointerdown) from the moment it is reset. */
export async function installTapCounter(page: Page): Promise<void> {
  await page.addInitScript(() => {
    ;(window as unknown as { __taps: number }).__taps = 0
    document.addEventListener('pointerdown', (e) => {
      if (e.isTrusted) (window as unknown as { __taps: number }).__taps++
    }, true)
  })
}
export const resetTaps = (page: Page) => page.evaluate(() => { (window as unknown as { __taps: number }).__taps = 0 })
export const readTaps = (page: Page) => page.evaluate(() => (window as unknown as { __taps: number }).__taps)

export async function openSheet(page: Page): Promise<void> {
  await page.locator('[data-tour="orb"] button').click({ force: true })
  await expect(page.getByTestId('capture-sheet')).toBeVisible()
}

/** Today, then the orb: the home screen -> capture sheet (1 tap). */
export async function homeToSheet(page: Page, opts: { countTaps?: boolean } = {}): Promise<void> {
  await openToday(page)
  if (opts.countTaps) await resetTaps(page)
  await openSheet(page)
}

/** Taps a button that opens the file picker and hands it the photo. */
export async function pickPhoto(page: Page, buttonName: string, file: string): Promise<void> {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: buttonName, exact: true }).click()])
  await chooser.setFiles(photoPath(file))
}

export interface RowSnap {
  name: string
  grams: string
  kcal: string
  protein: string
  fats: string
  carbs: string
  badge: string
}

/** What each item row on the confirm screen shows right now (values and badge text). */
export async function snapshotRows(page: Page): Promise<RowSnap[]> {
  return page.getByTestId('item-row').evaluateAll((rows) =>
    rows.map((r) => {
      const val = (sel: string) => (r.querySelector(sel) as HTMLInputElement | null)?.value ?? ''
      return {
        name: (r.querySelector('input[placeholder="Food name"]') as HTMLInputElement).value,
        grams: val('[data-testid="portion-input"]'),
        kcal: val('input[data-field="kcal"]'),
        protein: val('input[data-field="protein"]'),
        fats: val('input[data-field="fats"]'),
        carbs: val('input[data-field="carbs"]'),
        badge: (r.querySelector('[data-testid="source-badge"]') as HTMLElement | null)?.innerText ?? '',
      }
    }),
  )
}

/** Meal photo -> confirm screen via the sheet ("Allow once" opens the picker). */
export async function photoToConfirm(page: Page, file: string): Promise<void> {
  await pickPhoto(page, 'Allow once', file)
  await expect(page.getByRole('heading', { name: 'Confirm meal' })).toBeVisible({ timeout: 30_000 })
}
