import { bestFuzzyMatch, normalizeTokens } from '@/lib/fuzzyMatch'
import { loadCuratedFoods, type CuratedFood } from '@/lib/curatedFoods'
import type { IdentifiedItem } from '@/lib/ollamaVision'

/**
 * Private, deterministic text -> items parser (NUTRYOS Phase 2). No network, no model: typed text and
 * on-device transcripts both go through here first, so the default voice/text path never leaves the
 * device. "two scrambled eggs, a flat white and 30 grams of whey protein powder, half a banana"
 * becomes [{scrambled eggs, 120 g}, {flat white, 220 g}, {whey protein powder, 30 g}, {banana, 60 g}].
 *
 * Grams are never invented:
 *   - a stated weight (g, kg, oz, lb) is used as spoken;
 *   - otherwise grams come from the matched curated food's own serving data (serving.grams and the
 *     count/unit in serving.label), e.g. "1/2 avocado" = 75 g makes "an avocado" 150 g;
 *   - a spoken volume (ml, cup, tbsp, tsp) converts through ml only for liquids, using the density
 *     implied by the table's own label ("1 glass (250 ml)" = 250 g), and otherwise falls back to one
 *     table serving per quantity;
 *   - with no match and no stated weight the grams are 0, which makes the resolver apply its own
 *     defaults (serving of whatever it finds, else the item is shown as "Needs numbers").
 * Splitting happens on commas, "and", "with", "plus", "then", "in", and "to"/"for" (common mishearings of "with", not "for lunch"),
 * except inside a curated name that contains the connector ("mac and cheese", "coffee with milk").
 */

export type GramsBasis = 'stated' | 'serving-unit' | 'serving-count' | 'serving-default' | 'liquid-volume' | 'unknown'

export interface PrivateParsedItem extends IdentifiedItem {
  /** Food phrase with the quantity and unit removed. */
  phrase: string
  /** Quantity as spoken (null when none was said). */
  qty: number | null
  unit: string | null
  basis: GramsBasis
  /** id of the curated food that supplied the serving data, if any. */
  matchedId?: string
}

const ONES: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
  twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
}
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 }

/** unit -> kind + factor. weight factors are grams; volume factors are ml. */
const UNITS: Record<string, { kind: 'weight' | 'volume' | 'serve'; factor?: number }> = {
  g: { kind: 'weight', factor: 1 }, gm: { kind: 'weight', factor: 1 }, gram: { kind: 'weight', factor: 1 }, grams: { kind: 'weight', factor: 1 },
  kg: { kind: 'weight', factor: 1000 }, kilo: { kind: 'weight', factor: 1000 }, kilos: { kind: 'weight', factor: 1000 },
  kilogram: { kind: 'weight', factor: 1000 }, kilograms: { kind: 'weight', factor: 1000 },
  oz: { kind: 'weight', factor: 28.3495 }, ounce: { kind: 'weight', factor: 28.3495 }, ounces: { kind: 'weight', factor: 28.3495 },
  lb: { kind: 'weight', factor: 453.592 }, lbs: { kind: 'weight', factor: 453.592 }, pound: { kind: 'weight', factor: 453.592 }, pounds: { kind: 'weight', factor: 453.592 },
  ml: { kind: 'volume', factor: 1 }, mil: { kind: 'volume', factor: 1 }, mils: { kind: 'volume', factor: 1 },
  millilitre: { kind: 'volume', factor: 1 }, millilitres: { kind: 'volume', factor: 1 }, milliliter: { kind: 'volume', factor: 1 }, milliliters: { kind: 'volume', factor: 1 },
  l: { kind: 'volume', factor: 1000 }, litre: { kind: 'volume', factor: 1000 }, litres: { kind: 'volume', factor: 1000 },
  liter: { kind: 'volume', factor: 1000 }, liters: { kind: 'volume', factor: 1000 },
  cup: { kind: 'volume', factor: 250 }, cups: { kind: 'volume', factor: 250 },
  tbsp: { kind: 'volume', factor: 15 }, tablespoon: { kind: 'volume', factor: 15 }, tablespoons: { kind: 'volume', factor: 15 },
  tsp: { kind: 'volume', factor: 5 }, teaspoon: { kind: 'volume', factor: 5 }, teaspoons: { kind: 'volume', factor: 5 },
  slice: { kind: 'serve' }, slices: { kind: 'serve' }, serve: { kind: 'serve' }, serves: { kind: 'serve' },
  serving: { kind: 'serve' }, servings: { kind: 'serve' }, portion: { kind: 'serve' }, portions: { kind: 'serve' },
  scoop: { kind: 'serve' }, scoops: { kind: 'serve' }, handful: { kind: 'serve' }, handfuls: { kind: 'serve' },
  glass: { kind: 'serve' }, glasses: { kind: 'serve' }, bowl: { kind: 'serve' }, bowls: { kind: 'serve' },
  plate: { kind: 'serve' }, plates: { kind: 'serve' }, mug: { kind: 'serve' }, mugs: { kind: 'serve' },
  can: { kind: 'serve' }, cans: { kind: 'serve' }, bottle: { kind: 'serve' }, bottles: { kind: 'serve' },
  piece: { kind: 'serve' }, pieces: { kind: 'serve' }, pottle: { kind: 'serve' }, pottles: { kind: 'serve' },
  packet: { kind: 'serve' }, packets: { kind: 'serve' }, wedge: { kind: 'serve' }, wedges: { kind: 'serve' },
  shot: { kind: 'serve' }, shots: { kind: 'serve' }, rasher: { kind: 'serve' }, rashers: { kind: 'serve' },
}

