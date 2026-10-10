/**
 * `npm run gate:live-foods` — NUTRYOS Phase 1 acceptance, run against the REAL chain (no mocks,
 * real network for Open Food Facts, cloud AI OFF).
 *
 * Pass 1-3: the 15-food matrix through resolveIdentifiedItems (My Foods empty in Node, curated
 * table, OFF, no AI). PASS needs:
 *   - >= 14/15 foods with non-zero kcal whose kcal is within +/-25% of the INDEPENDENT reference
 *     stored with the table entry (a second source: USDA / OFF median / AFCD / USDA recipe), and
 *     protein within +/-25% (or +/-1.5 g for low-protein foods);
 *   - whey protein powder 100-140 kcal per 30 g;
 *   - p95 latency <= 3 s on the warm passes (2 and 3);
 *   - <= 8 OFF search requests in any 60 s window (whole run).
 * Pass "OFF-only": the same 15 names sent straight to step 3, to show the OFF step working live
 * (informational, it does not decide PASS; OFF is a packaged-product database).
 */
import { describe, expect, it } from 'vitest'
import { resolveIdentifiedItems, type ResolveDeps } from '@/lib/resolveFoodItems'
import { loadCuratedFoods, matchCuratedFood } from '@/lib/curatedFoods'
import { lookupFoodMacros, RateLimiter } from '@/lib/openFoodFacts'
import type { FoodItem } from '@/lib/types'

const UA = { 'User-Agent': 'NUTRYOS-live-gate/1.0 (+https://deep21star.github.io/nutryos/)' }

const MATRIX: Array<{ food: string; grams: number; refId: string }> = [
  { food: 'whey protein powder', grams: 30, refId: 'whey-protein-powder' },
  { food: 'flat white', grams: 220, refId: 'flat-white' },
  { food: 'Weet-Bix', grams: 30, refId: 'weet-bix' },
  { food: 'mince on toast', grams: 184, refId: 'mince-on-toast' },
  { food: 'protein bar', grams: 60, refId: 'protein-bar' },
  { food: 'banana', grams: 120, refId: 'banana' },
  { food: 'whole milk', grams: 250, refId: 'milk-whole' },
  { food: 'egg', grams: 50, refId: 'egg' },
  { food: 'white rice cooked', grams: 180, refId: 'rice-white' },
  { food: 'chicken breast', grams: 150, refId: 'chicken-breast' },
  { food: 'sourdough toast', grams: 40, refId: 'toast-sourdough' },
  { food: 'peanut butter', grams: 20, refId: 'peanut-butter' },
  { food: 'Greek yoghurt', grams: 150, refId: 'greek-yoghurt' },
  { food: 'apple', grams: 150, refId: 'apple' },
  { food: 'oat milk', grams: 250, refId: 'oat-milk' },
]

const offCalls: number[] = []
const countingFetch: typeof fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (url.includes('openfoodfacts.org/cgi/search.pl')) offCalls.push(Date.now())
  return fetch(input, init)
}
const limiter = new RateLimiter(8, 60_000)
const offOpts = { fetchImpl: countingFetch, headers: UA, limiter, maxWaitMs: 90_000, noCache: true, timeoutMs: 20_000 }

const deps: ResolveDeps = {
  myFoods: () => null, // no saved foods on a fresh install
  curated: matchCuratedFood,
  off: (q) => lookupFoodMacros(q, offOpts),
  aiEstimate: async () => {
    throw new Error('cloud AI must not be called in this gate')
  },
  cloudAiOptIn: () => false,
}

const pct = (a: number, b: number) => ((a - b) / b) * 100
const pad = (s: string | number, n: number) => String(s).padEnd(n)
const lpad = (s: string | number, n: number) => String(s).padStart(n)

function maxPerMinute(stamps: number[]): number {
  let max = 0
  for (const s of stamps) max = Math.max(max, stamps.filter((t) => t >= s && t - s < 60_000).length)
  return max
}

function p95(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]
}

