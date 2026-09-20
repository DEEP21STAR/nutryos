import { useMemo, useState } from 'react'
import type { FoodItem, Goals, MacroTotals } from '@/lib/types'
import { sumMacros, type Meal } from '@/lib/types'
import { cn, uid } from '@/lib/utils'
import { MACRO_COLORS } from '@/components/TodayRing'
import { GoalImpact } from '@/components/GoalImpact'
import { applyEatingOutAdjustment, findRepeatVisitSuggestion } from '@/lib/eatingOutAdjustment'
import { DAILY_VALUES, percentDV } from '@/lib/micronutrients'
import { isPremiumUnlocked } from '@/lib/premium'

/** Real device haptic tick on slider drag, when the API exists — degrades to nothing (no error, no fake motion) everywhere else. Not gated by prefers-reduced-motion: this is tactile, not visual/animated. */
function tick() {
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    try {
      navigator.vibrate(8)
    } catch {
      /* no-op — vibrate can throw on some locked-down browsers */
    }
  }
}

/**
 * Core-loop step 4: editable confirm-before-log step, restyled to the
 * NUTRYOS glass verification screen. The vision model + Open Food Facts
 * lookup pre-fill everything, but nothing is logged until the user taps
 * confirm — every field (name, grams, and the derived macros) is still
 * editable in case identification or the macro lookup was wrong. This is
 * also the manual-fallback surface: if photo ID/lookup failed entirely, the
 * item list starts empty and the user types a food in by hand.
 *
 * Data model / logic is untouched — `updateItem`/`removeItem`/`addBlankItem`
 * do exactly what they did before. The portion input changed from a plain
 * number box to a haptic-slider-style range control that calls the SAME
 * `updateItem(id, { estimatedGrams })`, nothing new invented underneath it.
 */
