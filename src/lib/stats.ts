import type { Goals, MacroTotals, Meal } from '@/lib/types'
import { sumMacros } from '@/lib/types'

/**
 * Phase 4 (Together Mode) — real, derived-from-data statistics shared by the tips ticker,
 * achievements/badges, and the "you" row of the Together Mode leaderboard. Every function here
 * is a pure computation over the SAME `meals` array App.tsx already loads from Supabase (see
 * mealsRepo.ts) — nothing here reads or writes any new table/column, so there is no migration to
 * run and no drift risk between "what's displayed" and "what's actually logged". Dates are
 * compared using the browser's local calendar day (`Date`'s local getters), matching how
 * MealTimeline already displays "today" vs a past date.
 */

function localDateKey(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export interface DayTotals {
  date: string // yyyy-mm-dd, local calendar day
  calories: number
  proteinG: number
  fatG: number
  carbsG: number
  mealCount: number
}

/** Buckets every meal into its local calendar day and sums macros per day. */
export function groupMealsByDay(meals: Meal[]): Map<string, DayTotals> {
  const map = new Map<string, DayTotals>()
  for (const meal of meals) {
    const key = localDateKey(meal.loggedAt)
    const totals = sumMacros(meal.items)
    const existing = map.get(key)
    if (existing) {
      existing.calories += totals.calories
      existing.proteinG += totals.proteinG
      existing.fatG += totals.fatG
      existing.carbsG += totals.carbsG
      existing.mealCount += 1
    } else {
      map.set(key, { date: key, ...totals, mealCount: 1 })
    }
  }
  return map
}

/** Longest run ever, anywhere in history, of consecutive calendar days with >=1 meal logged. */
export function longestLoggingStreak(meals: Meal[]): { length: number; endDate: string | null } {
  const days = groupMealsByDay(meals)
  const sortedKeys = [...days.keys()].sort()
  if (sortedKeys.length === 0) return { length: 0, endDate: null }
  let best = 1
  let bestEnd = sortedKeys[0]
  let run = 1
  for (let i = 1; i < sortedKeys.length; i++) {
    const diffDays = Math.round(
      (new Date(sortedKeys[i]).getTime() - new Date(sortedKeys[i - 1]).getTime()) / 86_400_000,
    )
    run = diffDays === 1 ? run + 1 : 1
    if (run > best) {
      best = run
      bestEnd = sortedKeys[i]
    }
  }
  return { length: best, endDate: bestEnd }
}

/**
 * Streak still "alive" right now — walks back from today. If today has no meal logged yet, it
 * starts the walk from yesterday instead, so the streak doesn't drop to zero mid-day before the
 * user has had a chance to log anything today.
 */
export function currentLoggingStreak(meals: Meal[], now = new Date()): number {
  const days = groupMealsByDay(meals)
  const cursor = new Date(now)
  cursor.setHours(0, 0, 0, 0)
  if (!days.has(localDateKey(cursor.toISOString()))) {
    cursor.setDate(cursor.getDate() - 1)
  }
  let streak = 0
  while (days.has(localDateKey(cursor.toISOString()))) {
    streak += 1
    cursor.setDate(cursor.getDate() - 1)
  }
  return streak
}

/** Same "still alive" logic as currentLoggingStreak, but for consecutive days hitting the protein goal. */
export function currentProteinGoalStreak(meals: Meal[], goals: Goals, now = new Date()): number {
  const days = groupMealsByDay(meals)
  const cursor = new Date(now)
  cursor.setHours(0, 0, 0, 0)
  const hitsGoal = (key: string) => (days.get(key)?.proteinG ?? 0) >= goals.proteinGoalG
  if (!hitsGoal(localDateKey(cursor.toISOString()))) {
    cursor.setDate(cursor.getDate() - 1)
  }
  let streak = 0
  while (hitsGoal(localDateKey(cursor.toISOString()))) {
    streak += 1
    cursor.setDate(cursor.getDate() - 1)
  }
  return streak
}

/** Longest run ever of consecutive days hitting the protein goal (for the "Protein Pro" badge). */
export function longestProteinGoalStreak(meals: Meal[], goals: Goals): number {
  const days = groupMealsByDay(meals)
  const sortedKeys = [...days.keys()].sort()
  let best = 0
  let run = 0
  let prevKey: string | null = null
  for (const key of sortedKeys) {
    const hit = (days.get(key)?.proteinG ?? 0) >= goals.proteinGoalG
    if (!hit) {
      run = 0
      prevKey = null
      continue
    }
    const diffDays = prevKey ? Math.round((new Date(key).getTime() - new Date(prevKey).getTime()) / 86_400_000) : null
    run = diffDays === 1 ? run + 1 : 1
    best = Math.max(best, run)
    prevKey = key
  }
  return best
}

/**
 * "Hit the calorie goal" for the Bullseye badge means landing in the goal's actual target
 * zone — within 90-100% of it — not merely staying under it. Someone who eats 40% of their
 * goal every day would pass an "under goal" rule despite missing the target badly; this rule
 * rewards actually hitting it, which is what a goal is for.
 */
function hitCalorieGoal(dayCalories: number, goalCalories: number): boolean {
  return dayCalories >= goalCalories * 0.9 && dayCalories <= goalCalories
}

/** Longest run ever of consecutive days landing within 90-100% of the calorie goal (the "Bullseye" badge). */
export function longestCalorieGoalStreak(meals: Meal[], goals: Goals): { length: number; endDate: string | null } {
  const days = groupMealsByDay(meals)
  const sortedKeys = [...days.keys()].sort()
  let best = 0
  let bestEnd: string | null = null
  let run = 0
  let prevKey: string | null = null
  for (const key of sortedKeys) {
    const hit = hitCalorieGoal(days.get(key)?.calories ?? 0, goals.calorieGoal)
    if (!hit) {
      run = 0
      prevKey = null
      continue
    }
    const diffDays = prevKey ? Math.round((new Date(key).getTime() - new Date(prevKey).getTime()) / 86_400_000) : null
    run = diffDays === 1 ? run + 1 : 1
    if (run > best) {
      best = run
      bestEnd = key
    }
    prevKey = key
  }
  return { length: best, endDate: bestEnd }
}

/** De-duplicated, trimmed, case-insensitive set of every food name ever logged. */
export function uniqueFoodNames(meals: Meal[]): Set<string> {
  const set = new Set<string>()
  for (const m of meals) {
    for (const it of m.items) {
      const n = it.name.trim().toLowerCase()
      if (n) set.add(n)
    }
  }
  return set
}

/** The real calendar date (yyyy-mm-dd) the Nth distinct food name was first logged, chronologically. */
export function dateWhenUniqueFoodsReached(meals: Meal[], threshold: number): string | undefined {
  const sorted = [...meals].sort((a, b) => a.loggedAt.localeCompare(b.loggedAt))
  const seen = new Set<string>()
  for (const m of sorted) {
    for (const it of m.items) {
      const n = it.name.trim().toLowerCase()
      if (n) seen.add(n)
    }
    if (seen.size >= threshold) return m.loggedAt.slice(0, 10)
  }
  return undefined
}

/** Earliest "Eating Out" tagged meal, chronologically — real integration with Phase 3's isEatingOut field. */
export function firstEatingOutMeal(meals: Meal[]): Meal | null {
  const sorted = [...meals]
    .filter((m) => m.isEatingOut)
    .sort((a, b) => a.loggedAt.localeCompare(b.loggedAt))
  return sorted[0] ?? null
}

/** One calendar day's real total vs. the user's real daily calorie target — chart-ready shape for
 * the weekly bar chart in TrendsHistory.tsx (Phase 5, 2026-09-17). */
export interface DayVsGoal {
  date: string // yyyy-mm-dd, local calendar day
  /** Short axis label, e.g. "Mon" — today gets "Today" instead so it's easy to find at a glance. */
  dayLabel: string
  calories: number
  goal: number
  /** True if nothing was logged this day at all — distinct from "logged 0 kcal", which can't
   * actually happen, but keeps the bar chart from silently treating "no data" and "a real zero"
   * as the same thing if that ever changes. */
  hasData: boolean
}

/**
 * Real per-day calorie totals for the last `days` calendar days (inclusive of today), oldest
 * first — exactly the shape Lose It's "My Analysis: on target" bar chart was the reference for.
 * Every value comes from groupMealsByDay's real aggregation over the real `meals` the caller
 * fetched (see mealsRepo.listMealsSince) — days with nothing logged still get an entry (calories:
 * 0, hasData: false) so the chart shows a real gap instead of silently compressing the x-axis.
 */
export function lastNDaysCalorieTotals(meals: Meal[], goals: Goals, days = 7, now = new Date()): DayVsGoal[] {
  const byDay = groupMealsByDay(meals)
  const cursor = new Date(now)
  cursor.setHours(0, 0, 0, 0)
  const out: DayVsGoal[] = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(cursor)
    d.setDate(d.getDate() - i)
    const key = localDateKey(d.toISOString())
    const day = byDay.get(key)
    out.push({
      date: key,
      dayLabel: i === 0 ? 'Today' : d.toLocaleDateString('en-NZ', { weekday: 'short' }),
      calories: day?.calories ?? 0,
      goal: goals.calorieGoal,
      hasData: !!day && day.mealCount > 0,
    })
  }
  return out
}

