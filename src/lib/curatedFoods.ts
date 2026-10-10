import { bestFuzzyMatch, type FuzzyMatch } from '@/lib/fuzzyMatch'
import type { Per100g } from '@/lib/offMedian'

/**
 * Curated NZ/AU everyday-foods table (step 2 of the resolution chain). The data file is generated
 * by scripts/build-foods.mjs from FSANZ AFCD Release 3, USDA SR Legacy and Open Food Facts, every
 * entry carrying its source id/URL. It is loaded lazily (its own JS chunk, precached by the
 * service worker) so it costs nothing until the first lookup and works offline afterwards.
 */

export interface CuratedSource {
  db: string
  id: string
  name: string
  url: string
}

export interface CuratedFood {
  id: string
  name: string
  category: string
  aliases: string[]
  per100g: Per100g
  serving: { grams: number; label: string; basis: string }
  source: CuratedSource
  reference?: { per100g: Per100g; source: CuratedSource }
  confidence: 'high' | 'medium'
}

interface CuratedFile {
  foods: CuratedFood[]
}

let cache: Promise<CuratedFood[]> | null = null

export function loadCuratedFoods(): Promise<CuratedFood[]> {
  cache ??= import('@/data/curatedFoods.json').then((m) => (m.default as unknown as CuratedFile).foods)
  return cache
}

export async function matchCuratedFood(query: string): Promise<FuzzyMatch<CuratedFood> | null> {
  return bestFuzzyMatch(query, await loadCuratedFoods())
}
