/**
 * Tolerant food-name matching for typed and transcribed text (NUTRYOS Phase 1, addendum rule 3).
 * Used by My Foods, the curated NZ/AU table and the Open Food Facts query rules, so a noisy
 * transcript ("whey protien powder", "weetbix", "flat white coffee") still lands on the right entry.
 *
 * Method: normalise (case, accents, punctuation, filler words, plurals), then align every alias
 * token to its closest query token by Damerau-Levenshtein distance. An alias only matches when ALL
 * of its tokens are found; the score rewards similarity, how much of the query the alias covers,
 * and alias specificity (so "peanut butter" beats "butter" for "peanut butter").
 */

const FILLER = new Set([
  'a', 'an', 'the', 'of', 'some', 'my', 'few', 'couple', 'bit', 'and', 'on', 'with', 'in',
  'cup', 'cups', 'glass', 'glasses', 'bowl', 'bowls', 'piece', 'pieces', 'slice', 'slices',
  'serving', 'servings', 'scoop', 'scoops', 'plate', 'plates', 'handful', 'x',
])

function singular(t: string): string {
  if (t.length <= 3) return t
  if (/(ss|us|is)$/.test(t)) return t
  if (t.endsWith('ies') && t.length > 4) return `${t.slice(0, -3)}y`
  if (t.endsWith('oes')) return t.slice(0, -2)
  if (/(ches|shes|xes|ses)$/.test(t)) return t.slice(0, -2)
  if (t.endsWith('s')) return t.slice(0, -1)
  return t
}

/** Lowercase, strip accents/punctuation/numbers/filler words, singularise. */
export function normalizeTokens(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t && !/^\d+$/.test(t) && !FILLER.has(t))
    .map(singular)
}

export function normalizeName(text: string): string {
  return normalizeTokens(text).join(' ')
}

/** Optimal-string-alignment Damerau-Levenshtein distance (adjacent transpositions cost 1). */
export function editDistance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  const d: number[][] = Array.from({ length: m + 1 }, (_, i) => {
    const row = new Array<number>(n + 1).fill(0)
    row[0] = i
    return row
  })
  for (let j = 0; j <= n; j++) d[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
      }
    }
  }
  return d[m][n]
}

/** Similarity in [0,1] for two tokens, or 0 when the edit distance is too large for their length. */
export function tokenSimilarity(a: string, b: string): number {
  if (a === b) return 1
  const len = Math.max(a.length, b.length)
  const dist = editDistance(a, b)
  const allowed = len <= 3 ? 0 : len <= 5 ? 1 : 2
  if (dist > allowed) return 0
  return 1 - dist / len
}

export interface AliasScore {
  score: number
  /** Share of the query's tokens explained by the alias (1 = the alias covers the whole query). */
  queryCoverage: number
}

/** Scores one alias against a query; null when any alias token is missing from the query. */
export function scoreAlias(queryTokens: string[], aliasTokens: string[]): AliasScore | null {
  if (queryTokens.length === 0 || aliasTokens.length === 0) return null

  // Path 1: token-by-token alignment.
  let best: AliasScore | null = null
  const used = new Set<number>()
  let simSum = 0
  let ok = true
  for (const at of aliasTokens) {
    let bestSim = 0
    let bestIdx = -1
    queryTokens.forEach((qt, i) => {
      if (used.has(i)) return
      const s = tokenSimilarity(qt, at)
      if (s > bestSim) {
        bestSim = s
        bestIdx = i
      }
    })
    if (bestIdx < 0) {
      ok = false
      break
    }
    used.add(bestIdx)
    simSum += bestSim
  }
  if (ok) {
    const cov = used.size / queryTokens.length
    best = { score: (simSum / aliasTokens.length) * (0.6 + 0.4 * cov) + 0.02 * aliasTokens.length, queryCoverage: cov }
  }

  // Path 2: compact comparison, so "weetbix" == "weet bix" and "flatwhite" == "flat white".
  const compactAlias = aliasTokens.join('')
  for (let start = 0; start < queryTokens.length; start++) {
    for (let end = start + 1; end <= Math.min(queryTokens.length, start + aliasTokens.length + 1); end++) {
      const window = queryTokens.slice(start, end)
      if (window.length === aliasTokens.length && window.length === 1) continue // same as path 1
      const s = tokenSimilarity(window.join(''), compactAlias)
      if (s === 0) continue
      const cov = window.length / queryTokens.length
      const score = s * (0.6 + 0.4 * cov) + 0.02 * aliasTokens.length
      if (!best || score > best.score) best = { score, queryCoverage: cov }
    }
  }
  return best
}

export interface FuzzyCandidate {
  aliases: string[]
}

export interface FuzzyMatch<T> {
  item: T
  alias: string
  score: number
  queryCoverage: number
}

/** Minimum score for a match to be accepted. Tuned by the noisy-transcript tests. */
export const MIN_MATCH_SCORE = 0.62

/** Best fuzzy match of `query` over `candidates`' aliases, or null when nothing clears the bar. */
export function bestFuzzyMatch<T extends FuzzyCandidate>(
  query: string,
  candidates: readonly T[],
  minScore = MIN_MATCH_SCORE,
): FuzzyMatch<T> | null {
  const q = normalizeTokens(query)
  if (q.length === 0) return null
  let best: FuzzyMatch<T> | null = null
  for (const item of candidates) {
    for (const alias of item.aliases) {
      const s = scoreAlias(q, normalizeTokens(alias))
      if (!s || s.queryCoverage < 0.5 || s.score < minScore) continue
      if (!best || s.score > best.score) best = { item, alias, score: s.score, queryCoverage: s.queryCoverage }
    }
  }
  return best
}