const unitStem = (u: string) => u.replace(/(es|s)$/, '')

const LEAD_IN =
  /^(?:(?:so|um|uh|er|erm|like|well|okay|ok|then|also|and|just|i|i've|ive|i'd|id|we|had|have|has|having|ate|eat|eaten|eating|drank|drink|drunk|consumed|got|log|add|please|about|around|roughly|approximately|approx|the|my|some|this|that|another|for (?:breakfast|brekkie|lunch|dinner|tea|supper|a snack|snack|dessert|morning tea|afternoon tea)|this morning|today|tonight|yesterday|last night|earlier|at (?:breakfast|lunch|dinner|work|home|night))\b[,\s]*)+/
const TRAILER = /\s*\b(?:for (?:breakfast|brekkie|lunch|dinner|supper|a snack|snack|dessert)|this morning|today|tonight|yesterday|last night|please)\s*$/

const ZW = '​'
const connectorRe = /\b(and|with|to|in)\b/g

const protectCache = new WeakMap<readonly CuratedFood[], RegExp[]>()

/** Regexes for curated names that contain a connector, so "mac and cheese" is not split in two. */
function protectedAliasRes(foods: readonly CuratedFood[]): RegExp[] {
  let res = protectCache.get(foods)
  if (res) return res
  const seen = new Set<string>()
  res = []
  for (const f of foods) {
    for (const a of [f.name, ...f.aliases]) {
      const alias = a.toLowerCase().replace(/[^a-z0-9& ]+/g, ' ').replace(/&/g, 'and').replace(/\s+/g, ' ').trim()
      if (!/\b(and|with|n|in)\b/.test(alias) || seen.has(alias)) continue
      seen.add(alias)
      const body = alias.split(' ').map((w) => `${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?`).join('\\s+')
      res.push(new RegExp(`\\b${body}\\b`, 'g'))
    }
  }
  protectCache.set(foods, res)
  return res
}

function numberFromWords(words: string[]): { value: number; used: number } | null {
  let i = 0
  let total = 0
  let current = 0
  let any = false
  while (i < words.length) {
    const w = words[i]
    if (w in ONES) { current += ONES[w]; any = true }
    else if (w in TENS) { current += TENS[w]; any = true }
    else if (w === 'hundred' && any) { current = (current || 1) * 100 }
    else if (w === 'thousand' && any) { total += (current || 1) * 1000; current = 0 }
    else if (w === 'and' && any && i + 1 < words.length && (words[i + 1] in ONES || words[i + 1] in TENS) && current >= 100) { /* "hundred and fifty" */ }
    else break
    i++
  }
  return any ? { value: total + current, used: i } : null
}

