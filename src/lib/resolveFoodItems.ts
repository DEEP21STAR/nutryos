import { lookupFoodMacros, scaleToPortion, type OffMacros } from '@/lib/openFoodFacts'
import { matchCuratedFood, type CuratedFood } from '@/lib/curatedFoods'
import { matchMyFood, type MyFood } from '@/lib/myFoods'
import { estimateMacrosViaCloud, getCloudAiOptIn, type AiEstimate } from '@/lib/cloudAi'
import type { FuzzyMatch } from '@/lib/fuzzyMatch'
import type { Per100g } from '@/lib/offMedian'
import { uid } from '@/lib/utils'
import type { FoodConfidence, FoodItem, FoodSource } from '@/lib/types'
import type { IdentifiedItem } from '@/lib/ollamaVision'

/**
 * NUTRYOS Phase 1 resolution chain ("never a silent 0"), shared by the photo, voice/text and menu
 * capture paths. Each step runs only when the previous one gave nothing usable:
 *   1. My Foods (the user's own saved foods, fuzzy match)
 *   2. Curated NZ/AU table (src/data/curatedFoods.json, sourced from AFCD/USDA/OFF at build time)
 *   3. Open Food Facts search (normalised query, category rules, median of plausible products)
 *   4. AI estimate via the edge function: ONLY when the user opted in to cloud AI
 *   5. otherwise the item comes back as source 'unresolved' with 0s, which the confirm screen shows
 *      as "Needs numbers" and which blocks logging until the user deals with it (mealGuards.ts).
 * Every resolved item carries `source` + `confidence` (+ `sourceRef`) for the badge.
 */

export interface ResolveDeps {
  myFoods: (query: string) => FuzzyMatch<MyFood> | null
  curated: (query: string) => Promise<FuzzyMatch<CuratedFood> | null>
  off: (query: string) => Promise<OffMacros | null>
  aiEstimate: (items: Array<{ name: string; grams: number }>) => Promise<Array<AiEstimate | null>>
  cloudAiOptIn: () => boolean
}

export const defaultResolveDeps: ResolveDeps = {
  myFoods: (q) => matchMyFood(q),
  curated: matchCuratedFood,
  off: (q) => lookupFoodMacros(q),
  aiEstimate: estimateMacrosViaCloud,
  cloudAiOptIn: getCloudAiOptIn,
}

function per100gToOff(p: Per100g, name: string, code = ''): OffMacros {
  return {
    code,
    productName: name,
    caloriesPer100g: p.kcal,
    proteinPer100gG: p.proteinG,
    fatPer100gG: p.fatG,
    carbsPer100gG: p.carbsG,
    fiberPer100gG: p.fiberG,
    sugarPer100gG: p.sugarG,
  }
}

function buildItem(
  name: string,
  grams: number,
  macros: OffMacros,
  meta: { source: FoodSource; confidence: FoodConfidence; sourceRef: string; offCode?: string },
): FoodItem {
  const scaled = scaleToPortion(macros, grams)
  // A source that genuinely says ~0 kcal (water, diet cola) is a confirmed 0, not a missing value.
  const zeroConfirmed = macros.caloriesPer100g <= 0.5 ? true : undefined
  return {
    id: uid(),
    name,
    estimatedGrams: grams,
    ...scaled,
    // Rounding a real non-zero value down to 0 kcal would look like a miss; keep at least 1.
    calories: macros.caloriesPer100g > 0.5 && scaled.calories < 1 ? 1 : scaled.calories,
    ...(meta.offCode ? { offCode: meta.offCode } : {}),
    source: meta.source,
    confidence: meta.confidence,
    sourceRef: meta.sourceRef,
    ...(zeroConfirmed ? { zeroConfirmed } : {}),
  }
}

function unresolvedItem(name: string, grams: number): FoodItem {
  return { id: uid(), name, estimatedGrams: grams, calories: 0, proteinG: 0, fatG: 0, carbsG: 0, source: 'unresolved' }
}

