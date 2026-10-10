import { useEffect, useMemo, useState } from 'react'
import { Droplet, Candy, ShoppingBag, Copy } from 'lucide-react'
import type { Meal } from '@/lib/types'
import { listMealsSince } from '@/lib/mealsRepo'
import { getWaterHistory, WATER_GOAL_ML } from '@/lib/waterTracking'
import {
  crossedMilestone,
  dayKey,
  lowSugarStreak,
  nextMilestone,
  SUGAR_CAP_G,
  takeawayFreeStreak,
  takeawaySavings,
  DEFAULT_TAKEAWAYS_PER_WEEK,
  waterStreak,
} from '@/lib/habitStreaks'
import { fireConfetti } from '@/lib/confetti'
import { hapticSuccess, hapticTap } from '@/lib/haptics'

const HISTORY_DAYS = 100
const COST_KEY = 'nutrios.takeawayCost.v1'
const FREQ_KEY = 'nutrios.takeawaysPerWeek.v1'
const SEEN_KEY = 'nutrios.habitSeen.v1'

function readCost(): number | null {
  try {
    const n = Number(localStorage.getItem(COST_KEY))
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}
function readFreq(): number {
  try {
    const n = Number(localStorage.getItem(FREQ_KEY))
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_TAKEAWAYS_PER_WEEK
  } catch {
    return DEFAULT_TAKEAWAYS_PER_WEEK
  }
}
function readSeen(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) || '{}') as Record<string, number>
  } catch {
    return {}
  }
}

interface Tile {
  id: 'takeaway' | 'sugar' | 'water'
  title: string
  unit: string
  color: string
  icon: React.ReactNode
  streak: number
  hint: string
}

/**
 * Celebrates healthy-habit streaks on the Today tab: takeaway-free days, low-sugar days and water
 * goal days. Everything is computed from meal history (habitStreaks.ts) and the local water
 * history; the takeaway-savings figure is an estimate (days x the user's own typical takeaway
 * cost) and is labelled as one.
 */
