import { RadialProgress } from '@/components/RadialProgress'
import { CountUp } from '@/components/CountUp'
import type { MacroTotals, Goals } from '@/lib/types'

export const MACRO_COLORS = { protein: '#f472b6', fat: '#fbbf24', carbs: '#60a5fa', fiber: '#84cc16', sugar: '#f87171' } as const

/**
 * Low-remaining threshold judgment call (the spec calls for "amber/crimson
 * glow shifts at low-remaining thresholds" but doesn't hand over exact
 * numbers) — remaining budget is amber under 25% of goal left, crimson
 * under 10% left or already over. Otherwise the ring stays Luminous
 * Emerald, the spec's health/success colour.
 */
export function ringColorForRemaining(remainingPct: number): string {
  if (remainingPct <= 10) return 'var(--color-accent-danger)'
  if (remainingPct <= 25) return 'var(--color-accent-energy)'
  return 'var(--color-accent-health)'
}

/**
 * NUTRYOS Dashboard Fluid Ring — Today screen's calorie ring + 3 nested
 * macro rings. Restyled visual layer only: same RadialProgress (SVG
 * stroke-dasharray/dashoffset, now GSAP elastic-fill) and CountUp (kinetic
 * digit count-up) components, same totals/goals data model.
 */
export function TodayRing({
  totals,
  goals,
  caloriesBurned = 0,
}: {
  totals: MacroTotals
  goals: Goals
  /** Today's real logged workout burn (see WorkoutTracker.tsx) — extends the effective calorie
   * budget the same way every mainstream calorie tracker treats exercise, rather than a workout
   * silently having no effect on "calories left". */
  caloriesBurned?: number
}) {
  const effectiveGoal = goals.calorieGoal + caloriesBurned
  const caloriePct = (totals.calories / effectiveGoal) * 100
  const remaining = Math.max(0, effectiveGoal - totals.calories)
  const remainingPct = (remaining / effectiveGoal) * 100
  const ringColor = ringColorForRemaining(remainingPct)
  // Gradient only while the ring is in its normal (healthy) state — amber/crimson warning colours
  // stay solid so the low-remaining signal is not diluted.
  const isHealthy = ringColor === 'var(--color-accent-health)'
  const macros = [
    { key: 'P', label: 'Protein', value: totals.proteinG, goal: goals.proteinGoalG, color: MACRO_COLORS.protein },
    { key: 'F', label: 'Fat', value: totals.fatG, goal: goals.fatGoalG, color: MACRO_COLORS.fat },
    { key: 'C', label: 'Carbs', value: totals.carbsG, goal: goals.carbsGoalG, color: MACRO_COLORS.carbs },
  ]

  return (
    <>
    <div data-tour="ring" className="relative mx-auto mt-2" style={{ width: 260, height: 260 }}>
      {/* Blurred halo behind the calorie ring, tinted by the ring's own state colour. */}
      <div
        aria-hidden
        className="pointer-events-none absolute rounded-full"
        style={{
          inset: -14,
          background: `radial-gradient(closest-side, color-mix(in oklab, ${isHealthy ? 'var(--ux-accent-a)' : ringColor} var(--ux-glow-pct), transparent), transparent 72%)`,
          filter: 'blur(18px)',
          opacity: 0.55,
        }}
      />
      <RadialProgress
        percent={caloriePct}
        color={ringColor}
        gradient={isHealthy ? ['var(--ux-accent-a)', 'var(--ux-accent-b)'] : undefined}
        size={260}
        strokeWidth={16}
      />
      <div className="absolute" style={{ inset: 30 }}>
        <RadialProgress
          percent={(totals.proteinG / goals.proteinGoalG) * 100}
          color={MACRO_COLORS.protein}
          size={200}
          strokeWidth={10}
          glow={false}
        />
      </div>
      <div className="absolute" style={{ inset: 56 }}>
        <RadialProgress
          percent={(totals.fatG / goals.fatGoalG) * 100}
          color={MACRO_COLORS.fat}
          size={148}
          strokeWidth={9}
          glow={false}
        />
      </div>
      <div className="absolute" style={{ inset: 80 }}>
        <RadialProgress
          percent={(totals.carbsG / goals.carbsGoalG) * 100}
          color={MACRO_COLORS.carbs}
          size={100}
          strokeWidth={8}
          glow={false}
        />
      </div>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="ux-hero-number text-display">
          <CountUp value={totals.calories} decimals={0} className="text-display" />
        </span>
        <span className="text-caption text-text-tertiary">
          of {effectiveGoal} kcal{caloriesBurned > 0 && ` (+${caloriesBurned} burned)`}
        </span>
        <span className="text-caption mt-1" style={{ color: ringColor }}>
          {Math.round(remaining)} kcal left
        </span>
      </div>
    </div>
    <ul data-tour="macros" className="mx-auto mt-4 flex max-w-md flex-wrap items-stretch justify-center gap-2 px-4" aria-label="Macros logged today">
      {macros.map((m) => (
        <li
          key={m.key}
          className="ux-glass relative flex min-w-0 items-center gap-2 px-3 pb-2 pt-1.5"
          style={{ borderRadius: 9999 }}
          aria-label={`${m.label} ${Math.round(m.value)} of ${Math.round(m.goal)} grams`}
        >
          <span
            className="flex h-5 w-5 flex-none items-center justify-center rounded-full text-[11px] font-bold"
            style={{ background: `color-mix(in oklab, ${m.color} 22%, transparent)`, color: m.color, boxShadow: `0 0 10px -3px ${m.color}` }}
            aria-hidden
          >
            {m.key}
          </span>
          <span className="whitespace-nowrap text-[13px] leading-5 text-text-secondary">
            <span className="font-semibold text-text-primary">{Math.round(m.value)}</span>/{Math.round(m.goal)}g
          </span>
          <span
            aria-hidden
            className="absolute bottom-1 left-3 right-3 h-[2px] overflow-hidden rounded-full"
            style={{ background: `color-mix(in oklab, ${m.color} 18%, transparent)` }}
          >
            <span
              className="block h-full rounded-full"
              style={{ width: `${Math.min(100, Math.max(0, m.goal > 0 ? (m.value / m.goal) * 100 : 0))}%`, background: m.color }}
            />
          </span>
        </li>
      ))}
    </ul>
    </>
  )
}
