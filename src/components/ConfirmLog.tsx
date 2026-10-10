import { useMemo, useState } from 'react'
import type { FoodItem, Goals, MacroTotals } from '@/lib/types'
import { sumMacros, type Meal } from '@/lib/types'
import { cn, uid } from '@/lib/utils'
import { MACRO_COLORS } from '@/components/TodayRing'
import { GoalImpact } from '@/components/GoalImpact'
import { applyEatingOutAdjustment, findRepeatVisitSuggestion } from '@/lib/eatingOutAdjustment'
import { DAILY_VALUES, percentDV } from '@/lib/micronutrients'
import { isPremiumUnlocked } from '@/lib/premium'
import { badgeLabel, canLogMeal, itemNeedsNumbers, itemsNeedingNumbers } from '@/lib/mealGuards'
import { estimateMacrosViaCloud, getCloudAiOptIn, setCloudAiOptIn } from '@/lib/cloudAi'
import { itemFromAiEstimate } from '@/lib/resolveFoodItems'
import { CloudAiConsentSheet, type CloudAiChoice } from '@/components/CloudAiConsentSheet'

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
  // Phase 1 "never a silent 0": the item whose "Log with 0" confirm dialog is open, the items
  // waiting on the cloud-AI consent sheet, and the AI-estimate request state.
  const [zeroDialogFor, setZeroDialogFor] = useState<string | null>(null)
  const [consentFor, setConsentFor] = useState<string[] | null>(null)
  const [aiBusy, setAiBusy] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)
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

  /** Macro edits by hand: an item that had no numbers becomes "You entered". */
  function editMacros(item: FoodItem, patch: Partial<FoodItem>) {
    updateItem(item.id, item.source === 'unresolved' || itemNeedsNumbers(item) ? { ...patch, source: 'user', confidence: undefined, sourceRef: undefined } : patch)
  }

  async function runAiEstimate(ids: string[]) {
    const targets = items.filter((it) => ids.includes(it.id))
    if (targets.length === 0) return
    setAiBusy(true)
    setAiError(null)
    try {
      const estimates = await estimateMacrosViaCloud(targets.map((t) => ({ name: t.name, grams: t.estimatedGrams })))
      setItems((prev) =>
        prev.map((it) => {
          const k = targets.findIndex((t) => t.id === it.id)
          const est = k >= 0 ? estimates[k] : null
          return est ? { ...itemFromAiEstimate(it.name, it.estimatedGrams, est), id: it.id } : it
        }),
      )
      if (estimates.some((e) => !e)) setAiError("The AI couldn't estimate that one. Please type the numbers in.")
    } catch {
      setAiError('AI estimate is unavailable right now. Please type the numbers in.')
    } finally {
      setAiBusy(false)
    }
  }

  function requestAiEstimate(id: string) {
    if (getCloudAiOptIn()) runAiEstimate([id])
    else setConsentFor([id])
  }

  function onConsent(choice: CloudAiChoice) {
    const ids = consentFor ?? []
    setConsentFor(null)
    if (choice === 'private') return
    if (choice === 'always') setCloudAiOptIn(true)
    runAiEstimate(ids)
  }

  function confirmZero(id: string) {
    updateItem(id, { zeroConfirmed: true, source: 'user', confidence: undefined, sourceRef: 'Logged as 0 by you' })
    setZeroDialogFor(null)
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
  const needingNumbers = itemsNeedingNumbers(items)
  const zeroDialogItem = zeroDialogFor ? items.find((it) => it.id === zeroDialogFor) : undefined

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

            {/* Provenance badge (Phase 1): where these numbers came from, or "Needs numbers". */}
            {item.name.trim().length > 0 && <SourceBadge item={item} />}

            {/* Never a silent 0: an item with no numbers says so and offers the ways out. It also
                blocks "Log this meal" (mealGuards.canLogMeal) until it's dealt with. */}
            {itemNeedsNumbers(item) && (
              <div data-testid="needs-numbers" className="mt-2 flex flex-col gap-2 rounded-sm bg-accent-energy/10 p-2.5 ring-1 ring-accent-energy/30">
                <p className="text-caption text-accent-energy">
                  We couldn't find numbers for this. Type the kcal and macros below, or estimate them.
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => requestAiEstimate(item.id)}
                    disabled={aiBusy}
                    className="rounded-full bg-accent-ai/15 px-3 py-1.5 text-caption font-semibold text-accent-ai ring-1 ring-accent-ai/40 transition active:scale-95 disabled:opacity-50"
                  >
                    {aiBusy ? 'Estimating…' : 'Estimate with AI'}
                  </button>
                  <button
                    onClick={() => setZeroDialogFor(item.id)}
                    className="rounded-full px-3 py-1.5 text-caption text-text-secondary ring-1 ring-white/15 transition active:scale-95"
                  >
                    Log with 0 for this item
                  </button>
                </div>
              </div>
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
              <MacroField label="Kcal" value={item.calories} onChange={(v) => editMacros(item, { calories: v })} />
              <MacroField label="Protein" value={item.proteinG} onChange={(v) => editMacros(item, { proteinG: v })} color={MACRO_COLORS.protein} />
              <MacroField label="Fats" value={item.fatG} onChange={(v) => editMacros(item, { fatG: v })} color={MACRO_COLORS.fat} />
              <MacroField label="Carbs" value={item.carbsG} onChange={(v) => editMacros(item, { carbsG: v })} color={MACRO_COLORS.carbs} />
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

      <div className="glass sticky bottom-0 mt-auto bg-bg-primary p-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-caption text-text-tertiary">Total</span>
          <span className="text-data text-text-primary">
            {Math.round(totals.calories)} kcal · P{Math.round(totals.proteinG)} F{Math.round(totals.fatG)} C
            {Math.round(totals.carbsG)}
            {!!totals.fiberG && ` · Fi${Math.round(totals.fiberG)}`}
            {!!totals.sugarG && ` Su${Math.round(totals.sugarG)}`}
          </span>
        </div>
        {needingNumbers.length > 0 && (
          <p className="mb-2 text-center text-caption text-accent-energy" data-testid="log-blocked-reason">
            {needingNumbers.length === 1 ? '1 item needs numbers' : `${needingNumbers.length} items need numbers`} before this meal can be logged.
          </p>
        )}
        {aiError && <p className="mb-2 text-center text-caption text-accent-danger">{aiError}</p>}
        <button
          onClick={confirm}
          disabled={!canLogMeal(items)}
          className="w-full rounded-full bg-accent-health py-3 text-subtitle font-semibold text-bg-primary shadow-[0_0_28px_6px_var(--glow-health)] transition active:scale-[0.98] disabled:bg-bg-tertiary disabled:text-text-tertiary disabled:shadow-none"
        >
          Log this meal
        </button>
      </div>

      {zeroDialogItem && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-6" onClick={() => setZeroDialogFor(null)}>
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="zero-dialog-title"
            className="glass-card flex w-full max-w-xs flex-col gap-3 p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="zero-dialog-title" className="text-subtitle font-semibold text-text-primary">
              Log "{zeroDialogItem.name}" as 0 kcal?
            </h3>
            <p className="text-body text-text-secondary">
              Only do this for things with no calories, like water or black coffee. Otherwise your day's total will be too low.
            </p>
            <div className="flex gap-2">
              <button onClick={() => setZeroDialogFor(null)} className="flex-1 rounded-full px-3 py-2.5 text-body text-text-secondary ring-1 ring-white/15">
                Cancel
              </button>
              <button
                onClick={() => confirmZero(zeroDialogItem.id)}
                className="flex-1 rounded-full bg-accent-energy px-3 py-2.5 text-body font-semibold text-bg-primary"
              >
                Log with 0
              </button>
            </div>
          </div>
        </div>
      )}

      {consentFor && (
        <CloudAiConsentSheet
          foodNames={items.filter((it) => consentFor.includes(it.id)).map((it) => `${it.name}, ${it.estimatedGrams} g`)}
          onChoose={onConsent}
        />
      )}
    </div>
  )
}

const BADGE_TONES: Record<string, string> = {
  needs: 'bg-accent-energy/15 text-accent-energy ring-accent-energy/40',
  ai: 'bg-accent-ai/15 text-accent-ai ring-accent-ai/40',
  user: 'bg-white/5 text-text-secondary ring-white/15',
  sourced: 'bg-accent-health/10 text-accent-health ring-accent-health/35',
}

/** Per-item provenance badge: source + confidence, with the exact record underneath. */
function SourceBadge({ item }: { item: FoodItem }) {
  const needs = itemNeedsNumbers(item)
  const tone = needs ? 'needs' : item.source === 'ai-estimate' ? 'ai' : item.source === 'user' ? 'user' : 'sourced'
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
      <span
        data-testid="source-badge"
        data-source={needs ? 'needs-numbers' : (item.source ?? 'legacy')}
        className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1', BADGE_TONES[tone])}
      >
        {badgeLabel(item)}
        {!needs && item.confidence ? ` · ${item.confidence}` : ''}
      </span>
      {!needs && item.sourceRef && <span className="text-[11px] text-text-tertiary">{item.sourceRef}</span>}
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
