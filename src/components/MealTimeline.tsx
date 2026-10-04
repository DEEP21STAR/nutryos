import { Coffee, Cookie, Moon, UtensilsCrossed, type LucideIcon } from 'lucide-react'
import type { Meal } from '@/lib/types'
import { sumMacros } from '@/lib/types'

type MealSlot = { label: string; Icon: LucideIcon; color: string }

/** Time-of-day slot from the real loggedAt hour (local time). Boundaries are a judgment call,
 * not user data: <11 breakfast, 11-14 lunch, 15-16 snack, 17-21 dinner, otherwise late snack. */
function mealSlotForHour(hour: number): MealSlot {
  if (hour >= 4 && hour < 11) return { label: 'Breakfast', Icon: Coffee, color: 'var(--color-accent-energy)' }
  if (hour >= 11 && hour < 15) return { label: 'Lunch', Icon: UtensilsCrossed, color: 'var(--color-accent-health)' }
  if (hour >= 17 && hour < 22) return { label: 'Dinner', Icon: Moon, color: 'var(--color-accent-ai)' }
  return { label: 'Snack', Icon: Cookie, color: '#f472b6' }
}

function PlateIllustration() {
  return (
    <svg width="120" height="88" viewBox="0 0 120 88" fill="none" aria-hidden>
      <ellipse cx="60" cy="48" rx="34" ry="34" style={{ stroke: 'var(--ux-accent-a)' }} strokeWidth="2" opacity="0.9" />
      <ellipse cx="60" cy="48" rx="22" ry="22" style={{ stroke: 'var(--ux-accent-b)' }} strokeWidth="1.5" strokeDasharray="3 4" opacity="0.7" />
      <path d="M16 20v26M12 20v10a4 4 0 0 0 8 0V20M16 46v22" style={{ stroke: 'var(--ux-accent-a)' }} strokeWidth="2" strokeLinecap="round" opacity="0.8" />
      <path d="M104 20c-6 4-8 12-8 20h8v28" style={{ stroke: 'var(--ux-accent-a)' }} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity="0.8" />
      <circle cx="60" cy="48" r="3" style={{ fill: 'var(--ux-accent-a)' }} />
    </svg>
  )
}

/** Timeline View — restyled to the glass system (visual layer only, same data/order/logic as before). */
export function MealTimeline({ meals, onAddMeal }: { meals: Meal[]; onAddMeal?: () => void }) {
  if (meals.length === 0) {
    // Real gap found 2026-09-20: Workouts and Water each get their own "+ Log a..." button right
    // in their section, but this one just said "No meals logged yet today" with no action at all —
    // the only way to actually log a meal was the floating camera orb, which isn't obviously tied
    // to "meals" for a first-time user. Same button pattern as WorkoutTracker's "+ Log a workout",
    // using the user's own accent color since meals are the app's primary tracked metric.
    return (
      <div className="ux-empty mt-6 px-4">
        <PlateIllustration />
        <p className="text-body text-text-tertiary">No meals logged yet today.</p>
        {onAddMeal && (
          <button
            onClick={onAddMeal}
            className="w-full max-w-xs min-h-12 rounded-xl py-3 text-body font-bold transition active:scale-95"
            style={{
              background: 'var(--ux-accent-a)',
              color: '#04140d',
              boxShadow: 'var(--ux-glow-sm)',
            }}
          >
            + Log a meal
          </button>
        )}
      </div>
    )
  }
  return (
    <ul
      className="relative mt-6 flex flex-col gap-3 pl-9 pr-4 before:absolute before:bottom-6 before:left-[22px] before:top-6 before:w-px before:content-[''] before:[background:linear-gradient(to_bottom,color-mix(in_oklab,var(--ux-accent-a)_55%,transparent),color-mix(in_oklab,var(--ux-accent-b)_30%,transparent))]"
    >
      {[...meals].reverse().map((meal) => {
        const totals = sumMacros(meal.items)
        const loggedAt = new Date(meal.loggedAt)
        // Full date + time (Phase 3 item 4) — loggedAt was already a full ISO timestamp end to
        // end (App.tsx/ConfirmLog write it, Postgres stores it as timestamptz), this component
        // was just formatting away the date part. Today's entries still read as time-only (that's
        // the common case and matches the existing Today-screen framing); anything from an
        // earlier day now shows its date too, so a meal from yesterday doesn't silently look like
        // it happened at "8:14 PM" today.
        const isToday = loggedAt.toDateString() === new Date().toDateString()
        const time = loggedAt.toLocaleTimeString('en-NZ', { hour: 'numeric', minute: '2-digit' })
        const dateTime = isToday
          ? time
          : `${loggedAt.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' })}, ${time}`
        const slot = mealSlotForHour(loggedAt.getHours())
        return (
          <li key={meal.id} className="glass-card relative flex items-center gap-3 p-2">
            {/* Timeline dot on the spine, tinted by time of day. */}
            <span
              aria-hidden
              className="absolute -left-[19px] top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full"
              style={{ background: slot.color, boxShadow: `0 0 10px 2px color-mix(in oklab, ${slot.color} 60%, transparent)` }}
            />
            {meal.photoDataUrl ? (
              <img src={meal.photoDataUrl} alt="" className="h-14 w-14 shrink-0 rounded-sm object-cover" />
            ) : (
              // Voice-logged meal — no photo. Time-of-day icon chip instead of an emoji tile.
              <div
                className="ux-icon-chip h-14 w-14 shrink-0 rounded-sm"
                style={{ ['--chip' as string]: slot.color }}
                role="img"
                aria-label={slot.label}
              >
                <slot.Icon size={22} strokeWidth={2} />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-body text-text-primary">{meal.items.map((i) => i.name).join(', ') || 'Untitled meal'}</p>
              <p className="text-caption text-text-tertiary">
                {slot.label} · {dateTime}
              </p>
              {/* Eating Out tag (Phase 3 item 3/4) — glass "windowed" chip in the same amber
                  (accent-energy) used for the ConfirmLog toggle, so the two agree visually. */}
              {meal.isEatingOut && (
                <p className="mt-0.5 truncate text-caption text-accent-energy">
                  🍽️ Eating out{meal.restaurantName ? ` · ${meal.restaurantName}` : ''}
                </p>
              )}
            </div>
            <span
              className="shrink-0 whitespace-nowrap rounded-full px-2.5 py-1 text-data font-semibold"
              style={{
                color: 'var(--color-accent-health)',
                background: 'color-mix(in oklab, var(--color-accent-health) 14%, transparent)',
                border: '1px solid color-mix(in oklab, var(--color-accent-health) 28%, transparent)',
              }}
            >
              {Math.round(totals.calories)} kcal
            </span>
          </li>
        )
      })}
    </ul>
  )
}
