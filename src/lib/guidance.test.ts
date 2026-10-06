import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HELP_CARDS,
  TOUR_SEEN_KEY,
  TOUR_STEPS,
  cardPlacement,
  clampIndex,
  hasSeenTour,
  indexFromScroll,
  markTourSeen,
} from '@/lib/guidance'

describe('tour seen flag', () => {
  beforeEach(() => localStorage.clear())

  it('is unseen on a fresh device, seen after marking', () => {
    expect(hasSeenTour()).toBe(false)
    markTourSeen()
    expect(localStorage.getItem(TOUR_SEEN_KEY)).toBe('1')
    expect(hasSeenTour()).toBe(true)
  })

  it('treats blocked storage as seen and never throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(hasSeenTour()).toBe(true)
    expect(() => markTourSeen()).not.toThrow()
    spy.mockRestore()
    set.mockRestore()
  })
})

describe('content', () => {
  it('has a 4-5 step tour and exactly 5 help cards', () => {
    expect(TOUR_STEPS.length).toBeGreaterThanOrEqual(4)
    expect(TOUR_STEPS.length).toBeLessThanOrEqual(5)
    expect(HELP_CARDS).toHaveLength(5)
  })
})

describe('index helpers', () => {
  it('clamps', () => {
    expect(clampIndex(-1, 5)).toBe(0)
    expect(clampIndex(9, 5)).toBe(4)
    expect(clampIndex(2, 0)).toBe(0)
  })
  it('maps scroll position to a card', () => {
    expect(indexFromScroll(0, 300, 5)).toBe(0)
    expect(indexFromScroll(310, 300, 5)).toBe(1)
    expect(indexFromScroll(1200, 300, 5)).toBe(4)
    expect(indexFromScroll(500, 0, 5)).toBe(0)
  })
})

describe('cardPlacement', () => {
  it('goes below a target near the top and above one near the bottom', () => {
    expect(cardPlacement({ top: 100, bottom: 300 }, 844)).toBe('below')
    expect(cardPlacement({ top: 700, bottom: 780 }, 844)).toBe('above')
  })
})
