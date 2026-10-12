import { bestFuzzyMatch, normalizeTokens, tokenSimilarity } from '@/lib/fuzzyMatch'
import { gramsFromQuantityText, parsePrivateText } from '@/lib/privateTextParser'
import type { CuratedFood } from '@/lib/curatedFoods'
import { rescalePortion } from '@/lib/portion'
import { defaultResolveDeps, resolveIdentifiedItems, type ResolveDeps } from '@/lib/resolveFoodItems'
import type { FoodItem } from '@/lib/types'

/**
 * "Fix it" in plain words (NUTRYOS Phase 4). Private and deterministic: no network, no model. It reads
 * short corrections such as "it was 2 scoops, no milk", "make the rice a cup", "oat milk instead of
 * milk", "chicken was 150g", "double the broccoli", "that was a large" and turns each clause into an
 * operation on ONE item. Only the targeted item is touched: every other item keeps the very same
 * object (so its numbers are byte-identical), and an item whose grams change is rescaled with
 * portion.ts (per-gram rates kept). A replaced or added item goes back through the resolution chain
 * (resolveFoodItems.ts), so its badge says where the new numbers came from; it can end as "Needs
 * numbers" but never as a silent 0.
 *
 * What it will not guess: a correction that names no item when several could be meant becomes a
 * question ("Which item?"), and wording it cannot read is handed back as `unhandled` so the UI can
 * offer the cloud helper (only after the user's consent) instead of changing something at random.
 */

export type FixOp =
  | { kind: 'set-grams'; id: string; grams: number }
  | { kind: 'scale'; id: string; factor: number }
  | { kind: 'remove'; id: string }
  | { kind: 'replace'; id: string; name: string; grams: number | null }
  | { kind: 'add'; name: string; grams: number }

export interface FixTargetOption {
  id: string
  name: string
}

export interface FixPlan {
  ops: FixOp[]
  /** Clauses this module could not read. */
  unhandled: string[]
  /** A clause that needs to know WHICH item; the UI asks, then re-plans with `targetId`. */
  ask: { clause: string; candidates: FixTargetOption[] } | null
  /** Plain-words remarks ("I couldn't find "milk" in this meal"). */
  notes: string[]
}

const LEAD =
  /^(?:(?:actually|sorry|um|uh|er|erm|so|well|ok|okay|no wait|wait|and|but|also|hmm|oh|yeah|yes|please)\b[,\s]*)+/