describe('live foods gate', () => {
  it('15-food matrix through the real chain', async () => {
    const foods = await loadCuratedFoods()
    const refOf = (id: string) => foods.find((f) => f.id === id)!.reference
    for (const m of MATRIX) expect(refOf(m.refId), `reference for ${m.refId}`).toBeTruthy()

    const passes: Array<Array<{ item: FoodItem; ms: number }>> = []
    for (let pass = 0; pass < 3; pass++) {
      const rows: Array<{ item: FoodItem; ms: number }> = []
      for (const m of MATRIX) {
        const t0 = performance.now()
        const [item] = await resolveIdentifiedItems([{ name: m.food, estimatedGrams: m.grams }], deps)
        rows.push({ item, ms: performance.now() - t0 })
      }
      passes.push(rows)
    }

    const warmMs = [...passes[1], ...passes[2]].map((r) => r.ms)
    const lines: string[] = []
    lines.push(`${pad('food', 20)}${pad('source', 18)}${pad('record', 26)}${lpad('kcal/100g', 10)}${lpad('ref', 7)}${lpad('Δ%', 6)}${lpad('P/100g', 8)}${lpad('refP', 6)}${lpad('ms cold', 9)}${lpad('ms warm', 9)}  result`)
    let ok = 0
    let wheyOk = false
    passes[2].forEach(({ item }, i) => {
      const m = MATRIX[i]
      const ref = refOf(m.refId)!
      const kcal100 = (item.calories / m.grams) * 100
      const prot100 = (item.proteinG / m.grams) * 100
      const dK = pct(kcal100, ref.per100g.kcal)
      const protOk = Math.abs(pct(prot100, ref.per100g.proteinG)) <= 25 || Math.abs(prot100 - ref.per100g.proteinG) <= 1.5
      const pass = item.calories > 0 && (item.proteinG > 0 || item.carbsG > 0) && Math.abs(dK) <= 25 && protOk
      if (pass) ok++
      if (m.refId === 'whey-protein-powder') wheyOk = item.calories >= 100 && item.calories <= 140
      lines.push(
        `${pad(m.food, 20)}${pad(item.source ?? '-', 18)}${pad((item.sourceRef ?? '').slice(0, 25), 26)}${lpad(kcal100.toFixed(0), 10)}${lpad(ref.per100g.kcal.toFixed(0), 7)}${lpad(dK.toFixed(0), 6)}${lpad(prot100.toFixed(1), 8)}${lpad(ref.per100g.proteinG.toFixed(1), 6)}${lpad(passes[0][i].ms.toFixed(0), 9)}${lpad(passes[2][i].ms.toFixed(1), 9)}  ${pass ? 'ok' : `MISS${protOk ? '' : ' (protein)'}`}`,
      )
    })
    lines.push(`reference column = the table entry's independent second source (see src/data/curatedFoods.json "reference")`)
    lines.push(`whey: ${passes[2][0].item.calories} kcal / 30 g (need 100-140)`)
    lines.push(`within ±25%: ${ok}/15 (need >= 14) · p95 warm latency ${p95(warmMs).toFixed(1)} ms (need <= 3000) · OFF calls so far ${offCalls.length}`)

    // OFF-only pass (informational): step 3 alone, live, rate-limited.
    const offLines: string[] = []
    if (!process.env.LIVE_FOODS_SKIP_OFF) {
      offLines.push(`\nOFF-only (step 3 alone, informational):`)
      offLines.push(`${pad('food', 20)}${pad('OFF product (median)', 34)}${lpad('n', 4)}${lpad('kcal/100g', 10)}${lpad('ref', 7)}${lpad('Δ%', 6)}${lpad('P/100g', 8)}${lpad('ms', 8)}`)
      let offWithin = 0
      for (const m of MATRIX) {
        const t0 = performance.now()
        const r = await lookupFoodMacros(m.food, offOpts)
        const ms = performance.now() - t0
        const ref = refOf(m.refId)!
        if (!r) {
          offLines.push(`${pad(m.food, 20)}${pad('(no usable result)', 34)}${lpad('-', 4)}${lpad('-', 10)}${lpad(ref.per100g.kcal.toFixed(0), 7)}${lpad('-', 6)}${lpad('-', 8)}${lpad(ms.toFixed(0), 8)}`)
          continue
        }
        const d = pct(r.caloriesPer100g, ref.per100g.kcal)
        if (Math.abs(d) <= 25) offWithin++
        offLines.push(`${pad(m.food, 20)}${pad(r.productName.slice(0, 33), 34)}${lpad(r.validCount ?? 1, 4)}${lpad(r.caloriesPer100g.toFixed(0), 10)}${lpad(ref.per100g.kcal.toFixed(0), 7)}${lpad(d.toFixed(0), 6)}${lpad(r.proteinPer100gG.toFixed(1), 8)}${lpad(ms.toFixed(0), 8)}`)
      }
      offLines.push(`OFF-only within ±25% of reference: ${offWithin}/15`)
    }
    const perMin = maxPerMinute(offCalls)
    offLines.push(`OFF search calls total ${offCalls.length}, max in any 60 s window ${perMin} (need <= 8)`)

    const pass = ok >= 14 && wheyOk && p95(warmMs) <= 3000 && perMin <= 8
    console.log(`\n${lines.join('\n')}\n${offLines.join('\n')}\n\n${pass ? 'LIVE-FOODS PASS' : 'LIVE-FOODS FAIL'}\n`)

    expect(ok).toBeGreaterThanOrEqual(14)
    expect(wheyOk).toBe(true)
    expect(p95(warmMs)).toBeLessThanOrEqual(3000)
    expect(perMin).toBeLessThanOrEqual(8)
  })
})
