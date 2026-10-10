/**
 * Open Food Facts lookup — same public API already proven in tonight's CLI
 * build. Free, no key required, CORS-open (world.openfoodfacts.org serves
 * `Access-Control-Allow-Origin: *`). Used to turn a food NAME identified by
 * the vision model into real macro numbers (calories/protein/fat/carbs) per
 * 100g, which we then scale by the vision model's estimated portion size.
 */

import { getCachedFoodLookup, cacheFoodLookup } from '@/lib/offlineFoodCache'
import { extractMicronutrientsPer100g, scaleMicronutrients, type MicronutrientProfile } from '@/lib/micronutrients'
import { bestFuzzyMatch, normalizeName, normalizeTokens, tokenSimilarity } from '@/lib/fuzzyMatch'
import { pickMedianProduct } from '@/lib/offMedian'

export interface OffMacros {
  code: string
  productName: string
  caloriesPer100g: number
  proteinPer100gG: number
  fatPer100gG: number
  carbsPer100gG: number
  /** Optional — not every OFF product or common-food entry has these (verified against a real
   * OFF product response before naming these fields: fiber_100g/sugars_100g are real, standard
   * keys, not guessed). */
  fiberPer100gG?: number
  sugarPer100gG?: number
  /** Per-100g, from OFF's nutriments_estimated block — see micronutrients.ts. Undefined for the
   * common-foods dataset (not sourced for those, see that file's own comment on scope). */
  micronutrientsPer100g?: MicronutrientProfile
  /** Search lookups only: how many plausible products the median was taken from. */
  validCount?: number
}

interface OffSearchResponse {
  products?: Array<{
    code?: string
    product_name?: string
    product_name_en?: string
    nutriments?: Record<string, number>
    nutriments_estimated?: Record<string, number>
  }>
}

/**
 * Sliding-window limiter for OFF *search* requests. OFF asks for at most 10 searches/minute/IP;
 * NUTRYOS stays at 8. `acquire(maxWaitMs)` waits for a slot up to maxWaitMs and returns false if
 * none frees up in time (the caller then skips OFF instead of hanging the confirm screen).
 */
export class RateLimiter {
  private stamps: number[] = []
  readonly limit: number
  readonly windowMs: number
  private readonly now: () => number

  constructor(limit: number, windowMs: number, now: () => number = Date.now) {
    this.limit = limit
    this.windowMs = windowMs
    this.now = now
  }

  /** Timestamps of every granted request (for the live gate's per-minute audit). */
  get history(): readonly number[] {
    return this.stamps
  }

  private inWindow(t: number): number {
    return this.stamps.filter((s) => t - s < this.windowMs).length
  }

  async acquire(maxWaitMs: number): Promise<boolean> {
    const t = this.now()
    if (this.inWindow(t) < this.limit) {
      this.stamps.push(t)
      return true
    }
    const recent = this.stamps.filter((s) => t - s < this.windowMs).sort((a, b) => a - b)
    const waitMs = recent[recent.length - this.limit] + this.windowMs - t + 5
    if (waitMs > maxWaitMs) return false
    await new Promise((r) => setTimeout(r, waitMs))
    return this.acquire(maxWaitMs - waitMs)
  }
}

export const offSearchLimiter = new RateLimiter(8, 60_000)

/**
 * Query rules: normalised names that OFF's free-text ranking handles badly get a better search
 * term and/or a category filter. Matched with the same fuzzy matcher as the food tables.
 */
export const OFF_QUERY_RULES: Array<{ aliases: string[]; terms?: string; category?: string }> = [
  { aliases: ['whey protein powder', 'whey protein', 'protein powder', 'whey'], terms: 'whey', category: 'en:protein-powders' },
  { aliases: ['protein bar'], category: 'en:protein-bars' },
  { aliases: ['oat milk', 'oat drink'], category: 'en:oat-based-drinks' },
  { aliases: ['soy milk', 'soya milk'], category: 'en:soy-based-drinks' },
  { aliases: ['almond milk'], category: 'en:almond-based-drinks' },
  { aliases: ['weet bix', 'weetbix'], terms: 'weet-bix' },
  { aliases: ['greek yoghurt', 'greek yogurt'], category: 'en:greek-style-yogurts' },
  { aliases: ['peanut butter'], category: 'en:peanut-butters' },
]