const IMPLICIT =
  /^(?:(?:it|that|this|they|those|these)\s+(?:was|were|is|are|should be|should have been|would be)|it's|its|that's|thats|i(?:'d| had)? (?:only |just |actually )?(?:had|ate|have had|drank|used|put)|i (?:only |just )?(?:had|ate|drank|used)|make (?:it|that|this|them)|make|made|change (?:it|that|this)(?: to)?|set (?:it|that|this)(?: to)?|was|were|only|just|about|around|roughly|approximately|approx|more like|like)\b\s*/

const FILLERS = new Set([
  'the', 'it', 'its', 'that', 'this', 'these', 'those', 'they', 'was', 'were', 'is', 'are', 'be', 'been', 'should', 'would', 'to',
  'make', 'made', 'only', 'just', 'about', 'around', 'roughly', 'approximately', 'approx', 'actually', 'i', 'my', 'had', 'have',
  'has', 'ate', 'eat', 'drank', 'really', 'very', 'like', 'more', 'less', 'extra',
])

const NUMBER_WORDS = new Set([
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen',
  'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty',
  'ninety', 'hundred', 'couple', 'dozen',
])
const SCALE_WORDS: Record<string, number> = { half: 0.5, double: 2, twice: 2, triple: 3, third: 1 / 3, quarter: 0.25 }
const SIZE_WORDS: Record<string, number> = {
  tiny: 0.5, small: 0.75, smaller: 0.75, little: 0.75, light: 0.75, medium: 1, regular: 1, normal: 1, large: 1.5, larger: 1.25,
  big: 1.5, bigger: 1.25, generous: 1.5, heaped: 1.5, huge: 2, giant: 2,
}
const UNIT_WORDS = new Set([
  'g', 'gm', 'gram', 'kg', 'kilo', 'kilogram', 'oz', 'ounce', 'lb', 'pound', 'ml', 'l', 'litre', 'liter', 'tbsp', 'tsp', 'tablespoon',
  'teaspoon', 'cup', 'scoop', 'slice', 'serve', 'serving', 'portion', 'handful', 'glass', 'bowl', 'plate', 'mug', 'can', 'bottle',
  'piece', 'pottle', 'packet', 'wedge', 'shot', 'rasher',
])

const PRESET_WORD_RE = /\b(half|double|twice|triple|a third|third|quarter|three quarters|three-quarters)\b/

const SPLIT_CLAUSES = /\s*(?:[,;\n]+|\.(?=\s|$)|\bbut\b|\bthen\b|\band\b(?=\s+(?:no|without|skip|remove|add|plus|the|make|change|it|that|i)\b))\s*/

function clean(raw: string): string {
  let s = raw
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[’‘]/g, "'")
    .replace(/½/g, ' 1/2 ').replace(/¼/g, ' 1/4 ').replace(/¾/g, ' 3/4 ')
    .replace(/[^a-z0-9/.'&\- ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  for (let i = 0; i < 4; i++) {
    const before = s
    s = s.replace(LEAD, '').replace(IMPLICIT, '').trim()
    if (s === before) break
  }
  return s
}

function stem(t: string): string {
  return normalizeTokens(t)[0] ?? t
}

/** Words of `text` that could be a food name: no numbers, units, quantity/size words or fillers. */
function contentTokens(text: string): string[] {
  const out: string[] = []
  for (const raw of text.toLowerCase().split(/[^a-z0-9']+/)) {
    if (!raw || /^\d/.test(raw)) continue
    if (FILLERS.has(raw) || NUMBER_WORDS.has(raw) || raw in SCALE_WORDS || raw in SIZE_WORDS) continue
    if (['a', 'an', 'of', 'and', 'with', 'in', 'on', 'not', 'no', 'any', 'some', 'bit', 'lot', 'much', 'instead', 'for'].includes(raw)) continue
    const st = stem(raw)
    if (UNIT_WORDS.has(raw) || UNIT_WORDS.has(st) || UNIT_WORDS.has(raw.replace(/s$/, ''))) continue
    const norm = normalizeTokens(raw)
    if (norm.length === 0) continue
    out.push(norm[0])
  }
  return out
}

interface Named {
  item: FoodItem
  /** Tokens of the clause that matched this item (to strip when what is left is the quantity). */
  matched: Set<string>
  score: number
}

/** The item a phrase names, by fuzzy token overlap with each item's name; null when none clearly does. */
function findNamed(phrase: string, items: readonly FoodItem[]): Named | null {
  const content = contentTokens(phrase)
  if (content.length === 0) return null
  let best: { item: FoodItem; matched: Set<string>; score: number; spec: number; idx: number } | null = null
  items.forEach((item, idx) => {
    const itemTokens = normalizeTokens(item.name)
    if (itemTokens.length === 0) return
    const matched = new Set<string>()
    for (const ct of content) {
      if (itemTokens.some((it) => tokenSimilarity(ct, it) >= 0.8)) matched.add(ct)
    }
    if (matched.size === 0) return
    const score = matched.size / content.length
    const spec = matched.size / itemTokens.length
    if (!best || score > best.score || (score === best.score && (spec > best.spec || (spec === best.spec && idx < best.idx)))) {
      best = { item, matched, score, spec, idx }
    }
  })
  const b = best as { item: FoodItem; matched: Set<string>; score: number } | null
  if (!b || b.score < 0.5) return null
  return { item: b.item, matched: b.matched, score: b.score }
}

/** What is left of a clause once the item's name and filler words are removed: "a cup", "2 scoops", "150g". */
function quantityText(clauseText: string, named: Named | null): string {
  const out: string[] = []
  for (const raw of clauseText.split(' ').filter(Boolean)) {
    const t = raw.replace(/[^a-z0-9/.'-]/g, '')
    if (!t) continue
    if (FILLERS.has(t)) continue
    if (named && /[a-z]/.test(t) && !(t in SCALE_WORDS) && !NUMBER_WORDS.has(t)) {
      const st = normalizeTokens(t)[0]
      if (st && named.matched.has(st) && !UNIT_WORDS.has(t) && !UNIT_WORDS.has(st)) continue
    }
    out.push(t)
  }
  return out.join(' ')
}

function hasQuantity(c: string): boolean {
  if (/\d/.test(c)) return true
  const toks = c.split(/[^a-z']+/).filter(Boolean)
  return toks.some((t) => NUMBER_WORDS.has(t) || UNIT_WORDS.has(t) || UNIT_WORDS.has(t.replace(/(es|s)$/, '')))
}

export interface PlanOptions {
  /** The item the user pointed at (Fix-it target chip); used when the words name no item. */
  targetId?: string | null
}

type ClauseResult = {
  ops?: FixOp[]
  unhandled?: string
  ask?: { clause: string; candidates: FixTargetOption[] }
  notes?: string[]
}

function curatedFor(item: FoodItem, foods: readonly CuratedFood[]): CuratedFood | null {
  return bestFuzzyMatch(item.name, foods)?.item ?? null
}

const round1 = (n: number) => Math.round(n * 10) / 10

function planClause(raw: string, items: readonly FoodItem[], foods: readonly CuratedFood[], opts: PlanOptions): ClauseResult {
  const c = clean(raw)
  if (!c) return {}
  const optionsOf = () => items.map((i) => ({ id: i.id, name: i.name }))
  const explicit = opts.targetId ? (items.find((i) => i.id === opts.targetId) ?? null) : null

  // 1. REMOVE: "no milk", "without the cheese", "skip the sauce", "didn't have any rice".
  const rem =
    /^(?:no more|no|without|skip|hold|remove|delete|drop|take (?:off|out)|leave out|didn'?t (?:have|add|eat|use|put|get)|did not (?:have|add|eat|use|put|get)|never (?:had|added)|there (?:was|were) no|there wasn'?t any)\s+(?:any |the |a |an |my |that |those |extra )*(.+)$/.exec(c)
  if (rem) {
    const named = findNamed(rem[1], items)
    if (named) return { ops: [{ kind: 'remove', id: named.item.id }] }
    return { notes: [`I couldn't find "${rem[1].trim()}" in this meal, so nothing was removed.`] }
  }

  // 2. SWAP: "oat milk instead of milk", "swap the rice for noodles", "it was oat milk not milk".
  let swapNew: string | null = null
  let swapOld: string | null = null
  let m = /^(.+?)\s+(?:instead of|rather than|and not|but not|not)\s+(.+)$/.exec(c)
  if (m) {
    swapNew = m[1]
    swapOld = m[2]
  } else if ((m = /^(?:swap|replace|change|switch|substitute)\s+(?:the |my )?(.+?)\s+(?:for|with|to|by)\s+(.+)$/.exec(c))) {
    swapOld = m[1]
    swapNew = m[2]
  } else if ((m = /^(?:the |my )?(.+?)\s+(?:was|were|is|are) actually\s+(.+)$/.exec(c))) {
    swapOld = m[1]
    swapNew = m[2]
  }
  if (swapNew && swapOld) {
    const named = findNamed(swapOld, items)
    if (!named) return { unhandled: raw.trim() }
    const parsed = parsePrivateText(swapNew, foods)[0]
    const name = parsed?.name ?? contentTokens(swapNew).join(' ')
    if (!name) return { unhandled: raw.trim() }
    const grams = parsed && parsed.qty !== null && parsed.basis !== 'unknown' && parsed.estimatedGrams > 0 ? parsed.estimatedGrams : null
    return { ops: [{ kind: 'replace', id: named.item.id, name, grams }] }
  }

  // 3. ADD: "add a tablespoon of butter", "plus a banana", "forgot the toast".
  const add = /^(?:add(?:ed)?|plus|also (?:had|added|ate)|i also (?:had|ate|added)|forgot(?: to add| the)?|there was also)\s+(.+)$/.exec(c)
  if (add) {
    const parsed = parsePrivateText(add[1], foods)
    if (parsed.length === 0) return { unhandled: raw.trim() }
    return { ops: parsed.map((p) => ({ kind: 'add' as const, name: p.name, grams: p.estimatedGrams })) }
  }

  const named = findNamed(c, items)
  const qtyish = hasQuantity(c)

  /** Which item a nameless correction means: the chip the user picked, else the only item, else ask. */
  const pickTarget = (unit: string | null): FoodItem | 'ask' => {
    if (named) return named.item
    if (explicit) return explicit
    if (unit) {
      const withUnit = items.filter((it) => {
        const label = curatedFor(it, foods)?.serving.label.toLowerCase() ?? ''
        const u = unit.replace(/(es|s)$/, '')
        return label.includes(u)
      })
      if (withUnit.length === 1) return withUnit[0]
    }
    if (items.length === 1) return items[0]
    return 'ask'
  }

  // 4. SCALE words: "half", "double the broccoli", "banana was half" (not "half a cup": that is a quantity).
  const sw = PRESET_WORD_RE.exec(c)
  if (sw && !/\bhalf (?:a|an)\b/.test(c) && !(qtyish && /\d|\b(?:cup|scoop|slice|tbsp|tsp|gram|ml)/.test(c))) {
    const w = sw[1]
    const factor = w === 'three quarters' || w === 'three-quarters' ? 0.75 : w === 'a third' ? 1 / 3 : (SCALE_WORDS[w] ?? 0)
    if (factor > 0) {
      const t = pickTarget(null)
      if (t === 'ask') return { ask: { clause: raw.trim(), candidates: optionsOf() } }
      return { ops: [{ kind: 'scale', id: t.id, factor }] }
    }
  }

  // 5. SIZE and MORE/LESS words: "that was a large", "a bit more rice", "smaller".
  if (!qtyish) {
    let factor: number | null = null
    if (/\bextra large\b/.test(c)) factor = 1.75
    else if (/\b(?:a lot more|much more|loads more|heaps more)\b/.test(c)) factor = 1.5
    else if (/\b(?:a lot less|much less)\b/.test(c)) factor = 0.5
    else if (/\b(?:a bit more|a little more|slightly more|more|extra)\b/.test(c)) factor = 1.25
    else if (/\b(?:a bit less|a little less|slightly less|less)\b/.test(c)) factor = 0.75
    else {
      for (const tok of c.split(/[^a-z]+/)) if (tok in SIZE_WORDS) factor = SIZE_WORDS[tok]
    }
    if (factor !== null) {
      const t = pickTarget(null)
      if (t === 'ask') return { ask: { clause: raw.trim(), candidates: optionsOf() } }
      return { ops: [{ kind: 'scale', id: t.id, factor }] }
    }
  }

  // 6. QUANTITY: "2 scoops", "make the rice a cup", "chicken was 150g", "the milk was 300ml".
  if (qtyish) {
    const qtyText = quantityText(c, named)
    const probe = gramsFromQuantityText(qtyText, null)
    if (!probe) return { unhandled: raw.trim() }
    if (!named && contentTokens(c).length > 0 && !explicit && items.length > 1) {
      // Words that name a food we do not have ("2 scoops of banana split"): do not guess.
      return { unhandled: raw.trim() }
    }
    const t = pickTarget(probe.unit)
    if (t === 'ask') return { ask: { clause: raw.trim(), candidates: optionsOf() } }
    const g = gramsFromQuantityText(qtyText, curatedFor(t, foods))
    if (!g || !(g.grams > 0)) return { unhandled: raw.trim() }
    return { ops: [{ kind: 'set-grams', id: t.id, grams: round1(g.grams) }] }
  }

  // 7. "that was oat milk" with a chosen (or only) item: rename and re-resolve that one item.
  if (!named && contentTokens(c).length > 0 && (explicit || items.length === 1)) {
    const target = explicit ?? items[0]
    const parsed = parsePrivateText(c, foods)[0]
    if (parsed?.matchedId) return { ops: [{ kind: 'replace', id: target.id, name: parsed.name, grams: null }] }
  }

  return { unhandled: raw.trim() }
}

/** Reads a correction and says what it would change. Pure. */
export function planFix(text: string, items: readonly FoodItem[], foods: readonly CuratedFood[], opts: PlanOptions = {}): FixPlan {
  const plan: FixPlan = { ops: [], unhandled: [], ask: null, notes: [] }
  const clauses = text
    .split(SPLIT_CLAUSES)
    .map((s) => s.trim())
    .filter(Boolean)
  for (const clause of clauses) {
    const r = planClause(clause, items, foods, opts)
    if (r.ops) plan.ops.push(...r.ops)
    if (r.unhandled) plan.unhandled.push(r.unhandled)
    if (r.ask && !plan.ask) plan.ask = r.ask
    if (r.notes) plan.notes.push(...r.notes)
  }
  return plan
}

export interface FixResult {
  items: FoodItem[]
  /** One plain-words line per change, e.g. "Whey protein powder: 30 g → 60 g (111 → 222 kcal)". */
  changes: string[]
  /** Ids whose grams were reset by this fix (the UI re-bases the portion stepper on them). */
  touched: string[]
}

const kcal = (i: FoodItem) => `${Math.round(i.calories)} kcal`

/**
 * Applies operations. Items not named by an operation come back as the SAME objects. Replaced and added
 * items are re-resolved through the Phase 1 chain, and only those.
 */
export async function applyFixOps(items: readonly FoodItem[], ops: readonly FixOp[], deps: ResolveDeps = defaultResolveDeps): Promise<FixResult> {
  let cur = [...items]
  const changes: string[] = []
  const touched: string[] = []
  const regram = (id: string, grams: number, how: string) => {
    const item = cur.find((i) => i.id === id)
    if (!item) return
    const g = Math.max(1, Math.round(grams * 10) / 10)
    if (Math.abs(g - item.estimatedGrams) < 0.05) {
      changes.push(`${item.name}: already ${item.estimatedGrams} g, left as it is`)
      return
    }
    const { patch } = rescalePortion(item, g)
    const next = { ...item, ...patch }
    cur = cur.map((i) => (i.id === id ? next : i))
    touched.push(id)
    changes.push(`${item.name}: ${item.estimatedGrams} g → ${g} g${how} (${kcal(item)} → ${kcal(next)})`)
  }
  for (const op of ops) {
    if (op.kind === 'set-grams') regram(op.id, op.grams, '')
    else if (op.kind === 'scale') {
      const item = cur.find((i) => i.id === op.id)
      if (item) regram(op.id, item.estimatedGrams * op.factor, ` (×${Math.round(op.factor * 100) / 100})`)
    } else if (op.kind === 'remove') {
      const item = cur.find((i) => i.id === op.id)
      if (item) {
        cur = cur.filter((i) => i.id !== op.id)
        changes.push(`Removed ${item.name} (${kcal(item)})`)
      }
    } else if (op.kind === 'replace') {
      const item = cur.find((i) => i.id === op.id)
      if (!item) continue
      const [resolved] = await resolveIdentifiedItems([{ name: op.name, estimatedGrams: op.grams ?? item.estimatedGrams }], deps)
      const next: FoodItem = { ...resolved, id: item.id, ...(item.role ? { role: item.role } : {}) }
      cur = cur.map((i) => (i.id === op.id ? next : i))
      touched.push(item.id)
      changes.push(`${item.name} → ${next.name}, ${next.estimatedGrams} g (${kcal(item)} → ${next.source === 'unresolved' ? 'needs numbers' : kcal(next)})`)
    } else if (op.kind === 'add') {
      const [resolved] = await resolveIdentifiedItems([{ name: op.name, estimatedGrams: op.grams }], deps)
      cur = [...cur, resolved]
      touched.push(resolved.id)
      changes.push(`Added ${resolved.name}, ${resolved.estimatedGrams} g (${resolved.source === 'unresolved' ? 'needs numbers' : kcal(resolved)})`)
    }
  }
  return { items: cur, changes, touched }
}

/** Raw operation as the edge function's "fix" mode returns it (index into the items that were sent). */
export interface CloudFixOp {
  index?: number
  action?: string
  grams?: number
  factor?: number
  name?: string
}

/** Validates cloud-proposed operations and maps them to FixOps. Anything odd is dropped, never applied. */
export function cloudOpsToFixOps(raw: readonly CloudFixOp[] | undefined, items: readonly FoodItem[]): FixOp[] {
  const out: FixOp[] = []
  for (const r of raw ?? []) {
    const item = Number.isInteger(r.index) ? items[r.index as number] : undefined
    const name = typeof r.name === 'string' ? r.name.trim().slice(0, 80) : ''
    if (r.action === 'add') {
      if (name && Number(r.grams) > 0 && Number(r.grams) <= 3000) out.push({ kind: 'add', name, grams: Number(r.grams) })
      continue
    }
    if (!item) continue
    if (r.action === 'remove') out.push({ kind: 'remove', id: item.id })
    else if (r.action === 'set_grams' && Number(r.grams) > 0 && Number(r.grams) <= 3000) out.push({ kind: 'set-grams', id: item.id, grams: Number(r.grams) })
    else if (r.action === 'scale' && Number(r.factor) > 0 && Number(r.factor) <= 10) out.push({ kind: 'scale', id: item.id, factor: Number(r.factor) })
    else if (r.action === 'rename' && name) out.push({ kind: 'replace', id: item.id, name, grams: Number(r.grams) > 0 && Number(r.grams) <= 3000 ? Number(r.grams) : null })
  }
  return out
}