/**
 * "Healthy Score" (Phase 5, 2026-09-17) — a single 0-100 composite, Deep's own design decision
 * per the task brief (only the CONCEPT of one score was approved, not exact weights — flagged
 * explicitly in the handback too). Modeled loosely on Hoot's 1-100 Nutrition Score. Three parts,
 * each documented so the number is legible rather than a black box:
 *
 * 1. Calorie adherence (0-40): how close today's total is to the calorie goal, symmetric in
 *    either direction (being 20% under is scored the same as being 20% over) — full marks at
 *    exactly the goal, straight-line falloff to 0 at +/-67% away from it (a deviation that large
 *    means the day's logging is either very off-target or very incomplete, either way not worth
 *    partial credit).
 * 2. Macro balance (0-30): average, across protein/fat/carbs, of how close each macro's intake is
 *    to ITS OWN goal — under the goal scores linearly (half the protein goal = half credit), over
 *    the goal falls back off at the same rate (does not reward "as much as possible", matches the
 *    calorie score's own over-shooting-isn't-free logic).
 * 3. Variety (0-30): distinct food names logged today, out of a 5-item/day reference point, capped
 *    at full marks — reuses uniqueFoodNames so "variety" always means real distinct logged items,
 *    never a fabricated count.
 *
 * Deliberately NOT a weighted average of raw percentages — the asymmetric floor for going way over
 * on any axis is intentional, matching this app's existing "going over ranks worse" judgment call
 * already made in goalCrusherWeekScore above.
 */