export function HabitStreaks({ userId, todaysMealCount }: { userId: string | null; todaysMealCount: number }) {
  const [meals, setMeals] = useState<Meal[] | null>(null)
  const [tick, setTick] = useState(0)
  const [cost, setCost] = useState<number | null>(readCost)
  const [editing, setEditing] = useState(false)
  const [freq, setFreq] = useState<number>(readFreq)
  const [draft, setDraft] = useState('')
  const [freqDraft, setFreqDraft] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!userId) return
    let cancelled = false
    const since = new Date()
    since.setDate(since.getDate() - (HISTORY_DAYS - 1))
    since.setHours(0, 0, 0, 0)
    listMealsSince(userId, since.toISOString())
      .then((m) => { if (!cancelled) setMeals(m) })
      .catch(() => { if (!cancelled) setMeals([]) })
    return () => { cancelled = true }
  }, [userId, todaysMealCount])

  useEffect(() => {
    const on = () => setTick((t) => t + 1)
    window.addEventListener('nutrios-water', on)
    return () => window.removeEventListener('nutrios-water', on)
  }, [])

  const tiles: Tile[] | null = useMemo(() => {
    if (!meals) return null
    void tick
    const now = new Date()
    const tf = takeawayFreeStreak(meals, now)
    const ls = lowSugarStreak(meals, now)
    const ws = waterStreak(getWaterHistory(), WATER_GOAL_ML, now)
    return [
      { id: 'takeaway', title: 'No takeaways', unit: 'day', color: '#34d399', icon: <ShoppingBag size={16} />, streak: tf,
        hint: 'Logged days with no Eating Out meal' },
      { id: 'sugar', title: 'Low sugar', unit: 'day', color: '#f472b6', icon: <Candy size={16} />, streak: ls,
        hint: `Days with sugar data, at or under ${SUGAR_CAP_G} g` },
      { id: 'water', title: 'Water goal', unit: 'day', color: '#60a5fa', icon: <Droplet size={16} />, streak: ws,
        hint: `Days reaching ${(WATER_GOAL_ML / 1000).toFixed(1)} L` },
    ]
  }, [meals, tick])

  // One celebration per habit per milestone, remembered on this device.
  useEffect(() => {
    if (!tiles) return
    const seen = readSeen()
    let fired = false
    for (const t of tiles) {
      const m = crossedMilestone(t.streak)
      if (m && (seen[t.id] ?? 0) < m) {
        seen[t.id] = m
        fired = true
      }
    }
    if (fired) {
      try { localStorage.setItem(SEEN_KEY, JSON.stringify(seen)) } catch { /* ignore */ }
      hapticSuccess()
      fireConfetti()
    }
  }, [tiles])

  if (!tiles) return null
  const tf = tiles[0].streak
  const saved = takeawaySavings(tf, cost, freq)

  function saveCost() {
    const n = Number(draft)
    if (Number.isFinite(n) && n > 0) {
      setCost(n)
      try { localStorage.setItem(COST_KEY, String(n)) } catch { /* ignore */ }
    }
    const f = Number(freqDraft)
    if (Number.isFinite(f) && f > 0 && f <= 21) {
      setFreq(f)
      try { localStorage.setItem(FREQ_KEY, String(f)) } catch { /* ignore */ }
    }
    setEditing(false)
  }

  async function copyForClarity() {
    hapticTap()
    const code = `NUTRYOS-TF:${tf}:${dayKey(new Date())}:${cost ?? ''}:${freq}`
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* clipboard blocked */ }
  }

  return (
    <div className="glass-card mx-4 mt-4 flex w-[calc(100%-2rem)] flex-col gap-3 p-4" data-testid="habit-streaks">
      <div className="flex items-center justify-between">
        <span className="text-body font-semibold">Healthy habits</span>
        <span className="text-caption text-text-tertiary">Streaks, no pressure</span>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {tiles.map((t) => {
          const next = nextMilestone(t.streak)
          const pct = next ? Math.min(100, (t.streak / next) * 100) : 100
          return (
            <div
              key={t.id}
              title={t.hint}
              className="flex min-w-0 flex-col gap-1.5 rounded-xl border p-2.5"
              style={{ borderColor: `${t.color}44`, background: `${t.color}12` }}
            >
              <div className="flex flex-col gap-1" style={{ color: t.color }}>
                {t.icon}
                <span className="min-h-[2.2em] text-caption font-semibold leading-tight">{t.title}</span>
              </div>
              <p className="text-2xl font-bold leading-none" style={{ color: t.color, textShadow: `0 0 12px ${t.color}66` }}>
                {t.streak}
                <span className="ml-1 text-caption font-medium text-text-tertiary">{t.unit}{t.streak === 1 ? '' : 's'}</span>
              </p>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${pct}%`, background: t.color }} />
              </div>
              <p className="text-caption text-text-tertiary">
                {t.streak === 0 ? 'Start today' : next ? `${next - t.streak} to ${next}` : 'Top milestone'}
              </p>
            </div>
          )
        })}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-bg-secondary p-3">
        {saved !== null ? (
          <p className="text-caption">
            <span className="font-semibold text-accent-health">About ${saved.toFixed(2)} not spent</span>
            <span className="text-text-tertiary"> on takeaways (estimate: {tf} days, ${cost?.toFixed(2)} each, about {freq} a week before)</span>
          </p>
        ) : (
          <p className="text-caption text-text-tertiary">Add what a typical takeaway costs you to see your savings.</p>
        )}
        <div className="flex items-center gap-2">
          {editing ? (
            <>
              <input
                aria-label="Typical takeaway cost"
                inputMode="decimal"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') saveCost() }}
                placeholder="$ each"
                className="w-20 rounded-lg border border-white/10 bg-bg-primary px-2 py-1 text-caption"
              />
              <input
                aria-label="Takeaways per week before"
                inputMode="decimal"
                value={freqDraft}
                onChange={(e) => setFreqDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') saveCost() }}
                placeholder="per week"
                className="w-20 rounded-lg border border-white/10 bg-bg-primary px-2 py-1 text-caption"
              />
              <button onClick={saveCost} className="rounded-lg bg-accent-health px-2.5 py-1 text-caption font-semibold text-bg-primary">Save</button>
            </>
          ) : (
            <button
              onClick={() => { setDraft(cost ? String(cost) : ''); setFreqDraft(String(freq)); setEditing(true) }}
              className="rounded-lg border border-white/10 px-2.5 py-1 text-caption font-semibold"
            >
              {cost ? 'Edit cost' : 'Set cost'}
            </button>
          )}
          {tf > 0 && (
            <button
              onClick={copyForClarity}
              aria-label="Copy takeaway-free days for Clarity"
              className="flex items-center gap-1 rounded-lg border border-white/10 px-2.5 py-1 text-caption font-semibold"
            >
              <Copy size={12} /> {copied ? 'Copied' : 'For Clarity'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
