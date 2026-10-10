import type { Goals, Meal } from '@/lib/types'
import { longestLowSugarStreak, longestTakeawayFreeStreak } from '@/lib/habitStreaks'
import {
  dateWhenUniqueFoodsReached,
  firstEatingOutMeal,
  longestCalorieGoalStreak,
  longestLoggingStreak,
  longestProteinGoalStreak,
  uniqueFoodNames,
} from '@/lib/stats'

export interface Badge {
  id: string
  icon: string
  title: string
  description: string
  earned: boolean
  /** Real calendar date (yyyy-mm-dd) this badge was actually earned, derived from meal history —
   * undefined only when the badge isn't earned yet. */
  earnedOn?: string
  progressCurrent: number
  progressTarget: number
  /** 'streak' badges get the flame-shaped confetti when newly earned, 'bullseye' gets the
   * target-shaped burst, others get the default burst. */
  celebration: 'streak' | 'bullseye' | 'default'
}

/**
 * All badges are computed fresh, every render, straight from the real `meals` array App.tsx
 * already loads from Supabase (mealsRepo.ts) — deliberately NOT stored in a separate
 * "earned_badges" table. Reasoning (documented per the task's own instruction to justify this
 * choice):
 *   1. No DDL access exists anyway with the current anon key (confirmed live during Phase 3 —
 *      supabase/migrations/0002_eating_out.sql still needs Deep to run it by hand), so a new
 *      badges table would be one more manual migration queued up behind that one.
 *   2. Meal history already persists in Supabase and already syncs across devices via the real
 *      realtime subscription in mealsRepo.ts. Recomputing badges from that same source of truth
 *      is automatically consistent everywhere it's viewed — there's no second copy of "earned"
 *      state that could ever drift from the meals that actually justify it.
 *   3. Every badge here is a deterministic function of data that's already durable. The only
 *      thing that is NOT naturally persisted is "have I already shown the celebratory confetti
 *      for this badge" — that's a one-time, per-device UI courtesy, not real app state, so it
 *      lives in localStorage (see getNewlyEarnedBadgeIds below), matching how ephemeral
 *      per-viewer conveniences are meant to be stored, not synced state.
 */
