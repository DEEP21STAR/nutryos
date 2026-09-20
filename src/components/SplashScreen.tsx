import { useEffect, useRef } from 'react'
import gsap from 'gsap'
import { SPLASH_CATEGORIES } from '@/lib/splashCategories'
import { playBrandChime } from '@/lib/chime'
import { getCachedDisplayName } from '@/lib/displayNameCache'

const INTRO_SEEN_KEY = 'nutrios.introSeen.v1'

const CATEGORY_ENTER = 0.45
const CATEGORY_HOLD = 1.35
const CATEGORY_EXIT = 0.3
const CATEGORY_BEAT = CATEGORY_ENTER + CATEGORY_HOLD + CATEGORY_EXIT

const PARTICLE_ANGLES = [0, 45, 90, 135, 180, 225, 270, 315]

const WORDMARK_LETTERS = [
  { ch: 'N', color: '#00e5a0' },
  { ch: 'U', color: '#00d4c4' },
  { ch: 'T', color: '#10d8ff' },
  { ch: 'R', color: '#8b5cf6' },
  { ch: 'Y', color: '#c040ff' },
]
const RING_COLOR = '#00e5a0'
const S_COLOR = '#ffb800'

// Each phrase gets its own solid NUTRYOS accent color + neon pulse (see .splash-tagline-word in
// index.css) rather than one shared gradient — see that CSS comment for why the swap happened.
const TAGLINE_WORDS = [
  { text: 'EAT SMART', color: '#00e5a0' },
  { text: '·', color: null },
  { text: 'TRAIN HARD', color: '#8b5cf6' },
  { text: '·', color: null },
  { text: 'TRACK REAL', color: '#ffb800' },
]

const LETTER_ENTER = 0.45
const LETTER_STAGGER = 0.09
const WORDMARK_ENTER_TOTAL = LETTER_ENTER + LETTER_STAGGER * (WORDMARK_LETTERS.length + 1)
const HOLD_1_MS = 1100 // wordmark + tagline sitting fully readable
const TAGLINE_OUT_MS = 450
const SMILE_MS = 500
const HOLD_2_MS = 400 // beat on the smile before the zoom
const ZOOM_MS = 550

// Brand stamp — Deep's real report: on first run, the category tour plays for several seconds
// before the logo ever appears, so the brand isn't actually visible until the very end. This is
// a quick, distinct "stamp" (just the ring mark, no wordmark text) shown for a beat BEFORE the
// tour starts, bookending the splash with the brand instead of only closing on it. Deliberately
// not a second full wordmark reveal — that would just repeat the finale rather than read as its
// own moment, the same "Netflix ta-dum, then the real content" idea Deep referenced earlier.
const INTRO_STAMP_ENTER = 0.4
const INTRO_STAMP_HOLD = 1.6
const INTRO_STAMP_EXIT = 0.35

/**
 * Time-of-day greeting (2026-09-20, Deep's ask) — the stamp moment now always plays (previously
 * first-run only) and doubles as "Good Morning"/"Good Afternoon"/"Good Evening", plus the user's
 * own name once one exists. Read once per mount, same "compute once, doesn't change during this
 * component's short life" pattern as speechSupported/reducedMotion elsewhere in this codebase —
 * a real Date read, not a placeholder. Folds the small overnight window into "Evening" rather than
 * inventing a fourth "Good Night" state Deep didn't ask for.
 */
function getGreetingPeriod(): string {
  const hour = new Date().getHours()
  if (hour >= 5 && hour < 12) return 'Morning'
  if (hour >= 12 && hour < 17) return 'Afternoon'
  return 'Evening'
}

/**
 * Real 100°-wide bottom arc of the same ring (r=38, center 50,50) the "O" circle already uses —
 * computed directly (θ=35°..145° through the bottom, sweep-flag 1 for the clockwise/y-down
 * direction that traces the BOTTOM of the circle, not the top) rather than eyeballed, so it lines
 * up exactly with the ring it's crossfading against.
 */
const SMILE_ARC_D = 'M 81.13 71.80 A 38 38 0 0 1 18.87 71.80'

