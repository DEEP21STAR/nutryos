import { bestFuzzyMatch, type FuzzyMatch } from '@/lib/fuzzyMatch'
import type { Per100g } from '@/lib/offMedian'

/**
 * My Foods: the user's own saved foods, checked FIRST in the resolution chain (step 1), so a food
 * the user has corrected once resolves to their numbers forever after.
 *
 * Phase 1 ships the interface plus a small localStorage store. Phase 5 (auto-save on log, ranking
 * by frequency/time of day, 1-tap re-log) builds on the same `MyFoodsStore` contract.
 */
export interface MyFood {
  id: string
  name: string
  /** Extra names it should answer to ("my whey", "protein"). The name itself always counts. */
  aliases?: string[]
  per100g: Per100g
  /** The portion the user usually has, used when the parser gives no grams. */
  usualGrams?: number
  updatedAt: string
}

export interface MyFoodsStore {
  all(): MyFood[]
  save(food: MyFood): void
}

const STORAGE_KEY = 'nutryos.myFoods.v1'

export const localMyFoodsStore: MyFoodsStore = {
  all() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      const parsed = raw ? (JSON.parse(raw) as MyFood[]) : []
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return [] // storage blocked/unavailable: My Foods is simply empty
    }
  },
  save(food) {
    try {
      const rest = this.all().filter((f) => f.id !== food.id)
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...rest, food]))
    } catch {
      /* storage full or blocked: saving is best-effort */
    }
  },
}

export function matchMyFood(query: string, store: MyFoodsStore = localMyFoodsStore): FuzzyMatch<MyFood & { aliases: string[] }> | null {
  const foods = store.all().map((f) => ({ ...f, aliases: [f.name, ...(f.aliases ?? [])] }))
  return bestFuzzyMatch(query, foods)
}
