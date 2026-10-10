import type { ReactNode } from 'react'
import { TodayTabIcon, ProgressTabIcon, TogetherTabIcon } from '@/components/TabIcons'
import { cn } from '@/lib/utils'

export type TabKey = 'today' | 'progress' | 'together'

const TABS: Array<{ key: TabKey; label: string; Icon: typeof TodayTabIcon }> = [
  { key: 'today', label: 'Today', Icon: TodayTabIcon },
  { key: 'progress', label: 'Progress', Icon: ProgressTabIcon },
  { key: 'together', label: 'Together', Icon: TogetherTabIcon },
]

/** Same three accent/glow pairs TabIcons.tsx already lights the icons up with — reused here so
 * the active label glows the same colour as its icon instead of staying plain white, one lighting
 * system across icon + underline + text rather than three independent choices. */
const TAB_ACCENT: Record<TabKey, { color: string; glow: string }> = {
  today: { color: 'var(--color-accent-health)', glow: 'var(--glow-health)' },
  progress: { color: 'var(--color-accent-energy)', glow: 'var(--glow-energy)' },
  together: { color: 'var(--color-accent-ai)', glow: 'var(--glow-ai)' },
}

/**
 * Replaces the old single-scroll layout (Today ring → Achievements →
 * Together Mode → Trends, all stacked forever) with three real sections
 * behind their own tab, per Deep: "we don't want one long scroll going
 * through everything." Sits fixed at the very bottom; the input orb
 * (App.tsx) floats just above it, unaffected by which tab is active since
 * logging a meal is a global action, not a per-tab one.
 */
export function TabBar({ active, onChange, fab }: { active: TabKey; onChange: (tab: TabKey) => void; fab?: ReactNode }) {
  return (
    // Docked: the camera FAB lives in its own row of this bar (not floating over page content), and
    // the bar background is near-opaque (96%) so scrolling text never shows through it.
    <nav
      data-tour="tabbar"
      className="glass fixed inset-x-0 bottom-0 z-30 flex flex-col border-t border-white/5 pb-[env(safe-area-inset-bottom,0px)]"
      style={{
        background: 'color-mix(in srgb, var(--color-bg-primary) 96%, transparent)',
        backdropFilter: 'blur(24px) saturate(180%)',
        WebkitBackdropFilter: 'blur(24px) saturate(180%)',
      }}
    >
      {fab && <div className="flex justify-center pt-2">{fab}</div>}
      <div className="flex items-stretch justify-around">
      {TABS.map(({ key, label, Icon }) => {
        const isActive = active === key
        const accent = TAB_ACCENT[key]
        return (
          <button
            key={key}
            onClick={() => onChange(key)}
            aria-current={isActive ? 'page' : undefined}
            className="flex flex-1 items-center justify-center py-2 transition active:scale-95"
          >
            {/* Active tab = glass pill glowing in its own accent (--ux-accent-a is re-pointed per
                tab so --ux-glow-sm picks up that tab's colour). Inactive keeps the bare icon+label. */}
            <span
              className={cn(
                'flex flex-col items-center gap-1 rounded-2xl border px-5 py-1.5 transition-all duration-300',
                isActive ? '' : 'border-transparent',
              )}
              style={
                isActive
                  ? ({
                      ['--ux-accent-a' as string]: accent.color,
                      background: `linear-gradient(155deg, color-mix(in oklab, ${accent.color} 20%, transparent), color-mix(in oklab, ${accent.color} 6%, transparent))`,
                      borderColor: `color-mix(in oklab, ${accent.color} 32%, transparent)`,
                      boxShadow: 'var(--ux-glass-edge), var(--ux-glow-sm)',
                    } as React.CSSProperties)
                  : undefined
              }
            >
              <Icon active={isActive} />
              <span
                className={cn('text-caption transition-colors', isActive ? 'font-semibold' : 'text-text-muted')}
                style={isActive ? { color: accent.color, textShadow: `0 0 8px ${accent.glow}` } : undefined}
              >
                {label}
              </span>
            </span>
          </button>
        )
      })}
      </div>
    </nav>
  )
}