/**
 * Two versions of the same splash. First-ever open plays the full six-category tour; every later
 * open plays a short version straight to the wordmark (see INTRO_SEEN_KEY).
 *
 * The wordmark ending is its own small sequence, each beat with a real in-and-out, not one static
 * card: letters pop in → tagline words stagger in → hold → tagline staggers back out → the ring
 * crossfades into a matching smile arc → a beat → the whole mark zooms forward and fades while the
 * iris-wipe reveals the real app.
 *
 * Every meaningful HOLD here is its own setTimeout-anchored step, not a `.to({}, {duration})`
 * inside one continuous GSAP timeline. That matters: a GSAP timeline tracks real elapsed time, so
 * if the render thread stalls even briefly (screen-recording overhead, a backgrounded tab), it
 * "catches up" by jumping straight through every tween that should already have played — which is
 * exactly what once made the wordmark flash for a fraction of a second and vanish on a real
 * device recording. Scheduling each hold fresh, only once the animation before it genuinely
 * finishes, means it can't inherit a timing debt from earlier in the sequence.
 *
 * The splash must never be able to trap someone behind it. `finish()` is guarded so it only fires
 * once, and a plain `setTimeout` watchdog calls it unconditionally after the animation's own
 * worst-case duration as a last-resort guarantee.
 */
