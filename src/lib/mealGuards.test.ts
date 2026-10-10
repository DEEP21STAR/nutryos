import { describe, expect, it } from 'vitest'
import { badgeLabel, canLogMeal, itemNeedsNumbers } from '@/lib/mealGuards'
import type { FoodItem } from '@/lib/types'

const item = (over: Partial<FoodItem>): FoodItem => ({
  id: Math.random().toString(36),
  name: 'Banana',
  estimatedGrams: 120,
  calories: 114,
  proteinG: 1.7,
  fatG: 0.4,
  carbsG: 24,
  source: 'curated',
  confidence: 'high',
  ...over,
})

describe('mealGuards', () => {
  it('a named 0-kcal item without confirmation needs numbers', () => {
    expect(itemNeedsNumbers(item({ calories: 0, source: 'unresolved' }))).toBe(true)
    expect(itemNeedsNumbers(item({ calories: 0, source: undefined }))).toBe(true) // e.g. a blank barcode product
    expect(itemNeedsNumbers(item({ calories: 0, zeroConfirmed: true, source: 'user' }))).toBe(false)
    expect(itemNeedsNumbers(item({ name: '  ', calories: 0 }))).toBe(false) // empty rows are dropped on log
  })

  it('blocks logging while any named item needs numbers', () => {
    expect(canLogMeal([item({}), item({ name: 'Zorbleflax', calories: 0, source: 'unresolved' })])).toBe(false)
    expect(canLogMeal([item({}), item({ name: 'Zorbleflax', calories: 0, zeroConfirmed: true, source: 'user' })])).toBe(true)
    expect(canLogMeal([item({}), item({ name: 'Zorbleflax', calories: 90, source: 'user' })])).toBe(true)
    expect(canLogMeal([])).toBe(false)
    expect(canLogMeal([item({ name: '' , calories: 0})])).toBe(false)
  })

  it('labels badges by source', () => {
    expect(badgeLabel(item({}))).toBe('NZ/AU food table')
    expect(badgeLabel(item({ source: 'ai-estimate' }))).toBe('AI estimate')
    expect(badgeLabel(item({ source: 'off' }))).toBe('Open Food Facts')
    expect(badgeLabel(item({ source: 'my-foods' }))).toBe('My Foods')
    expect(badgeLabel(item({ calories: 0, source: 'unresolved' }))).toBe('Needs numbers')
    expect(badgeLabel(item({ source: undefined, offCode: undefined }))).toBe('Saved meal')
  })
})
