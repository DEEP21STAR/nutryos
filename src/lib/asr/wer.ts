/** Word error rate for the voice acceptance tests. Normalisation is deliberately light and stated:
 * lower-case, digits spelled as words, "30g" = "thirty grams", Weet-Bix/Weetbix = "weet bix",
 * yogurt = yoghurt, punctuation dropped. Nothing else is forgiven. */
const ONES = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(' ')
const TENS = '_ _ twenty thirty forty fifty sixty seventy eighty ninety'.split(' ')

function numToWords(n: number): string {
  if (n < 20) return ONES[n]
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : '')
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` and ${numToWords(n % 100)}` : ''}`
  return String(n)
}

export function werTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/(\d+)\s*(?:g|gm|grams?)\b/g, '$1 grams')
    .replace(/(\d+)\s*ml\b/g, '$1 ml')
    .replace(/(\d+)/g, (m) => numToWords(Number(m)))
    .replace(/weet[- ]?bix/g, 'weet bix')
    .replace(/yogurt/g, 'yoghurt')
    .replace(/[^a-z ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

export function wer(reference: string, hypothesis: string): number {
  const r = werTokens(reference)
  const h = werTokens(hypothesis)
  if (r.length === 0) return h.length === 0 ? 0 : 1
  const d: number[][] = Array.from({ length: r.length + 1 }, (_, i) => [i, ...new Array<number>(h.length).fill(0)])
  for (let j = 0; j <= h.length; j++) d[0][j] = j
  for (let i = 1; i <= r.length; i++)
    for (let j = 1; j <= h.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1))
  return d[r.length][h.length] / r.length
}
