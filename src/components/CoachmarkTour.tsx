import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { TOUR_STEPS, cardPlacement } from '@/lib/guidance'
import { prefersReducedMotion } from '@/lib/utils'
import { useFocusTrap } from '@/components/useFocusTrap'

interface Box {
  top: number
  left: number
  width: number
  height: number
}

const PAD = 8

/**
 * First-run spotlight tour. The dimmed layer ignores pointer events, so the app underneath stays
 * tappable and the tour can never block logging; the card is the only interactive part. Skip is
 * always visible, Escape skips, and Tab stays inside the card. If a target is missing on screen
 * the step is skipped rather than shown pointing at nothing.
 */
export function CoachmarkTour({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0)
  const [box, setBox] = useState<Box | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const reduced = prefersReducedMotion()
  const current = TOUR_STEPS[step]
  const isLast = step === TOUR_STEPS.length - 1

  useFocusTrap(cardRef, onDone)

  const measure = useCallback(() => {
    const el = document.querySelector<HTMLElement>(`[data-tour="${current.target}"]`)
    if (!el) {
      setBox(null)
      return false
    }
    const r = el.getBoundingClientRect()
    setBox({ top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 })
    return true
  }, [current.target])

  useLayoutEffect(() => {
    const el = document.querySelector<HTMLElement>(`[data-tour="${current.target}"]`)
    if (!el) {
      // Nothing to point at: move on (or finish) instead of showing an orphan card.
      if (isLast) onDone()
      else setStep((s) => s + 1)
      return
    }
    el.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' })
    measure()
    // Keep the spotlight glued to the target while the smooth scroll settles, and on resize.
    const until = performance.now() + 800
    let raf = 0
    const tick = () => {
      measure()
      if (performance.now() < until) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, { passive: true })
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  const vh = typeof window === 'undefined' ? 800 : window.innerHeight
  const placement = box ? cardPlacement({ top: box.top, bottom: box.top + box.height }, vh) : 'below'
  const cardStyle: React.CSSProperties = box
    ? placement === 'below'
      ? { top: Math.min(box.top + box.height + 14, vh - 230) }
      : { bottom: Math.max(vh - box.top + 14, 14) }
    : { bottom: 24 }

  return (
    <>
      {box && (
        <div
          aria-hidden
          className="pointer-events-none fixed z-[60]"
          style={{
            top: box.top,
            left: box.left,
            width: box.width,
            height: box.height,
            borderRadius: 20,
            boxShadow: '0 0 0 9999px rgb(0 0 0 / 0.72), 0 0 0 2px var(--color-accent-health), 0 0 24px 2px var(--glow-health)',
            transition: reduced ? 'none' : 'top 250ms ease, left 250ms ease, width 250ms ease, height 250ms ease',
          }}
        />
      )}
      <div
        ref={cardRef}
        role="dialog"
        aria-labelledby="tour-title"
        aria-describedby="tour-body"
        tabIndex={-1}
        className="glass-card fixed inset-x-4 z-[61] mx-auto flex max-w-sm flex-col gap-3 p-4"
        style={cardStyle}
      >
        <div aria-live="polite" className="flex flex-col gap-1">
          <p className="text-caption uppercase tracking-wide text-text-tertiary">
            Step {step + 1} of {TOUR_STEPS.length}
          </p>
          <h2 id="tour-title" className="text-subtitle font-semibold text-text-primary">
            {current.title}
          </h2>
          <p id="tour-body" className="text-body text-text-secondary">
            {current.body}
          </p>
        </div>
        <div className="flex items-center justify-between gap-2">
          <button onClick={onDone} className="min-h-11 px-2 text-body text-text-tertiary underline">
            Skip tour
          </button>
          <div className="flex gap-2">
            {step > 0 && (
              <button
                onClick={() => setStep((s) => s - 1)}
                className="min-h-11 rounded-xl border border-white/10 bg-bg-secondary px-4 text-body text-text-secondary"
              >
                Back
              </button>
            )}
            <button
              data-autofocus
              onClick={() => (isLast ? onDone() : setStep((s) => s + 1))}
              className="min-h-11 rounded-xl bg-accent-health px-5 text-body font-semibold text-bg-primary"
            >
              {isLast ? 'Done' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
