import type { FoodItem, FoodSource } from '@/lib/types'

/**
 * "Never a silent 0" rules for the confirm screen (NUTRYOS Phase 1).
 *
 * An item NEEDS NUMBERS when it has a name, no calories, and nobody has confirmed that 0 is the
 * real value. A meal containing such an item can't be logged until the user either types numbers
 * in, lets an AI estimate run (opt-in only), or explicitly taps "Log with 0 for this item".
 */
export function itemNeedsNumbers(item: FoodItem): boolean {
  return item.name.trim().length > 0 && !(item.calories > 0) && !item.zeroConfirmed
}

export function itemsNeedingNumbers(items: readonly FoodItem[]): FoodItem[] {
  return items.filter(itemNeedsNumbers)
}

/** The "Log this meal" button is enabled only when there is at least one named item and none of
 * the named items still needs numbers. */
export function canLogMeal(items: readonly FoodItem[]): boolean {
  const named = items.filter((it) => it.name.trim().length > 0)
  return named.length > 0 && named.every((it) => !itemNeedsNumbers(it))
}

/** Badge text per source. 'unresolved' items show "Needs numbers" instead (see ConfirmLog). */
export const SOURCE_LABELS: Record<FoodSource, string> = {
  'my-foods': 'My Foods',
  curated: 'NZ/AU food table',
  off: 'Open Food Facts',
  'ai-estimate': 'AI estimate',
  barcode: 'Barcode',
  user: 'You entered',
  unresolved: 'Needs numbers',
}

/** The label shown on an item's badge. */
export function badgeLabel(item: FoodItem): string {
  if (itemNeedsNumbers(item)) return 'Needs numbers'
  if (!item.source) return item.offCode ? 'Open Food Facts' : 'Saved meal'
  return SOURCE_LABELS[item.source]
}