export interface OffSearchOptions {
  fetchImpl?: typeof fetch
  /** Extra request headers. Node callers set a real User-Agent; browsers can't. */
  headers?: Record<string, string>
  limiter?: RateLimiter
  /** How long to wait for a rate-limit slot before skipping OFF (ms). */
  maxWaitMs?: number
  /** Per-request timeout (ms). */
  timeoutMs?: number
  /** Skip the localStorage result cache (the live gate measures real calls). */
  noCache?: boolean
}

/** Builds the OFF search URL for a food name (exported for tests). */
export function buildOffSearch(query: string): { url: string; filteredByCategory: boolean; terms: string } {
  const rule = bestFuzzyMatch(query, OFF_QUERY_RULES)
  const terms = rule ? (rule.item.terms ?? '') : normalizeName(query)
  const params = new URLSearchParams({
    action: 'process',
    json: '1',
    page_size: '24',
    fields: 'code,product_name,product_name_en,nutriments,nutriments_estimated',
  })
  if (terms) {
    params.set('search_terms', terms)
    params.set('search_simple', '1')
  }
  if (rule?.item.category) {
    params.set('tagtype_0', 'categories')
    params.set('tag_contains_0', 'contains')
    params.set('tag_0', rule.item.category)
  }
  return { url: `https://world.openfoodfacts.org/cgi/search.pl?${params}`, filteredByCategory: !!rule?.item.category, terms }
}

/** A product name is relevant when it fuzzily contains every word of the query (all of them for
 * up to 3 words, all but one for longer queries). */
export function isRelevantName(terms: string, productName: string): boolean {
  const q = normalizeTokens(terms)
  if (q.length === 0) return true
  const p = normalizeTokens(productName)
  const hits = q.filter((qt) => p.some((pt) => tokenSimilarity(pt, qt) > 0 || pt.includes(qt)))
  return hits.length >= (q.length <= 3 ? q.length : q.length - 1)
}

/**
 * Step 3 of the resolution chain: Open Food Facts free-text search, made less naive (Phase 1).
 *  - the name is normalised and, for foods OFF ranks badly, rewritten to better terms plus a
 *    category filter (OFF_QUERY_RULES);
 *  - products with missing or implausible numbers are rejected (kcal must match 4/4/9 within 25%,
 *    see offMedian.ts) and, without a category filter, so are products whose name doesn't fit;
 *  - the MEDIAN-kcal product of what's left is used, not the first hit.
 * Returns null when nothing usable was found, when the rate-limit slot doesn't free up in time,
 * or when the request fails. It never returns zeros: a null means "keep looking / ask the user".
 *
 * Known limit: OFF is a packaged-product database. Whole foods are covered by the curated table
 * (step 2), which runs first.
 */
export async function lookupFoodMacros(query: string, opts: OffSearchOptions = {}): Promise<OffMacros | null> {
  if (!opts.noCache) {
    const cached = getCachedFoodLookup(query)
    if (cached && cached.caloriesPer100g > 0) return cached
  }

  const { url, filteredByCategory, terms } = buildOffSearch(query)
  const limiter = opts.limiter ?? offSearchLimiter
  if (!(await limiter.acquire(opts.maxWaitMs ?? 3000))) return null

  const doFetch = opts.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000)
  let data: OffSearchResponse
  try {
    const res = await doFetch(url, { headers: opts.headers, signal: controller.signal })
    if (!res.ok) return null
    data = (await res.json()) as OffSearchResponse
  } catch {
    return null // network error, timeout, or OFF's HTML "temporarily unavailable" page
  } finally {
    clearTimeout(timer)
  }

  const pick = pickMedianProduct(data.products ?? [], filteredByCategory ? undefined : (name) => isRelevantName(terms, name))
  if (!pick) return null
  const best = pick.product
  const result: OffMacros = {
    code: best.code ?? '',
    productName: best.product_name_en || best.product_name || query,
    caloriesPer100g: pick.per100g.kcal,
    proteinPer100gG: pick.per100g.proteinG,
    fatPer100gG: pick.per100g.fatG,
    carbsPer100gG: pick.per100g.carbsG,
    fiberPer100gG: pick.per100g.fiberG,
    sugarPer100gG: pick.per100g.sugarG,
    micronutrientsPer100g: best.nutriments_estimated ? extractMicronutrientsPer100g(best.nutriments_estimated) : undefined,
    validCount: pick.validCount,
  }
  if (!opts.noCache) cacheFoodLookup(query, result)
  return result
}

/** Raw OFF v2 product response (only the parts we read). */
export interface OffProductResponse {
  status?: number
  product?: {
    code?: string
    product_name?: string
    product_name_en?: string
    nutriments?: Record<string, unknown>
    nutriments_estimated?: Record<string, number>
  }
}

