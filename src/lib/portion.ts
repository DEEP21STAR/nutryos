import type { FoodItem } from '@/lib/types'
import type { MicronutrientProfile } from '@/lib/micronutrients'

/**
 * Portion rescaling for the confirm screen. Moving the Portion slider (or typing grams) rescales
 * kcal / protein / fat / carbs / fiber / sugar / micronutrients in proportion to grams.
 *
 * Scaling always starts from a BASE (the macros at the grams they were last "true" for), never from
 * the previous rounded result, so dragging 150 -> 60 -> 150 returns the exact original numbers. The
 * base is re-taken from the item whenever its macros no longer equal what a previous rescale produced,
 * i.e. after a manual macro edit or an AI estimate: manual overrides stay, and later portion changes
 * scale from the user's numbers (per-gram rate = edited value / grams at the time of the edit).
 */

export interface MacroSet {
  calories: number
  proteinG: number
  fatG: number
  carbsG: number
  fiberG?: number
  sugarG?: number
  micronutrients?: MicronutrientProfile
}

export interface PortionBase {
  grams: number
  /** Unrounded macros at `grams`. */
  macros: MacroSet
  /** The last values this module wrote to the item; a mismatch means the user edited something. */
  applied: MacroSet
}

export const MAX_PORTION_GRAMS = 10000

function pick(item: FoodItem): MacroSet {
  return {
    calories: item.calories,
    proteinG: item.proteinG,
    fatG: item.fatG,
    carbsG: item.carbsG,
    fiberG: item.fiberG,
    sugarG: item.sugarG,
    micronutrients: item.micronutrients,
  }
}

function same(a: MacroSet, b: MacroSet): boolean {
  return (
    a.calories === b.calories &&
    a.proteinG === b.proteinG &&
    a.fatG === b.fatG &&
    a.carbsG === b.carbsG &&
    a.fiberG === b.fiberG &&
    a.sugarG === b.sugarG &&
    JSON.stringify(a.micronutrients ?? null) === JSON.stringify(b.micronutrients ?? null)
  )
}

const r1 = (v: number) => Math.round(v * 10) / 10
const r2 = (v: number) => Math.round(v * 100) / 100

function scaleMicros(m: MicronutrientProfile | undefined, f: number): MicronutrientProfile | undefined {
  if (!m) return undefined
  const out: MicronutrientProfile = {}
  for (const k of Object.keys(m) as Array<keyof MicronutrientProfile>) {
    const v = m[k]
    if (v !== undefined) out[k] = r2(v * f)
  }
  return out
}

export function clampGrams(g: number): number {
  if (!Number.isFinite(g) || g < 0) return 0
  return Math.min(MAX_PORTION_GRAMS, g)
}

/** Macros for `grams`, scaled from `base`. Pure. */
export function scaleMacros(base: PortionBase, grams: number): MacroSet {
  const f = base.grams > 0 ? grams / base.grams : 0
  const m = base.macros
  const calories = Math.round(m.calories * f)
  return {
    // A real non-zero value must not round down to a silent 0 kcal while there is still a portion.
    calories: grams > 0 && m.calories > 0.5 && calories < 1 ? 1 : calories,
    proteinG: r1(m.proteinG * f),
    fatG: r1(m.fatG * f),
    carbsG: r1(m.carbsG * f),
    fiberG: m.fiberG !== undefined ? r1(m.fiberG * f) : undefined,
    sugarG: m.sugarG !== undefined ? r1(m.sugarG * f) : undefined,
    micronutrients: scaleMicros(m.micronutrients, f),
  }
}

/**
 * Applies a new portion to an item. Returns the patch for the item and the base to remember for the
 * next change. When there is nothing to scale from (item at 0 g with no remembered base), only the
 * grams change: a rate cannot be invented from nothing.
 */
export function rescalePortion(
  item: FoodItem,
  newGrams: number,
  prev?: PortionBase,
): { patch: Partial<FoodItem>; base: PortionBase | undefined } {
  const grams = clampGrams(newGrams)
  const current = pick(item)
  let base: PortionBase | undefined = prev && same(prev.applied, current) ? prev : undefined
  if (!base && item.estimatedGrams > 0) base = { grams: item.estimatedGrams, macros: current, applied: current }
  if (!base) return { patch: { estimatedGrams: grams }, base: undefined }

  const scaled = scaleMacros(base, grams)
  const patch: Partial<FoodItem> = {
    estimatedGrams: grams,
    calories: scaled.calories,
    proteinG: scaled.proteinG,
    fatG: scaled.fatG,
    carbsG: scaled.carbsG,
  }
  if (scaled.fiberG !== undefined) patch.fiberG = scaled.fiberG
  if (scaled.sugarG !== undefined) patch.sugarG = scaled.sugarG
  if (scaled.micronutrients) patch.micronutrients = scaled.micronutrients
  const applied: MacroSet = { ...scaled }
  return { patch, base: { ...base, applied } }
}