export interface HealthyScoreBreakdown {
  score: number // 0-100, rounded
  calorieScore: number // 0-40
  macroScore: number // 0-30
  varietyScore: number // 0-30
}

const VARIETY_REFERENCE_COUNT = 5

function symmetricAdherence(actual: number, goal: number, falloffAt: number): number {
  if (goal <= 0) return 0
  const deviationPct = Math.abs(actual - goal) / goal
  return Math.max(0, 1 - deviationPct / falloffAt)
}

export function computeHealthyScore(totals: MacroTotals, goals: Goals, todaysMeals: Meal[]): HealthyScoreBreakdown {
  const calorieScore = 40 * symmetricAdherence(totals.calories, goals.calorieGoal, 0.67)

  const macroAdherences = [
    symmetricAdherence(totals.proteinG, goals.proteinGoalG, 1), // full falloff over a 100% miss
    symmetricAdherence(totals.fatG, goals.fatGoalG, 1),
    symmetricAdherence(totals.carbsG, goals.carbsGoalG, 1),
  ]
  const macroScore = 30 * (macroAdherences.reduce((a, b) => a + b, 0) / macroAdherences.length)

  const varietyCount = uniqueFoodNames(todaysMeals).size
  const varietyScore = 30 * Math.min(1, varietyCount / VARIETY_REFERENCE_COUNT)

  const score = Math.round(Math.max(0, Math.min(100, calorieScore + macroScore + varietyScore)))
  return { score, calorieScore: Math.round(calorieScore), macroScore: Math.round(macroScore), varietyScore: Math.round(varietyScore) }
}

/**
 * "Goal Crusher" score for the last 7 calendar days: 100 minus the average % deviation from the
 * calorie goal (only counting days something was actually logged), minus a 10-point penalty for
 * every one of those days that went OVER the goal — going over should rank worse than staying
 * under by the same margin, per the challenge's own name ("closest to goal WITHOUT going over").
 * Clamped to [0, 100]. Days with nothing logged simply don't count toward the average — they
 * neither help nor hurt the score, since "no data" isn't the same as "went over".
 */
export function goalCrusherWeekScore(meals: Meal[], goals: Goals, now = new Date()): number {
  const days = groupMealsByDay(meals)
  const cursor = new Date(now)
  cursor.setHours(0, 0, 0, 0)
  let totalDeviationPct = 0
  let daysLogged = 0
  let daysOverGoal = 0
  for (let i = 0; i < 7; i++) {
    const day = days.get(localDateKey(cursor.toISOString()))
    if (day && day.mealCount > 0) {
      daysLogged += 1
      totalDeviationPct += (Math.abs(goals.calorieGoal - day.calories) / goals.calorieGoal) * 100
      if (day.calories > goals.calorieGoal) daysOverGoal += 1
    }
    cursor.setDate(cursor.getDate() - 1)
  }
  if (daysLogged === 0) return 0
  const avgDeviationPct = totalDeviationPct / daysLogged
  return Math.max(0, Math.min(100, 100 - avgDeviationPct - daysOverGoal * 10))
}

/** One plain sentence for the Today screen from real totals. Returns null when no goals are loaded. */
export function whatNextLine(
  totals: MacroTotals,
  goals: Goals | null | undefined,
  caloriesBurned = 0,
  mealCount = totals.calories > 0 ? 1 : 0,
): string | null {
  if (!goals || !(goals.calorieGoal > 0)) return null
  const budget = goals.calorieGoal + caloriesBurned
  const left = Math.round(budget - totals.calories)
  if (mealCount === 0 && totals.calories <= 0) return 'Nothing logged yet: start with breakfast'
  if (left < 0) return `You're ${-left} kcal over today`
  if (left === 0) return 'You hit your calorie goal for today'
  return left >= 150 ? `You have ${left} kcal left: a snack fits` : `You have ${left} kcal left: a light bite fits`
}