/** Result of a barcode lookup. `no-kcal` = OFF knows the product but has no usable energy value. */
export type BarcodeLookup =
  | { kind: 'found'; macros: OffMacros }
  | { kind: 'no-kcal'; code: string; productName: string }
  | { kind: 'not-found' }

function offNum(v: unknown): number | undefined {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}

/**
 * Maps an OFF v2 product response to a lookup result (pure, unit-tested). Energy comes from
 * energy-kcal_100g, else energy-kj_100g / energy_100g converted at 4.184. A missing, zero or
 * impossible (>950 kcal per 100 g) energy is `no-kcal`: the caller sends the user to the label /
 * manual path instead of logging a silent 0. Missing protein/fat/carbs become 0, which is harmless
 * because the kcal is real.
 */
export function mapOffProductResponse(data: OffProductResponse, barcode: string): BarcodeLookup {
  if (data.status !== 1 || !data.product) return { kind: 'not-found' }
  const prod = data.product
  const n = prod.nutriments ?? {}
  const code = prod.code ?? barcode
  const productName = (prod.product_name_en || prod.product_name || '').trim() || `Barcode ${barcode}`
  let kcal = offNum(n['energy-kcal_100g'])
  if (kcal === undefined || !(kcal > 0)) {
    const kj = offNum(n['energy-kj_100g']) ?? offNum(n['energy_100g'])
    kcal = kj !== undefined && kj > 0 ? kj / 4.184 : undefined
  }
  if (kcal === undefined || !(kcal > 0) || kcal > 950) return { kind: 'no-kcal', code, productName }
  return {
    kind: 'found',
    macros: {
      code,
      productName,
      caloriesPer100g: Math.round(kcal * 10) / 10,
      proteinPer100gG: offNum(n['proteins_100g']) ?? 0,
      fatPer100gG: offNum(n['fat_100g']) ?? 0,
      carbsPer100gG: offNum(n['carbohydrates_100g']) ?? 0,
      fiberPer100gG: offNum(n['fiber_100g']),
      sugarPer100gG: offNum(n['sugars_100g']),
      micronutrientsPer100g: prod.nutriments_estimated ? extractMicronutrientsPer100g(prod.nutriments_estimated) : undefined,
    },
  }
}

/**
 * Direct barcode lookup: the OFF v2 product endpoint, exact match by code (public API, GET only,
 * sends nothing but the barcode digits). An unknown code answers `status:0` (HTTP 404 in practice, 200 in older
 * responses); both map to `not-found`. Browsers do not let a page set User-Agent, so the app identifies itself through the
 * `app_name` parameter OFF documents for that case. Retries once on a 5xx and gives up after 8 s.
 */
export async function lookupByBarcode(barcode: string, fetchImpl: typeof fetch = fetch): Promise<BarcodeLookup> {
  const url = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(
    barcode,
  )}.json?app_name=NUTRYOS&fields=code,product_name,product_name_en,nutriments,nutriments_estimated`

  const get = () => fetchImpl(url, { signal: AbortSignal.timeout(8000) })
  let res = await get()
  if (!res.ok && res.status >= 500) {
    await new Promise((r) => setTimeout(r, 1500))
    res = await get()
  }
  if (res.status === 404) return { kind: 'not-found' } // OFF answers 404 for some unknown codes
  if (!res.ok) throw new Error(`Open Food Facts request failed: ${res.status}`)
  return mapOffProductResponse((await res.json()) as OffProductResponse, barcode)
}

/** Scales a per-100g macro profile to an estimated portion size in grams. */
export function scaleToPortion(off: OffMacros, grams: number) {
  const factor = grams / 100
  return {
    calories: Math.round(off.caloriesPer100g * factor),
    proteinG: Math.round(off.proteinPer100gG * factor * 10) / 10,
    fatG: Math.round(off.fatPer100gG * factor * 10) / 10,
    carbsG: Math.round(off.carbsPer100gG * factor * 10) / 10,
    fiberG: off.fiberPer100gG !== undefined ? Math.round(off.fiberPer100gG * factor * 10) / 10 : undefined,
    sugarG: off.sugarPer100gG !== undefined ? Math.round(off.sugarPer100gG * factor * 10) / 10 : undefined,
    micronutrients: off.micronutrientsPer100g ? scaleMicronutrients(off.micronutrientsPer100g, grams) : undefined,
  }
}
