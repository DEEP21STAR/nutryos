import { describe, expect, it, vi } from 'vitest'
import { buildOffSearch, isRelevantName, lookupFoodMacros, RateLimiter } from '@/lib/openFoodFacts'
import { isPlausible, pickMedianProduct } from '@/lib/offMedian'

const p = (code: string, name: string, kcal: number, protein: number, fat: number, carbs: number) => ({
  code,
  product_name: name,
  nutriments: { 'energy-kcal_100g': kcal, proteins_100g: protein, fat_100g: fat, carbohydrates_100g: carbs },
})

describe('offMedian', () => {
  it('rejects kcal that disagrees with 4/4/9 by more than 25%', () => {
    expect(isPlausible({ kcal: 380, proteinG: 80, fatG: 5, carbsG: 6 })).toBe(true) // 389 predicted
    expect(isPlausible({ kcal: 900, proteinG: 80, fatG: 5, carbsG: 6 })).toBe(false)
    expect(isPlausible({ kcal: 0, proteinG: 0, fatG: 0, carbsG: 0 })).toBe(false)
    expect(isPlausible({ kcal: 120, proteinG: 90, fatG: 30, carbsG: 10 })).toBe(false) // sum > 105 g
  })

  it('picks the median-kcal plausible product, not the first hit', () => {
    const pick = pickMedianProduct([
      p('1', 'Whey oil blend', 880, 0, 98, 0), // plausible but extreme -> not the median
      p('2', 'Whey A', 370, 78, 4, 6),
      p('3', 'Whey B', 390, 80, 6, 5),
      p('4', 'Whey broken', 380, 0, 0, 0), // implausible: rejected
      p('5', 'Whey C', 400, 75, 8, 8),
      { code: '6', product_name: 'No numbers' },
    ])
    expect(pick?.validCount).toBe(4)
    expect(pick?.product.code).toBe('3') // sorted kcal 370,390,400,880 -> lower-middle = 390
  })

  it('applies the relevance filter when given', () => {
    const pick = pickMedianProduct([p('1', 'Gazpacho soup', 40, 1, 2, 4), p('2', 'Green olives', 145, 1, 15, 1)], (n) =>
      isRelevantName('olives', n),
    )
    expect(pick?.product.code).toBe('2')
  })
})

describe('buildOffSearch', () => {
  it('rewrites known-bad queries to terms + category', () => {
    const q = buildOffSearch('whey protien powder')
    expect(q.url).toContain('tag_0=en%3Aprotein-powders')
    expect(q.url).toContain('search_terms=whey')
    expect(q.filteredByCategory).toBe(true)
    expect(buildOffSearch('Weetbix').url).toContain('search_terms=weet-bix')
  })
  it('normalises other queries', () => {
    const q = buildOffSearch('Some Smoked Paprika Chips!')
    expect(q.terms).toBe('smoked paprika chip')
    expect(q.filteredByCategory).toBe(false)
  })
})

describe('RateLimiter', () => {
  it('grants 8 per window and refuses a 9th when it cannot wait', async () => {
    let t = 0
    const lim = new RateLimiter(8, 60_000, () => t)
    for (let i = 0; i < 8; i++) expect(await lim.acquire(0)).toBe(true)
    expect(await lim.acquire(1000)).toBe(false)
    t = 60_001
    expect(await lim.acquire(0)).toBe(true)
  })
})

describe('lookupFoodMacros', () => {
  it('returns the median product and sends no request when the limiter refuses', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ products: [p('a', 'Tasty chips', 520, 6, 30, 55), p('b', 'Chips salted', 530, 6, 32, 52), p('c', 'Chips bbq', 540, 6, 33, 52)] })),
    )
    const lim = new RateLimiter(1, 60_000)
    const first = await lookupFoodMacros('chips', { fetchImpl, limiter: lim, noCache: true })
    expect(first?.code).toBe('b')
    expect(first?.validCount).toBe(3)
    const second = await lookupFoodMacros('chips', { fetchImpl, limiter: lim, noCache: true, maxWaitMs: 0 })
    expect(second).toBeNull()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('returns null (not zeros) on a network failure or an HTML error page', async () => {
    const lim = new RateLimiter(10, 60_000)
    const boom = vi.fn(async () => {
      throw new TypeError('network')
    })
    expect(await lookupFoodMacros('x', { fetchImpl: boom, limiter: lim, noCache: true })).toBeNull()
    const html = vi.fn(async () => new Response('<html>Page temporarily unavailable</html>', { status: 503 }))
    expect(await lookupFoodMacros('x', { fetchImpl: html, limiter: lim, noCache: true })).toBeNull()
  })
})
