/**
 * Pure Open Food Facts result filtering, shared by the app (openFoodFacts.ts) and the build-time
 * table generator (scripts/build-foods.mjs imports this file directly, so it must stay free of
 * `@/` imports and browser APIs).
 *
 * Rules (NUTRYOS Phase 1): a product is only usable when it has energy plus all three macros, the
 * numbers are physically possible, and the stated kcal agrees with 4/4/9 (protein/carbs/fat) within
 * 25%. Among the usable products the one with the MEDIAN kcal is chosen, not the first search hit,
 * so one odd product (an oil, a powder mix, a mislabelled entry) can't decide the answer.
 */

export interface Per100g {
  kcal: number
  proteinG: number
  fatG: number
  carbsG: number
  fiberG?: number
  sugarG?: number
}

export interface OffProductLike {
  code?: string
  product_name?: string
  product_name_en?: string
  nutriments?: Record<string, unknown>
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}

/** Per-100 g macros from an OFF `nutriments` block, or null when any core value is missing. */
export function per100gFromOff(nutriments: Record<string, unknown> | undefined): Per100g | null {
  if (!nutriments) return null
  let kcal = num(nutriments['energy-kcal_100g'])
  if (kcal === undefined) {
    const kj = num(nutriments['energy-kj_100g']) ?? num(nutriments['energy_100g'])
    if (kj !== undefined) kcal = kj / 4.184
  }
  const proteinG = num(nutriments['proteins_100g'])
  const fatG = num(nutriments['fat_100g'])
  const carbsG = num(nutriments['carbohydrates_100g'])
  if (kcal === undefined || proteinG === undefined || fatG === undefined || carbsG === undefined) return null
  return {
    kcal,
    proteinG,
    fatG,
    carbsG,
    fiberG: num(nutriments['fiber_100g']),
    sugarG: num(nutriments['sugars_100g']),
  }
}

/** kcal predicted from macros with the 4/4/9 factors (optionally +2 kcal/g fibre). */
export function atwaterKcal(p: Per100g, withFibre = false): number {
  return 4 * p.proteinG + 4 * p.carbsG + 9 * p.fatG + (withFibre ? 2 * (p.fiberG ?? 0) : 0)
}

/** True when the numbers are possible and the stated kcal matches 4/4/9 within `tolerance`. */
export function isPlausible(p: Per100g, tolerance = 0.25): boolean {
  if (!(p.kcal > 0 && p.kcal <= 900)) return false
  if ([p.proteinG, p.fatG, p.carbsG].some((v) => v < 0 || v > 100)) return false
  if (p.proteinG + p.fatG + p.carbsG > 105) return false
  if (p.kcal < 20) return Math.abs(p.kcal - atwaterKcal(p)) <= 10
  return [atwaterKcal(p), atwaterKcal(p, true)].some((est) => Math.abs(p.kcal - est) <= tolerance * p.kcal)
}

export interface MedianPick<T extends OffProductLike> {
  product: T
  per100g: Per100g
  /** How many products passed the filters (the pick is the median of these). */
  validCount: number
  /** Codes of every product that passed, for provenance. */
  validCodes: string[]
}

/**
 * Median-kcal product among the plausible ones. `isRelevant` (optional) rejects products whose
 * name doesn't fit the query; pass nothing when the search was already narrowed by category.
 */
export function pickMedianProduct<T extends OffProductLike>(
  products: readonly T[],
  isRelevant?: (name: string) => boolean,
): MedianPick<T> | null {
  const valid: Array<{ product: T; per100g: Per100g }> = []
  for (const product of products) {
    const per100g = per100gFromOff(product.nutriments)
    if (!per100g || !isPlausible(per100g)) continue
    const name = product.product_name_en || product.product_name || ''
    if (isRelevant && !isRelevant(name)) continue
    valid.push({ product, per100g })
  }
  if (valid.length === 0) return null
  const sorted = [...valid].sort((a, b) => a.per100g.kcal - b.per100g.kcal)
  const mid = sorted[Math.floor((sorted.length - 1) / 2)]
  return {
    product: mid.product,
    per100g: mid.per100g,
    validCount: valid.length,
    validCodes: valid.map((v) => v.product.code ?? '').filter(Boolean),
  }
}
