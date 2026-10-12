import { beforeAll, describe, expect, it, vi } from 'vitest'
import { applyFixOps, cloudOpsToFixOps, planFix } from '@/lib/fixIt'
import { loadCuratedFoods, matchCuratedFood, type CuratedFood } from '@/lib/curatedFoods'
import { resolveIdentifiedItems, type ResolveDeps } from '@/lib/resolveFoodItems'
import type { FoodItem } from '@/lib/types'

const deps: ResolveDeps = {
  myFoods: vi.fn(() => null),
  curated: vi.fn(matchCuratedFood),
  off: vi.fn(async () => null),
  aiEstimate: vi.fn(async (items) => items.map(() => null)),
  cloudAiOptIn: () => false,
}

let foods: CuratedFood[] = []
beforeAll(async () => {
  foods = await loadCuratedFoods()
})

async function meal(rows: Array<[string, number, ('added-fat')?]>): Promise<FoodItem[]> {
  const items = await resolveIdentifiedItems(rows.map(([name, g]) => ({ name, estimatedGrams: g })), deps)
  return items.map((it, i) => (rows[i][2] ? { ...it, role: rows[i][2] } : it))
}

const ser = (i: FoodItem) => JSON.stringify(i)

interface Case {
  say: string
  meal: Array<[string, number, ('added-fat')?]>
  target?: string // name fragment of the item the user picked with the target chip
  changed: string[] // name fragments of the ONLY items that may differ afterwards
  removed?: string[]
  check?: (after: FoodItem[], before: FoodItem[]) => void
}

const SHAKE: Array<[string, number, ('added-fat')?]> = [['whey protein powder', 30], ['milk', 250], ['banana', 120], ['peanut butter', 20, 'added-fat']]
const BOWL: Array<[string, number, ('added-fat')?]> = [['white rice cooked', 250], ['grilled chicken breast', 150], ['broccoli', 90], ['olive oil', 10, 'added-fat']]
const BREAKFAST: Array<[string, number, ('added-fat')?]> = [['scrambled eggs', 120], ['wholemeal toast', 70], ['milk', 250], ['butter', 10, 'added-fat']]

// The same ten scripted corrections the Playwright spec drives through the UI.
const CASES: Case[] = [
  { say: 'it was 2 scoops', meal: SHAKE, changed: ['whey'], check: (a) => expect(a.find((i) => /whey/i.test(i.name))!.estimatedGrams).toBe(60) },
  { say: 'no milk', meal: SHAKE, changed: [], removed: ['milk'] },
  { say: 'oat milk instead of milk', meal: SHAKE, changed: ['milk'], check: (a) => expect(a.some((i) => /oat milk/i.test(i.name) && i.estimatedGrams === 250 && i.source === 'curated')).toBe(true) },
  { say: 'just half the banana', meal: SHAKE, changed: ['banana'], check: (a) => expect(a.find((i) => /banana/i.test(i.name))!.estimatedGrams).toBe(60) },
  { say: 'make the rice a cup', meal: BOWL, changed: ['rice'], check: (a) => expect(a.find((i) => /rice/i.test(i.name))!.estimatedGrams).toBe(180) },
  { say: 'that was a large', meal: BOWL, target: 'chicken', changed: ['chicken'], check: (a) => expect(a.find((i) => /chicken/i.test(i.name))!.estimatedGrams).toBe(225) },
  { say: 'chicken was 200g', meal: BOWL, changed: ['chicken'], check: (a) => expect(a.find((i) => /chicken/i.test(i.name))!.estimatedGrams).toBe(200) },
  { say: 'double the broccoli', meal: BOWL, changed: ['broccoli'], check: (a) => expect(a.find((i) => /broccoli/i.test(i.name))!.estimatedGrams).toBe(180) },
  { say: 'half', meal: BOWL, target: 'rice', changed: ['rice'], check: (a) => expect(a.find((i) => /rice/i.test(i.name))!.estimatedGrams).toBe(125) },
  { say: 'no butter', meal: BREAKFAST, changed: [], removed: ['butter'] },
]

describe('Fix it: the 10 scripted corrections touch only the targeted item', () => {
  for (const c of CASES) {
    it(`"${c.say}"`, async () => {
      const before = await meal(c.meal)
      const target = c.target ? before.find((i) => i.name.toLowerCase().includes(c.target!))!.id : null
      const plan = planFix(c.say, before, foods, { targetId: target })
      expect(plan.unhandled).toEqual([])
      expect(plan.ask).toBeNull()
      const { items: after } = await applyFixOps(before, plan.ops, deps)
      for (const b of before) {
        const touched = c.changed.some((f) => b.name.toLowerCase().includes(f)) || (c.removed ?? []).some((f) => b.name.toLowerCase().includes(f))
        const a = after.find((x) => x.id === b.id)
        if (!touched) expect(a && ser(a)).toBe(ser(b)) // byte-identical
      }
      for (const f of c.removed ?? []) expect(after.some((i) => i.name.toLowerCase().includes(f))).toBe(false)
      expect(after.length).toBe(before.length - (c.removed?.length ?? 0))
      c.check?.(after, before)
      // nothing silently zero
      for (const a of after) expect(a.calories > 0 || a.source === 'unresolved').toBe(true)
    })
  }
})

