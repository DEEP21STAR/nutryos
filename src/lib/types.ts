import type { MicronutrientProfile } from '@/lib/micronutrients'

/** A single identified food item within a logged meal, editable before/after confirm. */
export interface FoodItem {
  id: string
  name: string
  estimatedGrams: number
  calories: number
  proteinG: number
  fatG: number
  carbsG: number
  /** Optional -- not every source (AI-vision estimate with no DB match) can provide these.
   * Real competitive gap closed 2026-09-19: fiber/sugar depth is the recurring free-vs-premium
   * split across every calorie tracker researched (Cronometer/MyNetDiary gate 100+ nutrients,
   * MyFitnessPal gates parts of this) -- NUTRYOS offers it free. */
  fiberG?: number
  sugarG?: number
  /** Vitamin C/calcium/iron/potassium (free) + vitamin A/B12/magnesium/zinc (Premium) — see
   * micronutrients.ts. Only present for OFF-sourced (branded/packaged) items; the common-foods
   * whole-food dataset doesn't have verified per-item micronutrient data yet. */
  micronutrients?: MicronutrientProfile
  /** Open Food Facts product code this lookup resolved to, if any (barcode/text match). */
  offCode?: string
  /** True once the "Adjust for restaurant prep" nudge (Phase 3, Restaurant/Takeaway Mode) has
   * been applied to this item's calories/fat — gates the ConfirmLog button so it can't be tapped
   * twice and silently stack the multiplier. See eatingOutAdjustment.ts for the actual heuristic. */
  adjustedForEatingOut?: boolean
  /** Where this item's numbers came from (Phase 1 "never a silent 0"). Shown as a badge on the
   * confirm screen. Undefined only on items logged before Phase 1. */
  source?: FoodSource
  /** How much to trust the numbers: 'high' = food-composition table record, 'medium' = median of
   * several products / a recipe / a partial name match, 'low' = AI estimate or thin data. */
  confidence?: FoodConfidence
  /** Human-readable provenance, e.g. "AFCD F007493" or "Open Food Facts median of 9 products". */
  sourceRef?: string
  /** True when 0 kcal is a CONFIRMED value (the source says ~0, e.g. water, or the user tapped
   * "Log with 0"), as opposed to "we couldn't find numbers". See mealGuards.ts. */
  zeroConfirmed?: boolean
}

export type FoodSource = 'my-foods' | 'curated' | 'off' | 'ai-estimate' | 'barcode' | 'user' | 'unresolved'
export type FoodConfidence = 'high' | 'medium' | 'low'

export interface Meal {
  id: string
  /** data: URL (JPEG) of the captured photo — stored inline for now; swapped for a Supabase
   * Storage URL once the real backend is wired in (see lib/supabase.ts).
   * Null for a voice-logged meal, which has no photo at all. For a menu-mode meal this holds the
   * PLATE photo when the user added one, else the menu photo itself — see MenuCapture.tsx's own
   * comment for why only one photo is kept per meal (Supabase Storage upload path only ever
   * handles a single blob, matching every other capture path). */
  photoDataUrl: string | null
  items: FoodItem[]
  loggedAt: string // ISO timestamp — already a full date+time (`new Date().toISOString()` in
  // ConfirmLog, `timestamptz` in Postgres), not just time-of-day. Nothing to add here for the
  // Phase 3 "full timestamp" requirement — MealTimeline.tsx just wasn't rendering the date part,
  // fixed there instead of here.
  /** "Eating Out" context tag (Phase 3, 2026-09-16) — settable on ANY entry (photo, voice, or
   * menu path), not just menu-mode ones. Distinct from whether a menu photo was used at all. */
  isEatingOut?: boolean
  /** Free-text restaurant/takeaway name, only meaningful when isEatingOut is true. No directory/
   * lookup — just what the user typed — used for the repeat-visit "you usually get X here"
   * suggestion in ConfirmLog (see resolveFoodItems.ts's findRepeatVisitSuggestion). */
  restaurantName?: string
}

export interface MacroTotals {
  calories: number
  proteinG: number
  fatG: number
  carbsG: number
  /** Optional -- see FoodItem's own comment for why (not every source provides these). Omitted
   * from every existing plain-object MacroTotals literal in the codebase on purpose, so this
   * stays a genuinely additive change rather than a breaking one. */
  fiberG?: number
  sugarG?: number
}

export function sumMacros(items: FoodItem[]): MacroTotals {
  return items.reduce(
    (acc, it) => ({
      calories: acc.calories + it.calories,
      proteinG: acc.proteinG + it.proteinG,
      fatG: acc.fatG + it.fatG,
      carbsG: acc.carbsG + it.carbsG,
      fiberG: (acc.fiberG ?? 0) + (it.fiberG ?? 0),
      sugarG: (acc.sugarG ?? 0) + (it.sugarG ?? 0),
    }),
    { calories: 0, proteinG: 0, fatG: 0, carbsG: 0, fiberG: 0, sugarG: 0 },
  )
}

export interface Goals {
  calorieGoal: number
  proteinGoalG: number
  fatGoalG: number
  carbsGoalG: number
}

export const DEFAULT_GOALS: Goals = {
  calorieGoal: 2200,
  proteinGoalG: 150,
  fatGoalG: 70,
  carbsGoalG: 220,
}
