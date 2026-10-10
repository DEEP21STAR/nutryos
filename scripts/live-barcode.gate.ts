/**
 * `npm run gate:live-barcode`: NUTRYOS Phase 3 live Open Food Facts check (real network, polite).
 * The 10 sample photos decode to their expected codes in the Playwright specs (e2e/barcode.spec.ts),
 * so this takes each expected code and runs the app's real lookupByBarcode() against OFF:
 * <= 10 requests (8 distinct products, deduplicated, plus 1 made-up valid-checksum code), spaced
 * 1.2 s apart, identified with a User-Agent as OFF asks. PASS needs >= 8/10 images resolving to
 * non-zero kcal and the made-up code resolving to `not-found` (-> label/manual path, never a 0).
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { lookupByBarcode } from '@/lib/openFoodFacts'
import { normalizeBarcode } from '@/lib/barcode'

const UA = 'NUTRYOS-live-gate/1.0 (+https://github.com/DEEP21STAR/nutryos)'
const MADE_UP = '9419372640584'
let requests = 0
const politeFetch: typeof fetch = async (input, init) => {
  if (requests++ > 0) await new Promise((r) => setTimeout(r, 1200))
  return fetch(input, { ...init, headers: { ...(init?.headers ?? {}), 'User-Agent': UA } })
}

describe('live Open Food Facts barcode check', () => {
  it('>= 8/10 sample codes give non-zero kcal; a made-up code is not-found', async () => {
    const fixtures = JSON.parse(readFileSync('e2e/fixtures/barcodes/expected.json', 'utf8')) as Array<{ file: string; code: string }>
    const byCode = new Map<string, Awaited<ReturnType<typeof lookupByBarcode>>>()
    for (const f of fixtures) {
      const code = normalizeBarcode(f.code)!.code
      if (!byCode.has(code)) byCode.set(code, await lookupByBarcode(code, politeFetch))
    }
    let ok = 0
    for (const f of fixtures) {
      const r = byCode.get(normalizeBarcode(f.code)!.code)!
      const kcal = r.kind === 'found' ? r.macros.caloriesPer100g : 0
      console.log(`${f.file.padEnd(46)} ${f.code.padEnd(14)} ${r.kind === 'found' ? `${r.macros.productName.slice(0, 28).padEnd(28)} ${kcal} kcal/100g` : r.kind}`)
      if (kcal > 0) ok++
    }
    const unknown = await lookupByBarcode(MADE_UP, politeFetch)
    console.log(`made-up ${MADE_UP}: ${unknown.kind}`)
    console.log(`RESULT ${ok}/10 images with non-zero kcal; OFF requests made: ${requests}`)
    expect(requests).toBeLessThanOrEqual(10)
    expect(ok).toBeGreaterThanOrEqual(8)
    expect(unknown.kind).toBe('not-found')
  }, 120_000)
})
