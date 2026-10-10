import { describe, expect, it } from 'vitest'
import { rescalePortion, scaleMacros, type PortionBase } from '@/lib/portion'
import type { FoodItem } from '@/lib/types'

const banana = (): FoodItem => ({
  id: 'b', name: 'Banana', estimatedGrams: 120, calories: 107, proteinG: 1.3, fatG: 0.2, carbsG: 24.4, fiberG: 2.4, sugarG: 15.1,
})

function apply(item: FoodItem, grams: number, base?: PortionBase) {
  const r = rescalePortion(item, grams, base)
  return { item: { ...item, ...r.patch }, base: r.base }
}

describe('portion rescale', () => {
  it('doubling grams doubles every macro (within rounding)', () => {
    const { item } = apply(banana(), 240)
    expect(item.estimatedGrams).toBe(240)
    expect(item.calories).toBe(214)
    expect(item.proteinG).toBeCloseTo(2.6, 1)
    expect(item.fatG).toBeCloseTo(0.4, 1)
    expect(item.carbsG).toBeCloseTo(48.8, 1)
    expect(item.fiberG).toBeCloseTo(4.8, 1)
    expect(item.sugarG).toBeCloseTo(30.2, 1)
  })

  it('halving then restoring returns the original numbers exactly (no rounding drift)', () => {
    const a = apply(banana(), 60)
    expect(a.item.calories).toBe(54)
    const b = apply(a.item, 120, a.base)
    expect(b.item).toMatchObject({ calories: 107, proteinG: 1.3, fatG: 0.2, carbsG: 24.4, fiberG: 2.4, sugarG: 15.1 })
  })

  it('many slider steps stay proportional to the original base', () => {
    let cur = apply(banana(), 130)
    for (const g of [140, 200, 75, 310, 45, 120]) cur = apply(cur.item, g, cur.base)
    expect(cur.item.calories).toBe(107)
    expect(cur.item.carbsG).toBe(24.4)
  })

  it('0 g gives 0 macros but the original rate survives for the next move', () => {
    const z = apply(banana(), 0)
    expect(z.item).toMatchObject({ estimatedGrams: 0, calories: 0, proteinG: 0, carbsG: 0 })
    const back = apply(z.item, 120, z.base)
    expect(back.item.calories).toBe(107)
  })

  it('a manual macro override is kept and later portion changes scale from the edited numbers', () => {
    const a = apply(banana(), 120)
    const edited = { ...a.item, calories: 200 } // user typed 200 kcal for 120 g
    const b = apply(edited, 60, a.base)
    expect(b.item.calories).toBe(100)
    expect(b.item.proteinG).toBeCloseTo(0.65, 1) // un-edited fields keep their own rate
  })

  it('a no-op portion value does not disturb numbers', () => {
    expect(apply(banana(), 120).item.calories).toBe(107)
  })

  it('an item with no numbers stays at 0 and does not gain invented values', () => {
    const none: FoodItem = { id: 'u', name: 'Zorble', estimatedGrams: 100, calories: 0, proteinG: 0, fatG: 0, carbsG: 0, source: 'unresolved' }
    expect(apply(none, 250).item).toMatchObject({ estimatedGrams: 250, calories: 0, proteinG: 0 })
  })

  it('nothing to scale from (0 g, no base): only grams change', () => {
    const zero: FoodItem = { ...banana(), estimatedGrams: 0, calories: 0, proteinG: 0, fatG: 0, carbsG: 0, fiberG: undefined, sugarG: undefined }
    const r = rescalePortion(zero, 80)
    expect(r.patch).toEqual({ estimatedGrams: 80 })
  })

  it('micronutrients scale with the portion; negative/NaN grams clamp to 0', () => {
    const it: FoodItem = { ...banana(), micronutrients: { vitaminCMg: 8.7, potassiumMg: 358 } }
    const d = apply(it, 240).item
    expect(d.micronutrients?.vitaminCMg).toBeCloseTo(17.4, 2)
    expect(apply(banana(), -5).item.estimatedGrams).toBe(0)
    expect(apply(banana(), Number.NaN).item.estimatedGrams).toBe(0)
  })

  it('scaleMacros keeps a tiny non-zero value from rounding to a silent 0 kcal', () => {
    const base: PortionBase = { grams: 100, macros: { calories: 40, proteinG: 0, fatG: 0, carbsG: 10 }, applied: { calories: 40, proteinG: 0, fatG: 0, carbsG: 10 } }
    expect(scaleMacros(base, 1).calories).toBe(1)
  })
})