export function SplashScreen({ onDone }: { onDone: () => void }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const introStampRef = useRef<HTMLDivElement>(null)
  const categoryRefs = useRef<(HTMLDivElement | null)[]>([])
  const particleRefs = useRef<(HTMLDivElement | null)[]>([])
  const dotRefs = useRef<(HTMLDivElement | null)[]>([])
  const dotsRowRef = useRef<HTMLDivElement>(null)
  const wordmarkRef = useRef<HTMLDivElement>(null)
  const letterRefs = useRef<(HTMLSpanElement | null)[]>([])
  const ringWrapRef = useRef<HTMLDivElement>(null)
  const ringCircleRef = useRef<SVGCircleElement>(null)
  const smilePathRef = useRef<SVGPathElement>(null)
  const sRef = useRef<HTMLSpanElement>(null)
  const taglineWordRefs = useRef<(HTMLSpanElement | null)[]>([])
  const finishRef = useRef<() => void>(() => {})
  const tlRef = useRef<gsap.core.Timeline | null>(null)

  const cachedName = useRef(getCachedDisplayName()).current
  const greetingPeriod = useRef(getGreetingPeriod()).current

  function handleSkip() {
    tlRef.current?.kill()
    finishRef.current()
  }

  useEffect(() => {
    const isFirstRun = !localStorage.getItem(INTRO_SEEN_KEY)
    try {
      localStorage.setItem(INTRO_SEEN_KEY, '1')
    } catch {
      // Private-browsing / storage-blocked: replay the full tour next time rather than crash.
    }

    const categoryTotal = isFirstRun ? SPLASH_CATEGORIES.length * CATEGORY_BEAT : 0
    // Stamp+greeting now always plays (previously first-run only) — see the timeline build below.
    const introStampTotal = INTRO_STAMP_ENTER + INTRO_STAMP_HOLD + INTRO_STAMP_EXIT
    const totalEstimateMs =
      (introStampTotal + categoryTotal + WORDMARK_ENTER_TOTAL) * 1000 +
      HOLD_1_MS +
      TAGLINE_OUT_MS +
      SMILE_MS +
      HOLD_2_MS +
      ZOOM_MS

    let done = false
    const finish = () => {
      if (done) return
      done = true
      onDone()
    }
    finishRef.current = finish
    const watchdog = setTimeout(finish, totalEstimateMs + 3000)

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduceMotion) {
      const t = setTimeout(finish, 500)
      return () => {
        clearTimeout(watchdog)
        clearTimeout(t)
      }
    }

    const tl = gsap.timeline()
    tlRef.current = tl

    // Greeting stamp — always plays now (was first-run only), since it's the personalized
    // "Good Afternoon, Deep" moment Deep wants on every load, not just the first one.
    tl.call(() => playBrandChime())
    tl.fromTo(
      introStampRef.current,
      { opacity: 0, scale: 0.5 },
      { opacity: 1, scale: 1, duration: INTRO_STAMP_ENTER, ease: 'back.out(2.2)' },
    )
    tl.to({}, { duration: INTRO_STAMP_HOLD })
    tl.to(introStampRef.current, { opacity: 0, scale: 0.8, duration: INTRO_STAMP_EXIT, ease: 'power1.in' })

    if (isFirstRun) {
      SPLASH_CATEGORIES.forEach((cat, i) => {
        const el = categoryRefs.current[i]
        const dot = dotRefs.current[i]
        const particles = particleRefs.current.slice(i * 8, i * 8 + 8)

        tl.addLabel(`cat${i}`)
        tl.set(dot, { backgroundColor: cat.color, scale: 1.4 }, `cat${i}`)
        if (i > 0) tl.set(dotRefs.current[i - 1], { scale: 1, backgroundColor: 'rgb(255 255 255 / 0.25)' }, `cat${i}`)

        tl.fromTo(
          el,
          { opacity: 0, scale: 0.6, y: 10 },
          { opacity: 1, scale: 1, y: 0, duration: CATEGORY_ENTER, ease: 'back.out(1.8)' },
          `cat${i}`,
        )
        particles.forEach((p, pi) => {
          if (!p) return
          const angle = (PARTICLE_ANGLES[pi] * Math.PI) / 180
          const radius = 90
          gsap.set(p, { x: 0, y: 0, opacity: 1, scale: 1, backgroundColor: cat.color })
          tl.to(
            p,
            { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, opacity: 0, scale: 0.2, duration: 0.55, ease: 'power2.out' },
            '<',
          )
        })
        tl.to({}, { duration: CATEGORY_HOLD })
        tl.to(el, { opacity: 0, scale: 0.85, duration: CATEGORY_EXIT, ease: 'power1.in' })
      })
    }

    // Dots belong to the category tour only — hidden the moment we move on to the wordmark, not
    // left sitting underneath it.
    tl.to(dotsRowRef.current, { opacity: 0, duration: 0.25 })
    tl.set(wordmarkRef.current, { opacity: 1 }, '<')
    tl.call(() => playBrandChime())
    const popTargets = [...letterRefs.current, ringWrapRef.current, sRef.current]
    tl.fromTo(
      popTargets,
      { opacity: 0, scale: 2.6, y: 4 },
      { opacity: 1, scale: 1, y: 0, duration: LETTER_ENTER, ease: 'back.out(2.4)', stagger: LETTER_STAGGER },
    )
    tl.fromTo(
      taglineWordRefs.current,
      { opacity: 0, y: 6 },
      { opacity: 1, y: 0, duration: 0.35, ease: 'power2.out', stagger: 0.06 },
      '-=0.15',
    )

    tl.eventCallback('onComplete', () => {
      setTimeout(() => {
        gsap
          .timeline({
            onComplete: () => {
              setTimeout(() => {
                gsap.timeline({ onComplete: finish }).to(
                  [wordmarkRef.current],
                  { scale: 3.2, opacity: 0, duration: ZOOM_MS / 1000, ease: 'power2.in' },
                  0,
                ).to(rootRef.current, { clipPath: 'circle(0% at 50% 50%)', duration: ZOOM_MS / 1000, ease: 'power2.in' }, 0)
              }, HOLD_2_MS)
            },
          })
          .to(taglineWordRefs.current, {
            opacity: 0,
            y: -6,
            duration: TAGLINE_OUT_MS / 1000,
            ease: 'power1.in',
            stagger: 0.04,
          })
          .to(ringCircleRef.current, { opacity: 0, duration: SMILE_MS / 1000, ease: 'power2.inOut' }, '<')
          .fromTo(
            smilePathRef.current,
            { opacity: 0, scale: 0.7 },
            { opacity: 1, scale: 1, duration: SMILE_MS / 1000, ease: 'back.out(1.6)', transformOrigin: '50% 50%' },
            '<',
          )
      }, HOLD_1_MS)
    })

    return () => {
      clearTimeout(watchdog)
      tl.kill()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once for the splash's one real lifecycle
  }, [])

  return (
    <div
      ref={rootRef}
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center overflow-hidden bg-bg-primary"
      style={{
        clipPath: 'circle(150% at 50% 50%)',
        backgroundImage:
          'radial-gradient(ellipse 70% 55% at 50% 42%, rgb(0 229 160 / 0.14) 0%, rgb(139 92 246 / 0.07) 45%, transparent 75%)',
      }}
    >
      <div ref={introStampRef} className="absolute z-10 flex flex-col items-center gap-4 px-6" style={{ opacity: 0 }}>
        <div className="flex items-center justify-center" style={{ width: 72, height: 72 }}>
          <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%', filter: `drop-shadow(0 0 18px ${RING_COLOR})` }}>
            <circle cx="50" cy="50" r="38" fill="none" stroke={RING_COLOR} strokeWidth="9" />
          </svg>
        </div>
        <p
          className="text-center font-semibold tracking-[0.12em]"
          style={{ fontSize: 'clamp(18px, 4vh, 26px)', color: 'rgb(255 255 255 / 0.85)', fontFamily: 'var(--font-display)' }}
        >
          Good {greetingPeriod}
          {cachedName && (
            <>
              , <span className="splash-greeting-name">{cachedName}</span>
            </>
          )}
        </p>
      </div>

      <div className="relative flex h-[40vh] w-full items-center justify-center">
        {SPLASH_CATEGORIES.map((cat, i) => {
          const Icon = cat.Icon
          return (
            <div
              key={cat.id}
              ref={(el) => {
                categoryRefs.current[i] = el
              }}
              className="absolute flex flex-col items-center gap-[2vh]"
              style={{ opacity: 0 }}
            >
              <div className="relative flex items-center justify-center">
                {Array.from({ length: 8 }).map((_, pi) => (
                  <div
                    key={pi}
                    ref={(el) => {
                      particleRefs.current[i * 8 + pi] = el
                    }}
                    className="absolute h-1.5 w-1.5 rounded-full"
                    style={{ opacity: 0 }}
                  />
                ))}
                <Icon
                  style={{
                    width: 'clamp(120px, 20vh, 200px)',
                    height: 'clamp(120px, 20vh, 200px)',
                    color: cat.color,
                    filter: `drop-shadow(0 0 22px ${cat.color})`,
                  }}
                  strokeWidth={1.6}
                />
              </div>
              <span
                className="font-bold tracking-[0.25em]"
                style={{
                  fontSize: 'clamp(16px, 3.2vh, 24px)',
                  color: cat.color,
                  fontFamily: 'var(--font-display)',
                  filter: `drop-shadow(0 0 14px ${cat.color})`,
                }}
              >
                {cat.label}
              </span>
            </div>
          )
        })}
      </div>

      <div ref={dotsRowRef} className="mb-[6vh] flex gap-2">
        {SPLASH_CATEGORIES.map((cat, i) => (
          <div
            key={cat.id}
            ref={(el) => {
              dotRefs.current[i] = el
            }}
            className="h-1.5 w-5 rounded-full"
            style={{ backgroundColor: 'rgb(255 255 255 / 0.25)' }}
          />
        ))}
      </div>

      <div className="absolute flex flex-col items-center gap-[1.4vh]" style={{ opacity: 0 }} ref={wordmarkRef}>
        <div className="flex items-center" style={{ fontFamily: 'var(--font-display)' }}>
          {WORDMARK_LETTERS.map((l, i) => (
            <span
              key={l.ch}
              ref={(el) => {
                letterRefs.current[i] = el
              }}
              className="inline-block font-bold tracking-[0.14em]"
              style={{
                fontSize: 'clamp(28px, 6.5vh, 52px)',
                color: l.color,
                filter: `drop-shadow(0 0 16px ${l.color})`,
                opacity: 0,
              }}
            >
              {l.ch}
            </span>
          ))}
          <div
            ref={ringWrapRef}
            className="relative inline-flex items-center justify-center"
            style={{ opacity: 0, margin: '0 0.05em' }}
          >
            <svg
              viewBox="0 0 100 100"
              style={{
                width: 'clamp(24px, 5.4vh, 42px)',
                height: 'clamp(24px, 5.4vh, 42px)',
                filter: `drop-shadow(0 0 14px ${RING_COLOR})`,
                overflow: 'visible',
              }}
            >
              <circle ref={ringCircleRef} cx="50" cy="50" r="38" fill="none" stroke={RING_COLOR} strokeWidth="9" />
              <path
                ref={smilePathRef}
                d={SMILE_ARC_D}
                fill="none"
                stroke={RING_COLOR}
                strokeWidth="9"
                strokeLinecap="round"
                style={{ opacity: 0 }}
              />
            </svg>
          </div>
          <span
            ref={sRef}
            className="inline-block font-bold tracking-[0.14em]"
            style={{
              fontSize: 'clamp(28px, 6.5vh, 52px)',
              color: S_COLOR,
              filter: `drop-shadow(0 0 16px ${S_COLOR})`,
              opacity: 0,
            }}
          >
            S
          </span>
        </div>
        <div className="flex gap-1.5 text-caption font-semibold tracking-[0.3em]">
          {TAGLINE_WORDS.map((word, i) => (
            <span
              key={i}
              ref={(el) => {
                taglineWordRefs.current[i] = el
              }}
              className={word.color ? 'splash-tagline-word' : undefined}
              style={{ opacity: 0, display: 'inline-block', color: word.color ?? 'rgb(255 255 255 / 0.4)' }}
            >
              {word.text}
            </span>
          ))}
        </div>
      </div>

      <button
        onClick={handleSkip}
        className="absolute bottom-[calc(env(safe-area-inset-bottom,0px)+20px)] right-5 z-10 rounded-full border px-4 py-2 text-caption font-semibold tracking-wide"
        style={{
          color: '#10d8ff',
          borderColor: 'rgb(16 216 255 / 0.4)',
          backgroundColor: 'rgb(16 216 255 / 0.08)',
          textShadow: '0 0 10px rgb(16 216 255 / 0.7)',
          boxShadow: '0 0 16px rgb(16 216 255 / 0.25)',
        }}
      >
        Skip
      </button>
    </div>
  )
}
