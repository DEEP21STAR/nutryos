import { describe, expect, it } from 'vitest'
import { bestFuzzyMatch, editDistance, normalizeTokens } from '@/lib/fuzzyMatch'
import { loadCuratedFoods } from '@/lib/curatedFoods'

describe('normalizeTokens', () => {
  it('lowercases, strips punctuation/filler/numbers and singularises', () => {
    expect(normalizeTokens('2 Weet-Bix')).toEqual(['weet', 'bix'])
    expect(normalizeTokens('a glass of Whole Milk')).toEqual(['whole', 'milk'])
    expect(normalizeTokens('Strawberries')).toEqual(['strawberry'])
    expect(normalizeTokens('potatoes')).toEqual(['potato'])
    expect(normalizeTokens('hummus')).toEqual(['hummus'])
  })
})

describe('editDistance', () => {
  it('counts an adjacent transposition as one edit', () => {
    expect(editDistance('protien', 'protein')).toBe(1)
    expect(editDistance('yoghurt', 'yogurt')).toBe(1)
    expect(editDistance('abc', 'abc')).toBe(0)
  })
})

describe('bestFuzzyMatch against the curated table (noisy transcripts)', () => {
  const cases: Array<[string, string]> = [
    ['whey protien powder', 'whey-protein-powder'],
    ['way protein powder', 'whey-protein-powder'],
    ['weetbix', 'weet-bix'],
    ['weet bix', 'weet-bix'],
    ['2 weet-bix', 'weet-bix'],
    ['flat white coffee', 'flat-white'],
    ['a flat white', 'flat-white'],
    ['greek yogurt', 'greek-yoghurt'],
    ['bananas', 'banana'],
    ['milk', 'milk-whole'],
    ['oat milk', 'oat-milk'],
    ['peanut butter', 'peanut-butter'],
    ['chicken breast', 'chicken-breast'],
    ['mince on toast', 'mince-on-toast'],
    ['sour dough toast', 'toast-sourdough'],
    ['white rice cooked', 'rice-white'],
    ['kumara', 'kumara'],
  ]
  it.each(cases)('%s -> %s', async (query, id) => {
    const foods = await loadCuratedFoods()
    expect(bestFuzzyMatch(query, foods)?.item.id).toBe(id)
  })

  it('does not match a made-up food', async () => {
    const foods = await loadCuratedFoods()
    expect(bestFuzzyMatch('zorbleflax', foods)).toBeNull()
    expect(bestFuzzyMatch('quantum glorp', foods)).toBeNull()
  })

  it('prefers the more specific alias ("peanut butter" over "butter", "oat milk" over "milk")', async () => {
    const foods = await loadCuratedFoods()
    expect(bestFuzzyMatch('peanut butter', foods)?.item.id).not.toBe('butter')
    expect(bestFuzzyMatch('oat milk', foods)?.item.id).toBe('oat-milk')
  })
})
