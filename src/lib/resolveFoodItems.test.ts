import { describe, expect, it, vi } from 'vitest'
import { defaultResolveDeps, resolveIdentifiedItems, type ResolveDeps } from '@/lib/resolveFoodItems'
import { matchCuratedFood } from '@/lib/curatedFoods'
import type { OffMacros } from '@/lib/openFoodFacts'
import type { AiEstimate } from '@/lib/cloudAi'
import { itemNeedsNumbers } from '@/lib/mealGuards'

const OFF_HIT: OffMacros = {
  code: '123',
  productName: 'Zorble Snack Bar',
  caloriesPer100g: 400,
  proteinPer100gG: 10,
  fatPer100gG: 20,
  carbsPer100gG: 45,
  validCount: 6,
}

function deps(over: Partial<ResolveDeps> = {}): ResolveDeps {
  return {
    myFoods: vi.fn(() => null),
    curated: vi.fn(matchCuratedFood),
    off: vi.fn(async () => null),
    aiEstimate: vi.fn(async (items) => items.map(() => null)),
    cloudAiOptIn: () => false,
    ...over,
  }
}

describe('resolution chain', () => {
  it('step 1: My Foods wins and stops the chain', async () => {
    const d = deps({
      myFoods: vi.fn(() => ({
        item: { id: 'm1', name: 'My whey', per100g: { kcal: 380, proteinG: 80, fatG: 5, carbsG: 6 }, updatedAt: '', aliases: [] },
        alias: 'My whey',
        score: 1,
        queryCoverage: 1,
      })),
    })
    const [item] = await resolveIdentifiedItems([{ name: 'my whey', estimatedGrams: 30 }], d)
    expect(item).toMatchObject({ source: 'my-foods', name: 'My whey', calories: 114, confidence: 'high' })
    expect(d.curated).not.toHaveBeenCalled()
    expect(d.off).not.toHaveBeenCalled()
  })

  it('step 2: curated table resolves whey to 100-140 kcal per 30 g with a source ref', async () => {
    const d = deps()
    const [item] = await resolveIdentifiedItems([{ name: 'whey protien powder', estimatedGrams: 30 }], d)
    expect(item.source).toBe('curated')
    expect(item.calories).toBeGreaterThanOrEqual(100)
    expect(item.calories).toBeLessThanOrEqual(140)
    expect(item.sourceRef).toMatch(/^AFCD F\d+/)
    expect(d.off).not.toHaveBeenCalled()
  })

  it('step 2: water is a confirmed 0, not a "needs numbers" item', async () => {
    const [item] = await resolveIdentifiedItems([{ name: 'glass of water', estimatedGrams: 250 }], deps())
    expect(item.calories).toBe(0)
    expect(item.zeroConfirmed).toBe(true)
    expect(itemNeedsNumbers(item)).toBe(false)
  })

  it('step 3: Open Food Facts is used only when the table misses', async () => {
    const d = deps({ off: vi.fn(async () => OFF_HIT) })
    const [item] = await resolveIdentifiedItems([{ name: 'zorble snack bar', estimatedGrams: 50 }], d)
    expect(d.off).toHaveBeenCalledWith('zorble snack bar')
    expect(item).toMatchObject({ source: 'off', calories: 200, offCode: '123', confidence: 'medium' })
    expect(item.sourceRef).toContain('median of 6')
  })

  it('step 4: AI estimate is NOT called without opt-in -> item needs numbers', async () => {
    const d = deps()
    const [item] = await resolveIdentifiedItems([{ name: 'zorbleflax', estimatedGrams: 100 }], d)
    expect(d.aiEstimate).not.toHaveBeenCalled()
    expect(item.source).toBe('unresolved')
    expect(itemNeedsNumbers(item)).toBe(true)
  })

  it('step 4: with opt-in, unresolved items get one batched AI estimate, badged as such', async () => {
    const est: AiEstimate = { name: 'zorbleflax', calories: 210, proteinG: 4, fatG: 9, carbsG: 28, confidence: 'low' }
    const d = deps({ cloudAiOptIn: () => true, aiEstimate: vi.fn(async () => [est]) })
    const items = await resolveIdentifiedItems(
      [
        { name: 'banana', estimatedGrams: 120 },
        { name: 'zorbleflax', estimatedGrams: 100 },
      ],
      d,
    )
    expect(d.aiEstimate).toHaveBeenCalledTimes(1)
    expect(d.aiEstimate).toHaveBeenCalledWith([{ name: 'zorbleflax', grams: 100 }])
    expect(items[0].source).toBe('curated')
    expect(items[1]).toMatchObject({ source: 'ai-estimate', calories: 210, confidence: 'low' })
  })

  it('step 4: an AI answer of "no estimate" (null) leaves the item as needs-numbers', async () => {
    const d = deps({ cloudAiOptIn: () => true })
    const [item] = await resolveIdentifiedItems([{ name: 'zorbleflax', estimatedGrams: 100 }], d)
    expect(d.aiEstimate).toHaveBeenCalledTimes(1)
    expect(itemNeedsNumbers(item)).toBe(true)
  })

  it('a failing step falls through instead of producing zeros', async () => {
    const d = deps({
      curated: vi.fn(async () => {
        throw new Error('chunk failed to load')
      }),
      off: vi.fn(async () => OFF_HIT),
    })
    const [item] = await resolveIdentifiedItems([{ name: 'banana', estimatedGrams: 100 }], d)
    expect(item.source).toBe('off')
    expect(item.calories).toBeGreaterThan(0)
  })

  it('never returns a 0-kcal item without either a confirmed zero or the unresolved flag', async () => {
    const names = ['whey protein powder', 'milk', 'banana', 'zorbleflax', 'water', 'diet coke', '']
    const items = await resolveIdentifiedItems(names.map((name) => ({ name, estimatedGrams: 100 })), deps())
    for (const it of items) {
      if (it.calories === 0) expect(it.zeroConfirmed === true || it.source === 'unresolved').toBe(true)
    }
  })

  it('the default deps keep cloud AI off', () => {
    expect(defaultResolveDeps.cloudAiOptIn()).toBe(false)
  })
})