interface Quantity {
  qty: number | null
  unit: string | null
  /** Quantity came from "a / an / one" rather than an explicit count. */
  article: boolean
  rest: string[]
}

function readQuantity(tokens: string[]): Quantity {
  let i = 0
  let qty: number | null = null
  let article = false
  const t = tokens

  const glued = /^(\d+(?:\.\d+)?)(x|[a-z]+)$/.exec(t[0] ?? '')
  const num = /^\d+(?:\.\d+)?$/.exec(t[0] ?? '')
  const frac = /^(\d+)\/(\d+)$/.exec(t[0] ?? '')
  const andHalf = /^(.+)-and-a-(half|quarter)$/.exec(t[0] ?? '')

  if (andHalf) {
    const base = /^\d+(?:\.\d+)?$/.test(andHalf[1]) ? Number(andHalf[1]) : (numberFromWords(andHalf[1].split('-'))?.value ?? 1)
    qty = base + (andHalf[2] === 'half' ? 0.5 : 0.25)
    i = 1
  } else if (glued && (glued[2] === 'x' || glued[2] in UNITS)) {
    qty = Number(glued[1])
    const unit = glued[2] === 'x' ? null : glued[2]
    return { qty, unit, article: false, rest: t.slice(1).filter(Boolean).slice(t[1] === 'of' ? 1 : 0) }
  } else if (num) {
    qty = Number(num[0])
    i = 1
    const f2 = /^(\d+)\/(\d+)$/.exec(t[1] ?? '')
    if (f2 && Number(f2[2]) > 0) { qty += Number(f2[1]) / Number(f2[2]); i = 2 }
  } else if (frac && Number(frac[2]) > 0) {
    qty = Number(frac[1]) / Number(frac[2])
    i = 1
  } else if (t[0] === 'half' || (t[0] === 'a' && t[1] === 'half')) {
    i = t[0] === 'half' ? 1 : 2
    qty = 0.5
    if (t[i] === 'a' || t[i] === 'an') {
      if (t[i + 1] === 'dozen') { qty = 6; i += 2 } else i += 1
    } else if (t[i] === 'dozen') { qty = 6; i += 1 }
    if (t[i] === 'of') i += 1
  } else if (t[0] === 'quarter' || (t[0] === 'a' && t[1] === 'quarter')) {
    i = t[0] === 'quarter' ? 1 : 2
    qty = 0.25
    if (t[i] === 'a' || t[i] === 'an') i += 1
    if (t[i] === 'of') i += 1
  } else if (/^(?:three)$/.test(t[0] ?? '') && (t[1] === 'quarters' || t[1] === 'quarter')) {
    qty = 0.75
    i = 2
    if (t[i] === 'of') i += 1
  } else if (t[0] === 'couple' || (t[0] === 'a' && t[1] === 'couple')) {
    qty = 2
    i = t[0] === 'couple' ? 1 : 2
    if (t[i] === 'of') i += 1
  } else if (t[0] === 'dozen' || (t[0] === 'a' && t[1] === 'dozen')) {
    qty = 12
    i = t[0] === 'dozen' ? 1 : 2
    if (t[i] === 'of') i += 1
  } else {
    const nw = numberFromWords(t[0] === 'a' && t[1] === 'hundred' ? ['one', ...t.slice(1)] : t[0] === 'a' && t[1] === 'thousand' ? ['one', ...t.slice(1)] : t)
    if (nw) {
      qty = nw.value
      i = t[0] === 'a' ? nw.used + 0 : nw.used
      if (t[0] === 'a') i = nw.used // "a hundred": 'a' replaced 'one'
    } else if (t[0] === 'a' || t[0] === 'an') {
      qty = 1
      article = true
      i = 1
    }
  }

  // "one" spoken as a count is still a plain count; only "a/an" is flagged as an article.
  let unit: string | null = null
  const cand = t[i]
  if (cand && cand in UNITS && qty !== null) {
    // "two cup cakes" style false units are unlikely; an actual unit is followed by "of" or the food.
    unit = cand
    i += 1
    if (t[i] === 'of') i += 1
  } else if (cand && cand in UNITS && qty === null && t[i + 1] === 'of') {
    qty = 1
    unit = cand
    i += 2
  } else if (qty !== null && t[i] === 'of') {
    i += 1
  }
  return { qty, unit, article, rest: t.slice(i) }
}