export function ConfirmLog({
  photoDataUrl,
  initialItems,
  pastMeals = [],
  initialIsEatingOut = false,
  initialRestaurantName = '',
  todaysTotals,
  goals,
  identificationNote = null,
  logSource = 'voice',
  onConfirm,
  onCancel,
}: {
  /** Null for a voice-logged OR barcode-scanned meal — neither has a captured photo, so the photo
   * block below renders a source-appropriate placeholder instead of an <img>. Defaults to 'voice'
   * so every existing call site (which really is always voice today) needs no change; only the
   * new barcode path passes 'barcode' explicitly. */
  photoDataUrl: string | null
  logSource?: 'voice' | 'barcode' | 'repeat'
  initialItems: FoodItem[]
  /** Already-logged meals (App.tsx's real Supabase-backed state), used only for the client-side
   * "you usually get X here" repeat-visit lookup (Phase 3, item 5) — no new query, no mutation. */
  pastMeals?: Meal[]
  /** Menu-mode entries arrive with Eating Out already on and a restaurant name pre-filled; every
   * other path defaults both off/blank but the toggle+field are available regardless (Phase 3,
   * item 3 — "Eating Out" must be settable on ANY entry, not just menu-mode ones). */
  initialIsEatingOut?: boolean
  initialRestaurantName?: string
  /** Today's totals from meals already logged, BEFORE this one — feeds the Goal Impact panel's
   * "projected end-of-day" math. Not optional: every real call site has this via App.tsx's
   * existing `totals` (sumMacros over already-logged meals), computed well before ConfirmLog
   * ever mounts. */
  todaysTotals: MacroTotals
  goals: Goals
  /** Real reason identification succeeded/failed (which endpoint, or the specific error) —
   * previously only shown on App.tsx's own header, which this full-screen overlay immediately
   * covers, so it was never actually visible to anyone. Surfaced here instead. */
  identificationNote?: string | null
  onConfirm: (meal: Meal) => void
  onCancel: () => void
}) {
  const [items, setItems] = useState<FoodItem[]>(initialItems)
  const [isEatingOut, setIsEatingOut] = useState(initialIsEatingOut)
  const [restaurantName, setRestaurantName] = useState(initialRestaurantName)
  const [suggestionDismissed, setSuggestionDismissed] = useState(false)
  // Snapshot of what vision/lookup actually produced at mount — used only for
  // the emerald "detected" tag overlay on the photo, never mutated, so items
  // added manually afterward correctly do NOT get relabeled as "detected".
  const [detectedNames] = useState<string[]>(() => initialItems.map((i) => i.name).filter((n) => n.trim().length > 0))

  // Repeat-visit memory (Phase 3, item 5 — stretch, but cheap once the lookup exists): recomputed
  // live as the restaurant name is typed/edited, not just once at mount.
  const suggestion = useMemo(
    () => (isEatingOut ? findRepeatVisitSuggestion(pastMeals, restaurantName) : null),
    [isEatingOut, pastMeals, restaurantName],
  )

  function applySuggestionItems() {
    if (!suggestion) return
    setItems((prev) => [
      ...prev,
      ...suggestion.sampleItems.map((it) => ({ ...it, id: uid(), adjustedForEatingOut: false })),
    ])
    setSuggestionDismissed(true)
  }

  function updateItem(id: string, patch: Partial<FoodItem>) {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)))
  }

  function removeItem(id: string) {
    setItems((prev) => prev.filter((it) => it.id !== id))
  }

  function addBlankItem() {
    setItems((prev) => [
      ...prev,
      { id: uid(), name: '', estimatedGrams: 100, calories: 0, proteinG: 0, fatG: 0, carbsG: 0 },
    ])
  }

  const totals = sumMacros(items)

  function confirm() {
    onConfirm({
      id: uid(),
      photoDataUrl,
      items: items.filter((it) => it.name.trim().length > 0),
      loggedAt: new Date().toISOString(),
      isEatingOut: isEatingOut || undefined,
      restaurantName: isEatingOut && restaurantName.trim() ? restaurantName.trim() : undefined,
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col overflow-y-auto bg-bg-primary text-text-primary">
      <div className="glass sticky top-0 z-10 flex items-center justify-between px-4 py-3">
        <button onClick={onCancel} className="text-caption text-text-tertiary">
          Cancel
        </button>
        <h2 className="text-caption uppercase tracking-wide text-text-secondary">Confirm meal</h2>
        <div className="w-12" />
      </div>

      <div className="relative mx-4 mt-4">
        {photoDataUrl ? (
          // Full photo, not cropped — was h-48 + object-cover, which forced every photo into a
          // fixed landscape-ish box and cut off whatever didn't fit (real bug: a portrait phone
          // photo lost its top/bottom). object-contain + a real background fills the letterbox
          // space instead of cropping content away.
          <img
            src={photoDataUrl}
            alt="Captured meal"
            className="max-h-[420px] w-full rounded-lg bg-bg-tertiary object-contain"
          />
        ) : logSource === 'barcode' ? (
          // Barcode-scanned meal — no photo exists, and it isn't voice either. Same "no photo,
          // real reason why" pattern as the voice placeholder below, just its own icon/color/
          // label so it doesn't misreport how this item was actually logged.
          <div className="glass-card flex h-32 w-full items-center justify-center gap-2 text-accent-health shadow-[0_0_24px_4px_var(--glow-health)]">
            <span className="text-2xl" aria-hidden>
              📦
            </span>
            <span className="text-body">Logged from barcode</span>
          </div>
        ) : logSource === 'repeat' ? (
          // Re-logged from a past meal (RecentMeals.tsx's long-press-to-edit path) — same pattern
          // as barcode/voice, its own icon/color so it reads as "repeated", not miscategorized.
          <div className="glass-card flex h-32 w-full items-center justify-center gap-2 text-accent-energy shadow-[0_0_24px_4px_var(--glow-energy)]">
            <span className="text-2xl" aria-hidden>
              🔁
            </span>
            <span className="text-body">Repeated from a past meal</span>
          </div>
        ) : (
          // Voice-logged meal — no photo exists. Same violet AI glow language
          // as the Input Orb's voice option, not a blank/broken-image look.
          <div className="glass-card flex h-32 w-full items-center justify-center gap-2 text-accent-ai shadow-[0_0_24px_4px_var(--glow-ai)]">
            <span className="text-2xl" aria-hidden>
              🎙️
            </span>
            <span className="text-body">Logged by voice</span>
          </div>
        )}
        <div className="pointer-events-none absolute inset-0 rounded-lg bg-gradient-to-t from-black/70 via-transparent to-transparent" />
        {detectedNames.length > 0 && (
          <div className="absolute inset-x-2 bottom-2 flex flex-wrap gap-1.5">
            {detectedNames.map((name, i) => (
              <span
                key={`${name}-${i}`}
                className="glass rounded-full border-accent-health/40 px-2.5 py-1 text-caption text-accent-health shadow-[0_0_10px_1px_var(--glow-health)]"
              >
                {name}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Eating Out tag — available on every path (photo/voice/menu), per Phase 3 item 3. Menu
          mode arrives with this already on and the name pre-filled; toggling it off here for a
          menu-mode entry is allowed (e.g. the dish was actually eaten at home from a takeaway
          container) — the tag reflects the user's real answer, not how the photo was captured. */}
      <div className="mx-4 mt-4">
        <button
          onClick={() => setIsEatingOut((v) => !v)}
          className={cn(
            'glass flex w-full items-center justify-between rounded-md px-4 py-2.5 text-body transition',
            isEatingOut ? 'text-accent-energy shadow-[0_0_16px_2px_var(--glow-energy)]' : 'text-text-secondary',
          )}
        >
          <span className="flex items-center gap-2">
            <span aria-hidden>🍽️</span> Eating Out
          </span>
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-caption',
              isEatingOut ? 'bg-accent-energy/20 text-accent-energy' : 'bg-bg-tertiary text-text-tertiary',
            )}
          >
            {isEatingOut ? 'On' : 'Off'}
          </span>
        </button>

        {isEatingOut && (
          <div className="glass-card mt-2 flex flex-col gap-2 p-3">
            <input
              value={restaurantName}
              onChange={(e) => {
                setRestaurantName(e.target.value)
                setSuggestionDismissed(false)
              }}
              placeholder="Restaurant / takeaway name (optional)"
              className="w-full rounded-sm bg-bg-tertiary px-2 py-1.5 text-body text-text-primary outline-none ring-1 ring-white/5 focus:ring-accent-ai"
            />
            {suggestion && !suggestionDismissed && (
              <div className="flex flex-col gap-2 rounded-sm bg-accent-ai/10 p-2.5 text-caption text-text-secondary ring-1 ring-accent-ai/25">
                <p>
                  You've logged <span className="text-accent-ai">{suggestion.restaurantName}</span>{' '}
                  {suggestion.visitCount} time{suggestion.visitCount === 1 ? '' : 's'} before — usually:{' '}
                  <span className="text-text-primary">{suggestion.commonItemNames.slice(0, 3).join(', ')}</span>
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={applySuggestionItems}
                    className="flex-1 rounded-full bg-accent-ai px-3 py-1.5 text-caption font-semibold text-white transition active:scale-95"
                  >
                    Add these items
                  </button>
                  <button
                    onClick={() => setSuggestionDismissed(true)}
                    className="rounded-full px-3 py-1.5 text-caption text-text-tertiary"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="mt-4 flex flex-col gap-3 px-4">
        {items.length === 0 && (
          <div className="flex flex-col gap-1.5 text-center">
            <p className="text-body text-text-tertiary">No items identified — add one manually below.</p>
            {identificationNote && (
              <p className="text-caption text-accent-danger/90">{identificationNote}</p>
            )}
          </div>
        )}
        {items.map((item) => (
          <div key={item.id} className="glass-card p-4">
            <div className="flex items-center gap-2">
              <input
                value={item.name}
                onChange={(e) => updateItem(item.id, { name: e.target.value })}
                placeholder="Food name"
                className="min-w-0 flex-1 rounded-sm bg-bg-tertiary px-2 py-1.5 text-body text-text-primary outline-none ring-1 ring-white/5 focus:ring-accent-ai"
              />
              <button
                onClick={() => removeItem(item.id)}
                aria-label="Remove item"
                className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-text-tertiary transition hover:bg-accent-danger/15 hover:text-accent-danger"
              >
                ✕
              </button>
            </div>

            {/* Real gap found 2026-09-20: a lookup miss (no Open Food Facts or common-foods match
                — Open Food Facts is a branded-product database, weakest on plain whole-food cuts)
                silently left every macro at 0, which read as "this food has zero nutrition"
                rather than "we couldn't find it, please fill this in" — exactly what happened with
                "Lamb Shank". item.offCode is only ever set when a lookup actually succeeded (see
                resolveFoodItems.ts), so its absence on a named item is the real, existing signal
                for this, not a new field. */}
            {item.name.trim().length > 0 && item.offCode === undefined && (
              <p className="mt-2 text-caption text-accent-energy">
                Couldn't find nutrition data for this — check the numbers below.
              </p>
            )}

            {/* Haptic-slider-style portion adjuster — real onChange -> updateItem, same estimatedGrams field as before. */}
            <div className="mt-3">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-caption text-text-tertiary">Portion</span>
                <span className="text-data text-accent-health">{item.estimatedGrams}g</span>
              </div>
              <input
                type="range"
                min={0}
                max={800}
                step={5}
                value={item.estimatedGrams}
                onChange={(e) => updateItem(item.id, { estimatedGrams: Number(e.target.value) })}
                onInput={tick}
                className="h-2 w-full cursor-pointer appearance-none rounded-full bg-bg-tertiary accent-accent-health
                  [&::-webkit-slider-thumb]:h-6 [&::-webkit-slider-thumb]:w-6 [&::-webkit-slider-thumb]:appearance-none
                  [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent-health
                  [&::-webkit-slider-thumb]:shadow-[0_0_10px_2px_var(--glow-health)] [&::-webkit-slider-thumb]:transition
                  [&::-webkit-slider-thumb]:active:scale-125
                  [&::-moz-range-thumb]:h-6 [&::-moz-range-thumb]:w-6 [&::-moz-range-thumb]:rounded-full
                  [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-accent-health
                  [&::-moz-range-thumb]:shadow-[0_0_10px_2px_var(--glow-health)]"
                aria-label={`${item.name || 'Item'} portion in grams`}
              />
            </div>

            <div className="mt-3 grid grid-cols-4 gap-2">
              <MacroField label="Kcal" value={item.calories} onChange={(v) => updateItem(item.id, { calories: v })} />
              <MacroField label="Protein" value={item.proteinG} onChange={(v) => updateItem(item.id, { proteinG: v })} color={MACRO_COLORS.protein} />
              <MacroField label="Fats" value={item.fatG} onChange={(v) => updateItem(item.id, { fatG: v })} color={MACRO_COLORS.fat} />
              <MacroField label="Carbs" value={item.carbsG} onChange={(v) => updateItem(item.id, { carbsG: v })} color={MACRO_COLORS.carbs} />
            </div>

            {/* Fiber/sugar only appear once a lookup actually provided them (common-foods dataset
                or an Open Food Facts match with that data) -- undefined on a manually-added item
                or an unmatched AI guess, so this row only shows real data, never a fabricated 0. */}
            {(item.fiberG !== undefined || item.sugarG !== undefined) && (
              <div className="mt-2 grid grid-cols-2 gap-2">
                <MacroField
                  label="Fiber"
                  value={item.fiberG ?? 0}
                  onChange={(v) => updateItem(item.id, { fiberG: v })}
                  color={MACRO_COLORS.fiber}
                />
                <MacroField
                  label="Sugar"
                  value={item.sugarG ?? 0}
                  onChange={(v) => updateItem(item.id, { sugarG: v })}
                  color={MACRO_COLORS.sugar}
                />
              </div>
            )}

            {item.micronutrients && <MicronutrientBadges micronutrients={item.micronutrients} />}

            {/* Restaurant-prep nudge (Phase 3, item 3) — only offered while Eating Out is on,
                one-shot per item (see eatingOutAdjustment.ts for the exact multiplier + the
                honest reasoning behind it), and always a manual tap — never applied silently. */}
            {isEatingOut && !item.adjustedForEatingOut && (
              <button
                onClick={() => updateItem(item.id, applyEatingOutAdjustment(item))}
                className="mt-2 w-full rounded-sm bg-accent-energy/10 py-1.5 text-caption text-accent-energy ring-1 ring-accent-energy/25 transition active:scale-[0.98]"
              >
                Adjust for restaurant prep (+15% kcal, +20% fat)
              </button>
            )}
            {isEatingOut && item.adjustedForEatingOut && (
              <p className="mt-2 text-center text-caption text-text-tertiary">Adjusted for restaurant prep ✓</p>
            )}
          </div>
        ))}
        <button
          onClick={addBlankItem}
          className="glass rounded-md border-dashed py-2.5 text-caption text-text-secondary transition active:scale-[0.98]"
        >
          + Add item manually
        </button>
      </div>

      <GoalImpact todaysTotals={todaysTotals} mealTotals={totals} goals={goals} />

      <div className="glass sticky bottom-0 mt-auto p-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-caption text-text-tertiary">Total</span>
          <span className="text-data text-text-primary">
            {Math.round(totals.calories)} kcal · P{Math.round(totals.proteinG)} F{Math.round(totals.fatG)} C
            {Math.round(totals.carbsG)}
            {!!totals.fiberG && ` · Fi${Math.round(totals.fiberG)}`}
            {!!totals.sugarG && ` Su${Math.round(totals.sugarG)}`}
          </span>
        </div>
        <button
          onClick={confirm}
          disabled={items.filter((it) => it.name.trim()).length === 0}
          className="w-full rounded-full bg-accent-health py-3 text-subtitle font-semibold text-bg-primary shadow-[0_0_28px_6px_var(--glow-health)] transition active:scale-[0.98] disabled:opacity-40 disabled:shadow-none"
        >
          Log this meal
        </button>
      </div>
    </div>
  )
}

/**
 * Free tier: 4 key micronutrients as real %DV badges (reads more premium than a raw mg number).
 * Premium tier: 4 more. Only ever shown for OFF-sourced items that actually have this data (see
 * FoodItem.micronutrients' own comment on scope) — never a fabricated 0.
 */
function MicronutrientBadges({ micronutrients }: { micronutrients: NonNullable<FoodItem['micronutrients']> }) {
  const premium = isPremiumUnlocked()
  const freeEntries: Array<[string, number | undefined, number]> = [
    ['Vit C', micronutrients.vitaminCMg, DAILY_VALUES.vitaminCMg],
    ['Calcium', micronutrients.calciumMg, DAILY_VALUES.calciumMg],
    ['Iron', micronutrients.ironMg, DAILY_VALUES.ironMg],
    ['Potassium', micronutrients.potassiumMg, DAILY_VALUES.potassiumMg],
  ]
  const premiumEntries: Array<[string, number | undefined, number]> = [
    ['Vit A', micronutrients.vitaminAMcg, DAILY_VALUES.vitaminAMcg],
    ['Vit B12', micronutrients.vitaminB12Mcg, DAILY_VALUES.vitaminB12Mcg],
    ['Magnesium', micronutrients.magnesiumMg, DAILY_VALUES.magnesiumMg],
    ['Zinc', micronutrients.zincMg, DAILY_VALUES.zincMg],
  ]
  const entries = premium ? [...freeEntries, ...premiumEntries] : freeEntries
  const visible = entries.filter(([, amount]) => amount !== undefined)
  if (visible.length === 0) return null

  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {visible.map(([label, amount, dv]) => {
        const pct = percentDV(amount, dv)
        return (
          <span
            key={label}
            className="rounded-full border border-accent-ai/30 bg-accent-ai/10 px-2 py-0.5 text-[11px] text-accent-ai"
          >
            {label} {pct}% DV
          </span>
        )
      })}
      {!premium && premiumEntries.some(([, amount]) => amount !== undefined) && (
        <span className="rounded-full border border-white/10 px-2 py-0.5 text-[11px] text-text-tertiary">
          +{premiumEntries.filter(([, amount]) => amount !== undefined).length} more with Premium
        </span>
      )}
    </div>
  )
}

/**
 * Per-macro "windowed" color differentiation, requested after Deep looked at
 * the confirm screen live: full words in title case ("Fats", not "F g"), each
 * macro visually distinct via its own tinted section — not just a plain
 * grid of identical gray boxes. Reuses TodayRing's MACRO_COLORS exactly, so
 * the dashboard rings and this confirm screen agree on which color means
 * which macro, rather than inventing a second palette.
 */
function MacroField({
  label,
  value,
  onChange,
  color,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  color?: string
}) {
  return (
    <label
      className="flex flex-col items-center gap-1 rounded-sm px-1 py-1.5 text-caption"
      style={
        color
          ? { backgroundColor: `${color}1a`, boxShadow: `inset 0 0 0 1px ${color}4d`, color }
          : { color: 'var(--color-text-tertiary)' }
      }
    >
      {label}
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full rounded-sm bg-bg-tertiary/60 px-1 py-1.5 text-center text-data text-text-primary outline-none ring-1 ring-white/5 focus:ring-accent-ai"
      />
    </label>
  )
}
