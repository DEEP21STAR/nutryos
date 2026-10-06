/**
 * Pure logic for the first-run tour and the help carousel: content, the persisted "seen" flag,
 * and the small geometry/index helpers the two components use. Kept out of the components so it
 * can be unit-tested without a DOM layout engine.
 */

export const TOUR_SEEN_KEY = 'nutryos:tour-seen:v1'

export function hasSeenTour(): boolean {
  try {
    return localStorage.getItem(TOUR_SEEN_KEY) === '1'
  } catch {
    // Storage blocked (private mode etc.): treat as seen so the tour never nags every launch.
    return true
  }
}

export function markTourSeen(): void {
  try {
    localStorage.setItem(TOUR_SEEN_KEY, '1')
  } catch {
    /* storage unavailable: nothing to persist */
  }
}

export interface TourStep {
  /** Matches a `data-tour` attribute on the real element. */
  target: 'orb' | 'ring' | 'macros' | 'timeline' | 'tabbar'
  title: string
  body: string
}

export const TOUR_STEPS: TourStep[] = [
  {
    target: 'orb',
    title: 'Log a meal',
    body: 'Tap this button, then say what you ate, type it, snap a photo or scan a barcode.',
  },
  {
    target: 'ring',
    title: 'Your calorie ring',
    body: 'The big ring fills as you eat. The number inside is what you have left today.',
  },
  {
    target: 'macros',
    title: 'Protein, fat and carbs',
    body: 'P, F and C show grams eaten against your daily goal. The small bar under each fills up.',
  },
  {
    target: 'timeline',
    title: 'Your meals today',
    body: 'Everything you log lands here in order, with its calories.',
  },
  {
    target: 'tabbar',
    title: 'Move around',
    body: 'Today is this page. Progress shows trends and photos. Together is for sharing with someone.',
  },
]

export interface HelpCard {
  icon: string
  title: string
  body: string
}

export const HELP_CARDS: HelpCard[] = [
  {
    icon: '🎙️',
    title: 'Log by voice or text',
    body: 'Tap the glowing button, choose Voice, and say it the way you would to a friend: "two eggs and toast". You can also type it, take a photo, or scan a barcode.',
  },
  {
    icon: '✏️',
    title: 'Check and edit a meal',
    body: 'Before anything is saved you see a confirm screen. Change a portion, remove an item, or add one by hand, then tap to log it.',
  },
  {
    icon: '🥩',
    title: 'Understand the macros',
    body: 'P is protein, F is fat, C is carbs, shown in grams against your daily goal. The coloured rings inside the calorie ring show the same three.',
  },
  {
    icon: '🎯',
    title: 'Your goals',
    body: 'Your calorie and macro goals come from the questions you answered at setup. Workouts you log add calories back to your budget for the day.',
  },
  {
    icon: '🔒',
    title: 'Privacy and your data',
    body: 'You are signed in without an account, and meal photos are private. In Settings you can back up with Google or download all your data.',
  },
]

export function clampIndex(i: number, count: number): number {
  if (count <= 0) return 0
  return Math.min(count - 1, Math.max(0, i))
}

/** Which snap-scroll card is showing, from the scroller's position. */
export function indexFromScroll(scrollLeft: number, cardWidth: number, count: number): number {
  if (cardWidth <= 0) return 0
  return clampIndex(Math.round(scrollLeft / cardWidth), count)
}

export interface RectLike {
  top: number
  bottom: number
}

/** Put the tour card on the side of the target with more room. */
export function cardPlacement(rect: RectLike, viewportHeight: number): 'above' | 'below' {
  const spaceAbove = rect.top
  const spaceBelow = viewportHeight - rect.bottom
  return spaceBelow >= spaceAbove ? 'below' : 'above'
}