/** "1 glass (250 ml)" -> { n: 1, noun: "glass (250 ml)" }; "1/2 cup dry" -> { n: 0.5, ... }; no number -> n = 1. */
function parseLabel(label: string): { n: number; noun: string; ml: number | null } {
  const low = label.toLowerCase()
  let n = 1
  let consumed = 0
  const mixed = /^\s*(\d+)\s+(\d+)\/(\d+)/.exec(low)
  const frac = /^\s*(\d+)\/(\d+)/.exec(low)
  const plain = /^\s*(\d+(?:\.\d+)?)/.exec(low)
  if (mixed && Number(mixed[3]) > 0) { n = Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]); consumed = mixed[0].length }
  else if (frac && Number(frac[2]) > 0) { n = Number(frac[1]) / Number(frac[2]); consumed = frac[0].length }
  else if (plain) { n = Number(plain[1]); consumed = plain[0].length }
  const noun = low.slice(consumed).trim()
  const mlm = /(\d+(?:\.\d+)?)\s*ml\b/.exec(low)
  return { n: n > 0 ? n : 1, noun, ml: mlm ? Number(mlm[1]) : null }
}

/** Volume (ml) that one table serving represents, from "(250 ml)" or from a cup/tbsp/tsp label unit. */
function labelVolumeMl(label: string): number | null {
  const { n, noun, ml } = parseLabel(label)
  if (ml) return ml
  for (const w of noun.split(/[^a-z]+/)) {
    const u = UNITS[w]
    if (u?.kind === 'volume' && w !== 'ml' && u.factor) return n * u.factor
  }
  return null
}

function labelHasUnit(noun: string, unit: string): boolean {
  const stem = unitStem(unit)
  return new RegExp(`\\b${stem}(?:e?s)?\\b`).test(noun) || (stem === 'tablespoon' && /\btbsp\b/.test(noun)) || (stem === 'teaspoon' && /\btsp\b/.test(noun)) || (stem === 'tbsp' && /tablespoon/.test(noun)) || (stem === 'tsp' && /teaspoon/.test(noun))
}

const round = (g: number) => Math.round(g * 10) / 10

function resolveGrams(
  food: CuratedFood | null,
  qty: number | null,
  unit: string | null,
  article: boolean,
): { grams: number; basis: GramsBasis } {
  const u = unit ? UNITS[unit] : null
  if (u?.kind === 'weight' && qty !== null) return { grams: round(qty * (u.factor ?? 1)), basis: 'stated' }
  if (!food) {
    if (u?.kind === 'volume' && u.factor === 1 && qty !== null) return { grams: round(qty), basis: 'liquid-volume' }
    if (u?.kind === 'volume' && u.factor === 1000 && qty !== null) return { grams: round(qty * 1000), basis: 'liquid-volume' }
    return { grams: 0, basis: 'unknown' }
  }
  const { n, noun } = parseLabel(food.serving.label)
  const perLabelUnit = food.serving.grams / n
  if (qty === null) return { grams: food.serving.grams, basis: 'serving-default' }

  if (unit && u) {
    if (u.kind === 'volume') {
      // Volume -> grams through the table's own serving: grams per ml = serving.grams / the serving's
      // volume (from "(250 ml)" or its cup/tbsp/tsp unit). Not an assumed density.
      const vol = labelVolumeMl(food.serving.label)
      if (vol && u.factor) return { grams: round((qty * u.factor * food.serving.grams) / vol), basis: 'liquid-volume' }
    } else if (labelHasUnit(noun, unit)) {
      return { grams: round(qty * perLabelUnit), basis: 'serving-unit' }
    }
    return { grams: round(qty * food.serving.grams), basis: 'serving-default' }
  }
  // A bare count ("two eggs", "a banana"): items per serving come from the label's own number.
  void article
  return { grams: round(qty * perLabelUnit), basis: 'serving-count' }
}

