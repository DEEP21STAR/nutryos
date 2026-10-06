import { useRef, useState } from 'react'
import { HELP_CARDS, clampIndex, indexFromScroll } from '@/lib/guidance'
import { prefersReducedMotion } from '@/lib/utils'
import { useFocusTrap } from '@/components/useFocusTrap'

/**
 * Swipeable help sheet: native scroll-snap for swipe, plus Back/Next buttons, tappable dots and
 * arrow keys. All copy is body size (16px) or larger.
 */
export function HelpCarousel({ onClose }: { onClose: () => void }) {
  const [index, setIndex] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const count = HELP_CARDS.length
  const isLast = index === count - 1

  useFocusTrap(rootRef, onClose)

  function goTo(i: number) {
    const el = scrollerRef.current
    const next = clampIndex(i, count)
    setIndex(next)
    el?.scrollTo({ left: next * el.clientWidth, behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
  }

  function onScroll() {
    const el = scrollerRef.current
    if (!el) return
    setIndex(indexFromScroll(el.scrollLeft, el.clientWidth, count))
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowRight') {
      e.preventDefault()
      goTo(index + 1)
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      goTo(index - 1)
    }
  }

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label="How NUTRYOS works"
      onKeyDown={onKeyDown}
      className="fixed inset-0 z-[70] flex flex-col bg-bg-primary text-text-primary"
    >
      <div className="glass flex items-center justify-between px-4 pt-[calc(env(safe-area-inset-top,0px)+12px)] pb-3">
        <button onClick={onClose} className="min-h-11 pr-3 text-body text-text-secondary">
          Close
        </button>
        <h2 className="text-body font-semibold">How NUTRYOS works</h2>
        <span className="w-14 text-right text-body text-text-tertiary" aria-hidden>
          {index + 1}/{count}
        </span>
      </div>

      <div
        ref={scrollerRef}
        onScroll={onScroll}
        aria-roledescription="carousel"
        className="flex flex-1 snap-x snap-mandatory overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {HELP_CARDS.map((card, i) => (
          <section
            key={card.title}
            role="group"
            aria-roledescription="slide"
            aria-label={`${i + 1} of ${count}: ${card.title}`}
            className="flex min-w-full snap-center items-center justify-center px-5"
          >
            <div className="glass-card flex w-full max-w-sm flex-col items-center gap-4 p-6 text-center">
              <span className="text-[56px] leading-none" aria-hidden>
                {card.icon}
              </span>
              <h3 className="text-title">{card.title}</h3>
              <p className="text-[18px] leading-relaxed text-text-secondary">{card.body}</p>
            </div>
          </section>
        ))}
      </div>

      <div className="flex flex-col items-center gap-3 px-4 pb-[calc(env(safe-area-inset-bottom,0px)+20px)] pt-2">
        <div className="flex items-center" role="group" aria-label="Choose a help card">
          {HELP_CARDS.map((card, i) => (
            <button
              key={card.title}
              onClick={() => goTo(i)}
              aria-label={`Card ${i + 1}: ${card.title}`}
              aria-current={i === index ? 'true' : undefined}
              className="grid h-8 w-8 place-items-center"
            >
              <span
                className="block rounded-full transition-all"
                style={{
                  width: i === index ? 22 : 10,
                  height: 10,
                  background: i === index ? 'var(--color-accent-health)' : 'rgb(255 255 255 / 0.28)',
                }}
              />
            </button>
          ))}
        </div>
        <div className="flex w-full max-w-sm gap-3">
          <button
            onClick={() => goTo(index - 1)}
            disabled={index === 0}
            className="min-h-12 flex-1 rounded-xl border border-white/10 bg-bg-secondary text-body text-text-secondary disabled:opacity-40"
          >
            Back
          </button>
          <button
            data-autofocus
            onClick={() => (isLast ? onClose() : goTo(index + 1))}
            className="min-h-12 flex-1 rounded-xl bg-accent-health text-body font-semibold text-bg-primary"
          >
            {isLast ? 'Done' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  )
}