const validGrams = (g: number) => Number.isFinite(g) && g > 0

/** Steps 1-3 for one item; null when none of them produced usable numbers. */
export async function resolveLocally(item: IdentifiedItem, deps: ResolveDeps): Promise<FoodItem | null> {
  const query = item.name.trim()
  if (!query) return null

  // 1. My Foods
  try {
    const mine = deps.myFoods(query)
    if (mine && mine.item.per100g.kcal >= 0) {
      const grams = validGrams(item.estimatedGrams) ? item.estimatedGrams : (mine.item.usualGrams ?? 100)
      return buildItem(mine.item.name, grams, per100gToOff(mine.item.per100g, mine.item.name), {
        source: 'my-foods',
        confidence: mine.queryCoverage === 1 ? 'high' : 'medium',
        sourceRef: 'Saved in My Foods',
      })
    }
  } catch {
    /* My Foods unavailable: carry on down the chain */
  }

  // 2. Curated NZ/AU table
  try {
    const cur = await deps.curated(query)
    if (cur) {
      const food = cur.item
      const grams = validGrams(item.estimatedGrams) ? item.estimatedGrams : food.serving.grams
      const exact = cur.queryCoverage === 1 && cur.score >= 0.9
      return buildItem(food.name, grams, per100gToOff(food.per100g, food.name), {
        source: 'curated',
        confidence: exact ? food.confidence : 'medium',
        sourceRef: `${food.source.db} ${food.source.id}`,
      })
    }
  } catch {
    /* table failed to load: carry on */
  }

  // 3. Open Food Facts
  try {
    const off = await deps.off(query)
    if (off && off.caloriesPer100g > 0) {
      const grams = validGrams(item.estimatedGrams) ? item.estimatedGrams : 100
      const n = off.validCount ?? 1
      return buildItem(off.productName || query, grams, off, {
        source: 'off',
        confidence: n >= 5 ? 'medium' : 'low',
        sourceRef: `Open Food Facts, median of ${n} product${n === 1 ? '' : 's'}`,
        offCode: off.code || undefined,
      })
    }
  } catch {
    /* network failure: carry on */
  }
  return null
}

/** Turns an AI estimate into a FoodItem (badge "AI estimate"). */
export function itemFromAiEstimate(name: string, grams: number, est: AiEstimate): FoodItem {
  return {
    id: uid(),
    name,
    estimatedGrams: grams,
    calories: est.calories,
    proteinG: est.proteinG,
    fatG: est.fatG,
    carbsG: est.carbsG,
    source: 'ai-estimate',
    confidence: est.confidence,
    sourceRef: 'AI estimate (cloud, opt-in)',
  }
}

export async function resolveIdentifiedItems(items: IdentifiedItem[], deps: ResolveDeps = defaultResolveDeps): Promise<FoodItem[]> {
  const local = await Promise.all(items.map((it) => resolveLocally(it, deps)))
  const results: FoodItem[] = local.map((r, i) =>
    r ?? unresolvedItem(items[i].name, validGrams(items[i].estimatedGrams) ? items[i].estimatedGrams : 100),
  )

  // 4. AI estimate, opted-in users only, one batched request for everything still unresolved.
  const pending = results.map((r, i) => (r.source === 'unresolved' && r.name.trim() ? i : -1)).filter((i) => i >= 0)
  if (pending.length > 0 && deps.cloudAiOptIn()) {
    try {
      const estimates = await deps.aiEstimate(pending.map((i) => ({ name: results[i].name, grams: results[i].estimatedGrams })))
      pending.forEach((idx, k) => {
        const est = estimates[k]
        if (est) results[idx] = itemFromAiEstimate(results[idx].name, results[idx].estimatedGrams, est)
      })
    } catch {
      /* AI unreachable: items stay 'unresolved' -> "Needs numbers" */
    }
  }
  // 5. Whatever is still unresolved goes to the confirm screen as "Needs numbers".
  return results
}
