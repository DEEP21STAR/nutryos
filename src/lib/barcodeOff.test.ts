import { describe, expect, it, vi } from 'vitest'
import { lookupByBarcode, mapOffProductResponse, scaleToPortion } from '@/lib/openFoodFacts'
import { parseLabelReading } from '@/lib/cloudAi'
import { findMyFoodByBarcode, type MyFood, type MyFoodsStore } from '@/lib/myFoods'

describe('mapOffProductResponse', () => {
  it('maps a normal product (per-100 g) and scales through the portion logic', () => {
    const r = mapOffProductResponse(
      { status: 1, product: { code: '9400550006407', product_name: 'Oat Milk', nutriments: { 'energy-kcal_100g': 46, proteins_100g: 1, fat_100g: 1.5, carbohydrates_100g: 7.2, sugars_100g: '3.5' } } },
      '9400550006407',
    )
    expect(r.kind).toBe('found')
    if (r.kind !== 'found') return
    expect(r.macros).toMatchObject({ productName: 'Oat Milk', caloriesPer100g: 46, proteinPer100gG: 1, sugarPer100gG: 3.5 })
    expect(scaleToPortion(r.macros, 250).calories).toBe(115)
  })

  it('falls back to kJ when kcal is absent (kJ / 4.184)', () => {
    const r = mapOffProductResponse({ status: 1, product: { product_name: 'X', nutriments: { 'energy-kj_100g': 1000 } } }, '1')
    expect(r.kind === 'found' && Math.round(r.macros.caloriesPer100g)).toBe(239)
  })

  it('product with no energy, zero energy, or impossible energy -> no-kcal (never a silent 0)', () => {
    for (const nutriments of [{}, { 'energy-kcal_100g': 0 }, { 'energy-kcal_100g': '' }, { 'energy-kcal_100g': 5000 }]) {
      const r = mapOffProductResponse({ status: 1, product: { code: '5', product_name: 'Mystery', nutriments } }, '5')
      expect(r).toEqual({ kind: 'no-kcal', code: '5', productName: 'Mystery' })
    }
    expect(mapOffProductResponse({ status: 1, product: { code: '5' } }, '5').kind).toBe('no-kcal')
  })

  it('status 0 / missing product -> not-found; prefers product_name_en; names a nameless product by barcode', () => {
    expect(mapOffProductResponse({ status: 0 }, '9').kind).toBe('not-found')
    expect(mapOffProductResponse({ status: 1 }, '9').kind).toBe('not-found')
    const r = mapOffProductResponse({ status: 1, product: { product_name: 'Lait', product_name_en: 'Milk', nutriments: { 'energy-kcal_100g': 60 } } }, '9')
    expect(r.kind === 'found' && r.macros.productName).toBe('Milk')
    const nameless = mapOffProductResponse({ status: 1, product: { nutriments: { 'energy-kcal_100g': 60 } } }, '77')
    expect(nameless.kind === 'found' && nameless.macros.productName).toBe('Barcode 77')
  })
})

describe('lookupByBarcode (network stubbed)', () => {
  const res = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body }) as Response
  it('GETs only the product URL with the barcode digits', async () => {
    const f = vi.fn(async () => res(200, { status: 0 }))
    expect((await lookupByBarcode('9400550006407', f as unknown as typeof fetch)).kind).toBe('not-found')
    expect(f).toHaveBeenCalledTimes(1)
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit?]
    expect(url).toMatch(/^https:\/\/world\.openfoodfacts\.org\/api\/v2\/product\/9400550006407\.json\?/)
    expect(init?.method).toBeUndefined() // GET
    expect(init && 'body' in init ? init.body : undefined).toBeUndefined()
  })
  it('404 is not-found; 4xx other than 404 throws', async () => {
    expect((await lookupByBarcode('1', (async () => res(404, {})) as unknown as typeof fetch)).kind).toBe('not-found')
    await expect(lookupByBarcode('1', (async () => res(429, {})) as unknown as typeof fetch)).rejects.toThrow(/429/)
  })
})

describe('parseLabelReading', () => {
  it('uses the printed per-100 g column', () => {
    expect(parseLabelReading({ name: ' Whey ', serving_g: 30, per_100g: { kcal: 380, protein_g: 80, fat_g: 6, carbs_g: 5 } })).toEqual({
      name: 'Whey',
      per100g: { kcal: 380, proteinG: 80, fatG: 6, carbsG: 5 },
      servingG: 30,
    })
  })
  it('scales a per-serving column to per 100 g', () => {
    const r = parseLabelReading({ serving_g: 40, per_100g: null as never, per_serving: { kcal: 160, protein_g: 4, fat_g: 6, carbs_g: 22 } })
    expect(r?.per100g).toEqual({ kcal: 400, proteinG: 10, fatG: 15, carbsG: 55 })
  })
  it('rejects unreadable, zero-kcal, or impossible readings (never a silent 0)', () => {
    expect(parseLabelReading(null)).toBeNull()
    expect(parseLabelReading({ name: '', serving_g: null, per_100g: null as never, per_serving: null as never })).toBeNull()
    expect(parseLabelReading({ per_100g: { kcal: 0, protein_g: 0, fat_g: 0, carbs_g: 0 } })).toBeNull()
    expect(parseLabelReading({ per_serving: { kcal: 100, protein_g: 1, fat_g: 1, carbs_g: 1 } })).toBeNull() // no serving size
    expect(parseLabelReading({ per_100g: { kcal: 2400, protein_g: 1, fat_g: 1, carbs_g: 1 } })).toBeNull() // kJ read as kcal
    expect(parseLabelReading({ per_100g: { kcal: 300, protein_g: 80, fat_g: 40, carbs_g: 30 } })).toBeNull() // >105 g macros
  })
})

describe('findMyFoodByBarcode', () => {
  it('finds a saved food by barcode so a re-scan needs no network', () => {
    const foods: MyFood[] = [
      { id: 'a', name: 'Whey', per100g: { kcal: 380, proteinG: 80, fatG: 6, carbsG: 5 }, updatedAt: '' },
      { id: 'barcode-9400550006407', name: 'Oat Milk', barcode: '9400550006407', per100g: { kcal: 46, proteinG: 1, fatG: 1.5, carbsG: 7 }, updatedAt: '' },
    ]
    const store: MyFoodsStore = { all: () => foods, save: () => {} }
    expect(findMyFoodByBarcode('9400550006407', store)?.name).toBe('Oat Milk')
    expect(findMyFoodByBarcode('1234567890128', store)).toBeNull()
  })
})
