import { describe, expect, it } from 'vitest'
import { longestLowSugarStreak, longestTakeawayFreeStreak, crossedMilestone, lowSugarStreak, nextMilestone, takeawayFreeStreak, takeawaySavings, waterStreak } from '@/lib/habitStreaks'
import type { Meal } from '@/lib/types'

const NOW = new Date(2026, 9, 9, 12, 0, 0)
function at(daysAgo: number): string {
  const d = new Date(NOW)
  d.setDate(d.getDate() - daysAgo)
  return d.toISOString()
}
function meal(daysAgo: number, o: { out?: boolean; sugar?: number } = {}): Meal {
  return {
    id: `m${daysAgo}${Math.random()}`,
    photoDataUrl: null,
    loggedAt: at(daysAgo),
    isEatingOut: o.out,
    items: [{ id: 'i', name: 'x', estimatedGrams: 100, calories: 100, proteinG: 1, fatG: 1, carbsG: 1, sugarG: o.sugar }],
  }
}

describe('takeawayFreeStreak', () => {
  it('counts consecutive logged days with no eating-out meal', () => {
    expect(takeawayFreeStreak([meal(0), meal(1), meal(2)], NOW)).toBe(3)
  })
  it('breaks on an eating-out day', () => {
    expect(takeawayFreeStreak([meal(0), meal(1), meal(2, { out: true }), meal(3)], NOW)).toBe(2)
  })
  it('breaks on an unlogged day (cannot know it was takeaway-free)', () => {
    expect(takeawayFreeStreak([meal(0), meal(2)], NOW)).toBe(1)
  })
  it('does not break when today has nothing logged yet', () => {
    expect(takeawayFreeStreak([meal(1), meal(2)], NOW)).toBe(2)
  })
  it('is zero if today is takeaway', () => {
    expect(takeawayFreeStreak([meal(0, { out: true }), meal(1)], NOW)).toBe(0)
  })
})

describe('lowSugarStreak', () => {
  it('counts days at or under the cap', () => {
    expect(lowSugarStreak([meal(0, { sugar: 20 }), meal(1, { sugar: 50 })], NOW)).toBe(2)
  })
  it('breaks over the cap', () => {
    expect(lowSugarStreak([meal(0, { sugar: 10 }), meal(1, { sugar: 80 }), meal(2, { sugar: 5 })], NOW)).toBe(1)
  })
  it('skips days with no sugar data without breaking or counting', () => {
    expect(lowSugarStreak([meal(0, { sugar: 10 }), meal(1), meal(2, { sugar: 10 })], NOW)).toBe(2)
  })
})

describe('waterStreak', () => {
  const k = (n: number) => {
    const d = new Date(NOW)
    d.setDate(d.getDate() - n)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  it('counts days at goal and lets today be in progress', () => {
    expect(waterStreak({ [k(1)]: 2600, [k(2)]: 2500, [k(3)]: 100 }, 2500, NOW)).toBe(2)
  })
  it('includes today once reached', () => {
    expect(waterStreak({ [k(0)]: 2500, [k(1)]: 2500 }, 2500, NOW)).toBe(2)
  })
})

describe('savings and milestones', () => {
  it('returns null without a cost', () => {
    expect(takeawaySavings(5, null)).toBeNull()
    expect(takeawaySavings(5, 0)).toBeNull()
  })
  it('scales by how often takeaways used to happen, not one a day', () => {
    expect(takeawaySavings(14, 24, 2)).toBe(96)
    expect(takeawaySavings(7, 20, 3)).toBe(60)
    expect(takeawaySavings(4, 22.5)).toBe(25.71)
  })
  it('finds milestones', () => {
    expect(nextMilestone(5)).toBe(7)
    expect(crossedMilestone(8)).toBe(7)
    expect(crossedMilestone(2)).toBeNull()
  })
})

describe('longest streaks', () => {
  it('finds the longest takeaway-free run in history', () => {
    const ms = [meal(9), meal(8), meal(7), meal(6, { out: true }), meal(5), meal(4), meal(3), meal(2), meal(1), meal(0)]
    expect(longestTakeawayFreeStreak(ms, NOW)).toBe(6)
  })
  it('finds the longest low-sugar run, skipping unknown days', () => {
    const ms = [meal(5, { sugar: 10 }), meal(4, { sugar: 10 }), meal(3), meal(2, { sugar: 90 }), meal(1, { sugar: 5 })]
    expect(longestLowSugarStreak(ms, NOW)).toBe(2)
  })
  it('is zero with no meals', () => {
    expect(longestTakeawayFreeStreak([], NOW)).toBe(0)
  })
})