export function computeBadges(meals: Meal[], goals: Goals): Badge[] {
  const firstMeal = meals.length > 0 ? [...meals].sort((a, b) => a.loggedAt.localeCompare(b.loggedAt))[0] : null
  const { length: bestStreak, endDate: streakEndDate } = longestLoggingStreak(meals)
  const bestProteinStreak = longestProteinGoalStreak(meals, goals)
  const { length: bestBullseyeStreak, endDate: bullseyeEndDate } = longestCalorieGoalStreak(meals, goals)
  const foods = uniqueFoodNames(meals)
  const firstEatOut = firstEatingOutMeal(meals)
  const bestTakeawayFree = longestTakeawayFreeStreak(meals)
  const bestLowSugar = longestLowSugarStreak(meals)

  const badges: Badge[] = [
    {
      id: 'first-bite',
      icon: '🍽️',
      title: 'First Bite',
      description: 'Log your first meal',
      earned: !!firstMeal,
      earnedOn: firstMeal ? firstMeal.loggedAt.slice(0, 10) : undefined,
      progressCurrent: Math.min(meals.length, 1),
      progressTarget: 1,
      celebration: 'default',
    },
    {
      id: 'streak-7',
      icon: '🔥',
      title: '7-Day Streak',
      description: 'Log meals 7 days in a row',
      earned: bestStreak >= 7,
      earnedOn: bestStreak >= 7 ? (streakEndDate ?? undefined) : undefined,
      progressCurrent: Math.min(bestStreak, 7),
      progressTarget: 7,
      celebration: 'streak',
    },
    {
      id: 'streak-30',
      icon: '🏆',
      title: '30-Day Streak',
      description: 'Log meals 30 days in a row',
      earned: bestStreak >= 30,
      earnedOn: bestStreak >= 30 ? (streakEndDate ?? undefined) : undefined,
      progressCurrent: Math.min(bestStreak, 30),
      progressTarget: 30,
      celebration: 'streak',
    },
    {
      id: 'streak-100',
      icon: '⚡',
      title: 'Unstoppable',
      description: 'Log meals 100 days in a row',
      earned: bestStreak >= 100,
      earnedOn: bestStreak >= 100 ? (streakEndDate ?? undefined) : undefined,
      progressCurrent: Math.min(bestStreak, 100),
      progressTarget: 100,
      celebration: 'streak',
    },
    {
      id: 'bullseye-7',
      icon: '🎯',
      title: 'Bullseye',
      description: 'Land within your calorie goal 7 days in a row',
      earned: bestBullseyeStreak >= 7,
      earnedOn: bestBullseyeStreak >= 7 ? (bullseyeEndDate ?? undefined) : undefined,
      progressCurrent: Math.min(bestBullseyeStreak, 7),
      progressTarget: 7,
      celebration: 'bullseye',
    },
    {
      id: 'protein-streak-7',
      icon: '💪',
      title: 'Protein Pro',
      description: 'Hit your protein goal 7 days in a row',
      earned: bestProteinStreak >= 7,
      progressCurrent: Math.min(bestProteinStreak, 7),
      progressTarget: 7,
      celebration: 'streak',
    },
    {
      id: 'eating-out-1',
      icon: '🥡',
      title: 'Eating Out Explorer',
      description: 'Log your first restaurant/takeaway meal',
      earned: !!firstEatOut,
      earnedOn: firstEatOut ? firstEatOut.loggedAt.slice(0, 10) : undefined,
      progressCurrent: firstEatOut ? 1 : 0,
      progressTarget: 1,
      celebration: 'default',
    },
    {
      id: 'takeaway-free-7',
      icon: '🥗',
      title: 'Home Cook Week',
      description: 'Log 7 days in a row with no takeaway',
      earned: bestTakeawayFree >= 7,
      progressCurrent: Math.min(bestTakeawayFree, 7),
      progressTarget: 7,
      celebration: 'streak',
    },
    {
      id: 'takeaway-free-30',
      icon: '🏡',
      title: 'Takeaway-Free Month',
      description: 'Log 30 days in a row with no takeaway',
      earned: bestTakeawayFree >= 30,
      progressCurrent: Math.min(bestTakeawayFree, 30),
      progressTarget: 30,
      celebration: 'streak',
    },
    {
      id: 'low-sugar-7',
      icon: '🍎',
      title: 'Sugar Smart',
      description: 'Stay under 50 g of sugar for 7 days in a row',
      earned: bestLowSugar >= 7,
      progressCurrent: Math.min(bestLowSugar, 7),
      progressTarget: 7,
      celebration: 'streak',
    },
    {
      id: 'foods-10',
      icon: '🌱',
      title: 'Curious Eater',
      description: 'Try 10 different foods',
      earned: foods.size >= 10,
      earnedOn: foods.size >= 10 ? dateWhenUniqueFoodsReached(meals, 10) : undefined,
      progressCurrent: Math.min(foods.size, 10),
      progressTarget: 10,
      celebration: 'default',
    },
    {
      id: 'foods-25',
      icon: '🌍',
      title: 'Food Explorer',
      description: 'Try 25 different foods',
      earned: foods.size >= 25,
      earnedOn: foods.size >= 25 ? dateWhenUniqueFoodsReached(meals, 25) : undefined,
      progressCurrent: Math.min(foods.size, 25),
      progressTarget: 25,
      celebration: 'default',
    },
  ]
  return badges
}

const SEEN_BADGES_KEY = 'nutrios.achievements.seenEarnedIds'

function readSeenBadgeIds(): Set<string> {
  try {
    const raw = localStorage.getItem(SEEN_BADGES_KEY)
    return raw ? new Set(JSON.parse(raw)) : new Set()
  } catch {
    return new Set()
  }
}

function writeSeenBadgeIds(ids: Set<string>) {
  try {
    localStorage.setItem(SEEN_BADGES_KEY, JSON.stringify([...ids]))
  } catch {
    /* no-op — private browsing / storage disabled, badges still render correctly without this */
  }
}

/**
 * Diffs the current earned badges against what this device has already celebrated (a per-device
 * localStorage courtesy, NOT shared app state — see the reasoning above), returns the newly
 * earned ones, and marks them seen. Call once per meaningful `meals` change, not on every render.
 */
export function getNewlyEarnedBadges(badges: Badge[]): Badge[] {
  const seen = readSeenBadgeIds()
  const earnedIds = badges.filter((b) => b.earned).map((b) => b.id)
  const newly = badges.filter((b) => b.earned && !seen.has(b.id))
  if (newly.length > 0) {
    writeSeenBadgeIds(new Set([...seen, ...earnedIds]))
  }
  return newly
}
