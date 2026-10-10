import { describe, expect, it } from 'vitest'
import { wer } from '@/lib/asr/wer'

describe('wer', () => {
  it('is 0 for identical text modulo case/punctuation', () => expect(wer('Two eggs, and a flat white', 'two eggs and a flat white.')).toBe(0))
  it('counts digits as spoken numbers', () => expect(wer('thirty grams of whey', '30 g of whey')).toBe(0))
  it('counts substitutions', () => expect(wer('a b c d', 'a x c d')).toBeCloseTo(0.25))
  it('counts deletions and insertions', () => {
    expect(wer('a b c d', 'a b c')).toBeCloseTo(0.25)
    expect(wer('a b', 'a b c d')).toBeCloseTo(1)
  })
  it('normalises Weet-Bix and yogurt', () => expect(wer('two Weet-Bix with Greek yoghurt', 'two weetbix with greek yogurt')).toBe(0))
  it('handles hundreds', () => expect(wer('one hundred and fifty grams', '150 grams')).toBe(0))
})