describe('Fix it: more wording', () => {
  it('two clauses: "it was 2 scoops, no milk" changes whey and drops milk, banana untouched', async () => {
    const before = await meal(SHAKE)
    const plan = planFix('it was 2 scoops, no milk', before, foods)
    expect(plan.ops).toHaveLength(2)
    const { items: after } = await applyFixOps(before, plan.ops, deps)
    expect(after.map((i) => i.name)).not.toContain(before[1].name)
    const banana = before.find((i) => /banana/i.test(i.name))!
    expect(ser(after.find((i) => i.id === banana.id)!)).toBe(ser(banana))
  })

  it('a correction that names no item among several asks which one and changes nothing', async () => {
    const before = await meal(BOWL)
    const plan = planFix('make it bigger', before, foods)
    expect(plan.ops).toEqual([])
    expect(plan.ask?.candidates).toHaveLength(4)
  })

  it('with one item on the plate, "double" needs no question', async () => {
    const before = await meal([['banana', 120]])
    const plan = planFix('double', before, foods)
    const { items: after } = await applyFixOps(before, plan.ops, deps)
    expect(after[0].estimatedGrams).toBe(240)
    expect(after[0].calories).toBe(before[0].calories * 2)
  })

  it('"no sauce" with no sauce on the plate removes nothing and says so', async () => {
    const before = await meal(BOWL)
    const plan = planFix('no sauce', before, foods)
    expect(plan.ops).toEqual([])
    expect(plan.notes[0]).toMatch(/couldn't find "sauce"/)
  })

  it('wording it cannot read is handed back, not guessed', async () => {
    const before = await meal(BOWL)
    const plan = planFix('the whole thing was cooked in lard from a sunday roast', before, foods)
    expect(plan.ops).toEqual([])
    expect(plan.unhandled).toHaveLength(1)
  })

  it('"add a tablespoon of butter" adds one resolved item and leaves the rest identical', async () => {
    const before = await meal(BOWL)
    const plan = planFix('add a tablespoon of butter', before, foods)
    const { items: after } = await applyFixOps(before, plan.ops, deps)
    expect(after).toHaveLength(5)
    expect(after.slice(0, 4).map(ser)).toEqual(before.map(ser))
    expect(after[4].source).toBe('curated')
  })

  it('a replaced item the chain cannot find ends as Needs numbers, never as a silent 0', async () => {
    const before = await meal(SHAKE)
    const plan = planFix('zorbleflax instead of banana', before, foods)
    const { items: after } = await applyFixOps(before, plan.ops, deps)
    const swapped = after.find((i) => /zorbleflax/i.test(i.name))!
    expect(swapped.source).toBe('unresolved')
  })

  it('portion changes keep each item per-gram rate (rescale, no re-lookup)', async () => {
    const before = await meal(BOWL)
    const plan = planFix('chicken was 300g', before, foods)
    const { items: after } = await applyFixOps(before, plan.ops, deps)
    const b = before.find((i) => /chicken/i.test(i.name))!
    const a = after.find((i) => i.id === b.id)!
    expect(a.calories).toBe(Math.round((b.calories * 300) / 150))
    expect(a.source).toBe(b.source)
  })
})

describe('cloud-proposed operations are validated before use', () => {
  it('drops nonsense and maps the rest', async () => {
    const items = await meal(BOWL)
    const ops = cloudOpsToFixOps(
      [
        { index: 1, action: 'set_grams', grams: 180 },
        { index: 9, action: 'remove' },
        { index: 0, action: 'scale', factor: 99 },
        { index: 2, action: 'rename', name: 'cauliflower' },
        { action: 'add', name: 'soy sauce', grams: 15 },
        { index: 3, action: 'set_grams', grams: -5 },
        { index: 3, action: 'explode' },
      ],
      items,
    )
    expect(ops).toEqual([
      { kind: 'set-grams', id: items[1].id, grams: 180 },
      { kind: 'replace', id: items[2].id, name: 'cauliflower', grams: null },
      { kind: 'add', name: 'soy sauce', grams: 15 },
    ])
  })
})
