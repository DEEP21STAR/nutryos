import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserContext, Page } from '@playwright/test'
import { expect, openToday } from '../fixtures'

export const BARCODE_DIR = join(process.cwd(), 'e2e', 'fixtures', 'barcodes')

export interface BarcodeFixture {
  file: string
  code: string
  format: 'EAN-13' | 'UPC-A'
  variant: string
  nz: boolean
  product: string
}

export const FIXTURES: BarcodeFixture[] = JSON.parse(readFileSync(join(BARCODE_DIR, 'expected.json'), 'utf8'))
export const fixturePath = (f: BarcodeFixture) => join(BARCODE_DIR, f.file)

/** What the app looks up: UPC-A is padded to 13 digits. */
export const lookupCode = (f: BarcodeFixture) => (f.format === 'UPC-A' ? `0${f.code}` : f.code)

export interface MockOff {
  /** Barcodes requested from Open Food Facts, in order. */
  requested: string[]
}

/**
 * Stands in for Open Food Facts (UI tests never reach the real one). `known` maps a barcode to
 * per-100 g nutriments; any other code answers `status: 0` like the real API. A product listed
 * with `nutriments: {}` is the "known but no calories" case.
 */
export async function mockOff(context: BrowserContext, known: Record<string, { name: string; nutriments: Record<string, number> }>): Promise<MockOff> {
  const state: MockOff = { requested: [] }
  await context.route(/world\.openfoodfacts\.org/, async (route) => {
    const url = new URL(route.request().url())
    const code = decodeURIComponent(url.pathname.split('/').pop() ?? '').replace('.json', '')
    state.requested.push(code)
    const hit = known[code]
    const body = hit ? { status: 1, code, product: { code, product_name: hit.name, nutriments: hit.nutriments } } : { status: 0, code, status_verbose: 'product not found' }
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) })
  })
  return state
}

/** A normal product, for tests that only care about the decode. */
export const okProduct = (code: string) => ({ name: `Product ${code}`, nutriments: { 'energy-kcal_100g': 250, proteins_100g: 5, fat_100g: 10, carbohydrates_100g: 30 } })

/** Today -> orb -> "Scan barcode" (the button on the capture sheet). */
export async function openBarcode(page: Page): Promise<void> {
  await openToday(page)
  await page.locator('[data-tour="orb"] button').click({ force: true })
  await page.getByRole('button', { name: 'Scan barcode', exact: true }).click()
  await expect(page.getByTestId('barcode-capture')).toBeVisible()
}

/** Tells the page not to bother with a camera (the file/typed paths are under test). */
export async function noCamera(page: Page): Promise<void> {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('no camera in this test', 'NotFoundError'))
  })
}

/** Replaces window.BarcodeDetector with a stub. `codes` is what detect() returns ([] = native finds nothing). */
export async function stubNativeDetector(page: Page, codes: string[]): Promise<void> {
  await page.addInitScript((c: string[]) => {
    ;(window as unknown as { __nativeCalls: number }).__nativeCalls = 0
    ;(window as unknown as { BarcodeDetector: unknown }).BarcodeDetector = class {
      async detect() {
        ;(window as unknown as { __nativeCalls: number }).__nativeCalls++
        return c.map((rawValue) => ({ rawValue, format: 'ean_13' }))
      }
    }
  }, codes)
}
