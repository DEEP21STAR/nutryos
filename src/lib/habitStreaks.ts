import type { Meal } from '@/lib/types'
import { sumMacros } from '@/lib/types'

/**
 * Healthy-habit streaks (takeaway-free, low-sugar, water). Pure functions over the same `meals`
 * history the rest of the app loads, plus the per-day water history from waterTracking.ts, so
 * there is no new table and no migration.
 *
 * Honesty rules:
 *  - A takeaway-free day needs at least one logged meal and none tagged "Eating Out". A day with
 *    nothing logged is NOT counted: we cannot know it was takeaway-free.
 *  - A low-sugar day needs real sugar data on at least one item. A day whose items carry no
 *    sugar figure at all is "unknown": it neither extends nor breaks the streak.
 *  - Today is "in progress": if it does not qualify yet it never breaks the streak, the walk
 *    simply starts from yesterday.
 */

export const SUGAR_CAP_G = 50
export const MILESTONES = [3, 7, 14, 30, 60, 100]

export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

type DayState = 'yes' | 'no' | 'unknown'

function startOfDay(now: Date): Date {
  const c = new Date(now)
  c.setHours(0, 0, 0, 0)
  return c
}

function mealsByDay(meals: Meal[]): Map<string, Meal[]> {
  const map = new Map<string, Meal[]>()
  for (const m of meals) {
    const k = dayKey(new Date(m.loggedAt))
    const list = map.get(k)
    if (list) list.push(m)
    else map.set(k, [m])
  }
  return map
}

/** Walk back from today. `state(key)` says how a day scores. 'unknown' days are skipped
 * (no credit, no break); 'no' stops the walk. Today only breaks it once it has a disqualifying meal; an empty or in-progress today is skipped. */
function walk(state: (key: string, isToday: boolean) => DayState, now: Date, maxDays = 400): number {
  const cursor = startOfDay(now)
  const todayKey = dayKey(cursor)
  let streak = 0
  for (let i = 0; i < maxDays; i++) {
    const k = dayKey(cursor)
    const s = state(k, k === todayKey)
    if (s === 'yes') streak += 1
    else if (s === 'no') break
    cursor.setDate(cursor.getDate() - 1)
  }
  return streak
}

export function takeawayFreeStreak(meals: Meal[], now = new Date()): number {
  const days = mealsByDay(meals)
  return walk((k, isToday) => {
    const list = days.get(k)
    if (!list || list.length === 0) return isToday ? 'unknown' : 'no'
    return list.some((m) => m.isEatingOut) ? 'no' : 'yes'
  }, now)
}

export function lowSugarStreak(meals: Meal[], now = new Date(), capG = SUGAR_CAP_G): number {
  const days = mealsByDay(meals)
  return walk((k, isToday) => {
    const list = days.get(k)
    if (!list || list.length === 0) return isToday ? 'unknown' : 'no'
    const items = list.flatMap((m) => m.items)
    if (!items.some((i) => typeof i.sugarG === 'number')) return 'unknown'
    return (sumMacros(items).sugarG ?? 0) <= capG ? 'yes' : 'no'
  }, now)
}

/** Longest run ever, scanning every calendar day from the first logged meal to `now`. 'unknown'
 * days neither add nor break; today is skipped unless it already qualifies or disqualifies. */
function longestRun(meals: Meal[], now: Date, score: (list: Meal[] | undefined, isToday: boolean) => DayState): number {
  if (meals.length === 0) return 0
  const days = mealsByDay(meals)
  const first = new Date(Math.min(...meals.map((m) => new Date(m.loggedAt).getTime())))
  const cursor = startOfDay(first)
  const end = startOfDay(now)
  const todayKey = dayKey(end)
  let best = 0
  let run = 0
  for (let i = 0; i < 1000 && cursor.getTime() <= end.getTime(); i++) {
    const k = dayKey(cursor)
    const st = score(days.get(k), k === todayKey)
    if (st === 'yes') {
      run += 1
      if (run > best) best = run
    } else if (st === 'no') run = 0
    cursor.setDate(cursor.getDate() + 1)
  }
  return best
}

export function longestTakeawayFreeStreak(meals: Meal[], now = new Date()): number {
  return longestRun(meals, now, (list, isToday) => {
    if (!list || list.length === 0) return isToday ? 'unknown' : 'no'
    return list.some((m) => m.isEatingOut) ? 'no' : 'yes'
  })
}

export function longestLowSugarStreak(meals: Meal[], now = new Date(), capG = SUGAR_CAP_G): number {
  return longestRun(meals, now, (list, isToday) => {
    if (!list || list.length === 0) return isToday ? 'unknown' : 'no'
    const items = list.flatMap((m) => m.items)
    if (!items.some((i) => typeof i.sugarG === 'number')) return 'unknown'
    return (sumMacros(items).sugarG ?? 0) <= capG ? 'yes' : 'no'
  })
}

export function waterStreak(history: Record<string, number>, goalMl: number, now = new Date()): number {
  return walk((k, isToday) => ((history[k] ?? 0) >= goalMl ? 'yes' : isToday ? 'unknown' : 'no'), now)
}

/** Savings estimate: takeaway-free days x the user's own typical takeaway cost x how often they
 * used to order (takeaways per week / 7), so it does not assume a takeaway every single day.
 * Null until the user has entered a cost; always an estimate, never a measured figure. */
export const DEFAULT_TAKEAWAYS_PER_WEEK = 2
export function takeawaySavings(streakDays: number, avgCost: number | null, perWeek = DEFAULT_TAKEAWAYS_PER_WEEK): number | null {
  if (avgCost === null || !Number.isFinite(avgCost) || avgCost <= 0) return null
  if (!Number.isFinite(perWeek) || perWeek <= 0) return null
  return Math.round(streakDays * avgCost * (perWeek / 7) * 100) / 100
}

export function nextMilestone(n: number): number | null {
  return MILESTONES.find((m) => m > n) ?? null
}

export function crossedMilestone(n: number): number | null {
  const hit = [...MILESTONES].reverse().find((m) => n >= m)
  return hit ?? null
}
