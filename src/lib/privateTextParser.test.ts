import { beforeAll, describe, expect, it } from 'vitest'
import { loadCuratedFoods, type CuratedFood } from '@/lib/curatedFoods'
import { parsePrivateText } from '@/lib/privateTextParser'

let foods: CuratedFood[]
beforeAll(async () => {
  foods = await loadCuratedFoods()
})

type Exp = [phraseIncludes: string, grams: number, matchedId?: string]

const CASES: Array<[string, Exp[]]> = [
  ['two scrambled eggs, a flat white and 30 grams of whey protein powder, half a banana', [['scrambled eggs', 120, 'egg-scrambled'], ['flat white', 220, 'flat-white'], ['whey protein powder', 30, 'whey-protein-powder'], ['banana', 60, 'banana']]],
  ['I had two scrambled eggs, a flat white and thirty grams of whey protein powder', [['scrambled eggs', 120], ['flat white', 220], ['whey protein powder', 30]]],
  ['a banana', [['banana', 120, 'banana']]],
  ['half a banana', [['banana', 60]]],
  ['half an apple and a tablespoon of peanut butter', [['apple', 75, 'apple'], ['peanut butter', 20, 'peanut-butter']]],
  ['two Weet-Bix with a glass of whole milk', [['weet', 30, 'weet-bix'], ['whole milk', 250, 'milk-whole']]],
  ['2 weetbix', [['weetbix', 30, 'weet-bix']]],
  ['a cup of cooked white rice', [['white rice', 180, 'rice-white']]],
  ['one hundred and fifty grams of chicken breast and a cup of cooked white rice', [['chicken breast', 150], ['white rice', 180]]],
  ['a hundred grams of chicken breast', [['chicken breast', 100]]],
  ['200g chicken breast', [['chicken breast', 200]]],
  ['250 ml of whole milk', [['whole milk', 250, 'milk-whole']]],
  ['a cup of whole milk', [['whole milk', 250]]],
  ['two slices of sourdough toast with peanut butter', [['sourdough toast', 80, 'toast-sourdough'], ['peanut butter', 20]]],
  ['a slice of sourdough toast', [['sourdough toast', 40]]],
  ['a handful of almonds', [['almonds', 30, 'almonds']]],
  ['mince on toast and a flat white', [['mince on toast', 184, 'mince-on-toast'], ['flat white', 220]]],
  ['a protein bar and an apple', [['protein bar', 60, 'protein-bar'], ['apple', 150, 'apple']]],
  ['Greek yoghurt, a banana and a protein bar', [['greek yoghurt', 150, 'greek-yoghurt'], ['banana', 120], ['protein bar', 60]]],
  ['a glass of oat milk and a boiled egg', [['oat milk', 250, 'oat-milk'], ['boiled egg', 50, 'egg']]],
  ['two boiled eggs', [['boiled eggs', 100, 'egg']]],
  ['mac and cheese', [['mac and cheese', 250, 'mac-cheese']]],
  ['fish and chips and a can of coke', [['fish and chips', 400, 'fish-and-chips'], ['coke', 330, 'cola']]],
  ['coffee with milk', [['coffee with milk', 220, 'flat-white']]],
  ['porridge with milk and a banana', [['porridge with milk', 250, 'porridge-milk'], ['banana', 120]]],
  ['one and a half cups of cooked white rice', [['white rice', 270]]],
  ['a couple of eggs', [['eggs', 100]]],
  ['three quarters of an avocado', [['avocado', 112.5, 'avocado']]],
  ['an avocado', [['avocado', 150]]],
  ['half a dozen prawns', [['prawns', 75, 'prawns']]],
  ['2 tbsp peanut butter and 1 tsp honey', [['peanut butter', 40], ['honey', 6.7, 'honey']]],
  ['for breakfast I had a flat white this morning', [['flat white', 220]]],
  ['um I ate two lamingtons', [['lamingtons', 120, 'lamington']]],
  ['a bowl of porridge', [['porridge', 250]]],
  ['i drank a glass of orange juice', [['orange juice', 250, 'orange-juice']]],
  ['some chicken breast', [['chicken breast', 150]]],
  ['1/2 cup of oats', [['oats', 40, 'oats']]],
  ['two hundred and fifty grams of greek yoghurt', [['greek yoghurt', 250]]],
  ['a flat white then two slices of toast', [['flat white', 220], ['toast', 64]]],
]

describe('private text parser (>= 25 sentences)', () => {
  it('has at least 25 sentences', () => expect(CASES.length).toBeGreaterThanOrEqual(25))

  for (const [sentence, expected] of CASES) {
    it(`parses: ${sentence}`, () => {
      const got = parsePrivateText(sentence, foods)
      expect(got.map((g) => g.phrase)).toHaveLength(expected.length)
      expected.forEach(([phraseIncludes, grams, id], i) => {
        expect(got[i].phrase).toContain(phraseIncludes)
        expect(got[i].estimatedGrams).toBeCloseTo(grams, 0)
        if (id) expect(got[i].matchedId).toBe(id)
      })
    })
  }
})

describe('private text parser behaviour', () => {
  it('never invents grams for an unknown food: 0 so the resolver decides', () => {
    const [it] = parsePrivateText('zorbleflax', foods)
    expect(it).toMatchObject({ phrase: 'zorbleflax', estimatedGrams: 0, basis: 'unknown' })
    expect(it.matchedId).toBeUndefined()
  })

  it('uses a stated weight even for an unknown food', () => {
    const [it] = parsePrivateText('80 grams of zorbleflax', foods)
    expect(it.estimatedGrams).toBe(80)
  })

  it('returns nothing for chatter with no food words', () => {
    expect(parsePrivateText('um okay so', foods)).toEqual([])
    expect(parsePrivateText('   ', foods)).toEqual([])
  })

  it('tolerates mis-heard words via the fuzzy matcher', () => {
    const [it] = parsePrivateText('30 grams of whey protien powder', foods)
    expect(it.matchedId).toBe('whey-protein-powder')
    expect(it.estimatedGrams).toBe(30)
  })

  it('treats "to" as a mis-heard "with"', () => {
    const got = parsePrivateText('a banana to a flat white', foods)
    expect(got.map((g) => g.matchedId)).toEqual(['banana', 'flat-white'])
  })
})

describe('speech-originated text', () => {
  it('"in" separates a glass of milk from the powder, but not inside a curated name', () => {
    const got = parsePrivateText('thirty grams of whey protein powder in a glass of whole milk', foods)
    expect(got.map((g) => g.matchedId)).toEqual(['whey-protein-powder', 'milk-whole'])
  })
  it('sound-alikes only match when the text came from speech', () => {
    expect(parsePrivateText('two wheat bakes', foods)[0].matchedId).not.toBe('weet-bix')
    const [it] = parsePrivateText('two wheat bakes', foods, { fromSpeech: true })
    expect(it.matchedId).toBe('weet-bix')
    expect(it.estimatedGrams).toBe(30)
  })
  it('does not turn an unrelated word into a food even from speech', () => {
    expect(parsePrivateText('zorbleflax', foods, { fromSpeech: true })[0].matchedId).toBeUndefined()
  })
})

describe('mis-heard connectors', () => {
  it('"for the cup of" after a food is a separator; "for breakfast" is not', () => {
    const got = parsePrivateText('two wheat-bakes for the cup of whole milk', foods, { fromSpeech: true })
    expect(got.map((g) => g.matchedId)).toEqual(['weet-bix', 'milk-whole'])
    const b = parsePrivateText('a flat white for breakfast', foods)
    expect(b.map((g) => g.matchedId)).toEqual(['flat-white'])
  })
})
