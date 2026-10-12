import { describe, expect, it } from 'vitest'
import { parsePlateResponse } from '@/lib/photoAnalysis'

describe('parsePlateResponse tolerates the old deployed shape and the Phase 4 shape', () => {
  it('old shape: only name + estimated_grams -> food items, note not applied', () => {
    const r = parsePlateResponse({ items: [{ name: 'chicken breast', estimated_grams: 150 }, { name: 'rice', estimated_grams: 200 }] })
    expect(r).toEqual({
      items: [
        { name: 'chicken breast', estimatedGrams: 150, kind: 'food' },
        { name: 'rice', estimatedGrams: 200, kind: 'food' },
      ],
      noteApplied: false,
    })
  })

  it('new shape: added_fat kind and note_applied are read', () => {
    const r = parsePlateResponse({ items: [{ name: 'rice', estimated_grams: 200, kind: 'food' }, { name: 'olive oil', estimated_grams: 8, kind: 'added_fat' }], note_applied: true })
    expect(r.items[1]).toEqual({ name: 'olive oil', estimatedGrams: 8, kind: 'added-fat' })
    expect(r.noteApplied).toBe(true)
  })

  it('drops nameless rows and a 0 g added-fat row (no fat is simply no line), defaults a missing food weight to 100 g', () => {
    const r = parsePlateResponse({ items: [{ name: '', estimated_grams: 5 }, { name: 'butter', estimated_grams: 0, kind: 'added_fat' }, { name: 'toast' }] })
    expect(r.items).toEqual([{ name: 'toast', estimatedGrams: 100, kind: 'food' }])
  })

  it('nothing at all gives an empty list (the caller shows the manual path)', () => {
    expect(parsePlateResponse(null).items).toEqual([])
    expect(parsePlateResponse({}).noteApplied).toBe(false)
  })
})