function preprocess(text: string, foods: readonly CuratedFood[]): string {
  let s = text
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[’‘]/g, "'")
    .replace(/½/g, ' 1/2 ').replace(/¼/g, ' 1/4 ').replace(/¾/g, ' 3/4 ')
    .replace(/&/g, ' and ')
    .replace(/\s+/g, ' ')
  // Spoken compounds that contain "and" must survive the split.
  // (the ZW inside "and" keeps the splitter from seeing it; it is removed again after splitting)
  s = s.replace(/\b(hundred|thousand) and /g, `$1-an${ZW}d-`)
  s = s.replace(/\b(\d+(?:\.\d+)?|[a-z]+) and a (half|quarter)\b/g, `$1-an${ZW}d-a-$2`)
  for (const re of protectedAliasRes(foods)) {
    s = s.replace(re, (m) => m.replace(connectorRe, (w) => `${w[0]}${ZW}${w.slice(1)}`))
  }
  return s
}

const SPLIT = /\s*(?:[,;\n]+|\.(?=\s|$)|\band\b|\bwith\b|\bplus\b|\bthen\b|\balong with\b|\bas well as\b|\bfollowed by\b|\bto\b|\bin\b|\bfor\b(?!\s+(?:breakfast|brekkie|lunch|dinner|tea|supper|a snack|snack|dessert|morning tea|afternoon tea)\b))\s*/

/** Pure parser. `foods` supplies the serving data; pass the curated table. */
export function parsePrivateText(text: string, foods: readonly CuratedFood[], opts: { fromSpeech?: boolean } = {}): PrivateParsedItem[] {
  const out: PrivateParsedItem[] = []
  const pre = preprocess(text, foods)
  for (const rawSeg of pre.split(SPLIT)) {
    let seg = rawSeg.replace(new RegExp(ZW, 'g'), '').replace(/\b(hundred|thousand)-and-/g, '$1 and ').trim()
    if (!seg) continue
    seg = seg.replace(LEAD_IN, '').replace(TRAILER, '').replace(/[^a-z0-9/.'\- ]+/g, ' ').replace(/\s+/g, ' ').trim()
    if (!seg) continue
    const tokens = seg.split(' ').filter(Boolean)
    const q = readQuantity(tokens)
    const phrase = q.rest.join(' ').replace(/^(?:of|the|a|an|my|some)\s+/g, '').replace(/[.\s]+$/g, '').trim()
    if (phrase.length < 2 || !/[a-z]{2}/.test(phrase)) continue

    const match = normalizeTokens(phrase).length > 0 ? bestFuzzyMatch(phrase, foods, undefined, opts.fromSpeech === true) : null
    const { grams, basis } = resolveGrams(match?.item ?? null, q.qty, q.unit, q.article)
    out.push({
      // The matched alias, so the resolver (which re-matches by name, without sound-alike tolerance)
      // lands on the same food this parser already chose.
      name: match ? match.alias : phrase,
      estimatedGrams: grams,
      phrase,
      qty: q.qty,
      unit: q.unit,
      basis,
      ...(match ? { matchedId: match.item.id } : {}),
    })
  }
  return out
}

/** App entry: loads the curated table (lazy chunk) and parses. Resolves to [] when nothing food-like was said. */
export async function parseFoodTextPrivate(text: string, opts: { fromSpeech?: boolean } = {}): Promise<PrivateParsedItem[]> {
  const foods = await loadCuratedFoods()
  return parsePrivateText(text, foods, opts)
}
