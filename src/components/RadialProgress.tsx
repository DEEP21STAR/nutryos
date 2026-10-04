import { useEffect, useId, useRef, type ReactNode } from 'react'
import gsap from 'gsap'
import { cn, prefersReducedMotion } from '@/lib/utils'

/**
 * NUTRYOS "Fluid Ring" — real SVG arc (stroke-dasharray/dashoffset), GSAP
 * elastic fill animation on first mount, smooth ease on subsequent updates.
 * Glow colour is fully caller-driven (see TodayRing's amber/crimson
 * threshold logic) so this component stays a generic, reusable ring rather
 * than owning the app's specific low-remaining rule.
 */
export function RadialProgress({
  percent,
  color,
  size = 100,
  strokeWidth = 8,
  centerLabel,
  className,
  glow = true,
  gradient,
}: {
  /** 0-100. Values outside that range are clamped — a ring never overflows past a full circle or reverses. */
  percent: number
  /** Any real CSS colour (hex/rgb) — the ring's own colour communicates status (risk-state colours), not a fixed palette. */
  color: string
  size?: number
  strokeWidth?: number
  centerLabel?: ReactNode
  className?: string
  /** Luminous drop-shadow glow matching `color` — on by default per the Cinematic Tech spec, but the nested macro rings turn it off so the calorie ring's glow stays the visual lead. */
  glow?: boolean
  /** Optional [from, to] CSS colours (var() ok) — strokes the arc with a linear gradient instead of the solid `color`. */
  gradient?: [string, string]
}) {
  const gradId = useId()
  const clamped = Math.max(0, Math.min(100, percent))
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const dashOffset = circumference * (1 - clamped / 100)

  const ringRef = useRef<SVGCircleElement>(null)
  const hasMounted = useRef(false)

  useEffect(() => {
    const el = ringRef.current
    if (!el) return
    if (prefersReducedMotion()) {
      gsap.set(el, { strokeDashoffset: dashOffset })
      hasMounted.current = true
      return
    }
    if (!hasMounted.current) {
      // First paint: fill from genuinely empty with an elastic spring —
      // amplitude kept low (1) so it reads as a confident "settle into
      // place" rather than a bouncy toy; a full circumference sweep is
      // already a big, showy motion on its own.
      gsap.fromTo(
        el,
        { strokeDashoffset: circumference },
        { strokeDashoffset: dashOffset, duration: 1.4, ease: 'elastic.out(1, 0.5)' },
      )
      hasMounted.current = true
    } else {
      // A real update (a meal just logged) — eases from wherever the ring
      // currently sits, not a fresh fromTo, so it visibly GROWS rather than
      // resetting and refilling.
      gsap.to(el, { strokeDashoffset: dashOffset, duration: 0.9, ease: 'power2.out' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashOffset])

  return (
    <div className={cn('relative shrink-0', className)} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90 overflow-visible">
        {gradient && (
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" style={{ stopColor: gradient[0] }} />
              <stop offset="100%" style={{ stopColor: gradient[1] }} />
            </linearGradient>
          </defs>
        )}
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" style={{ stroke: 'var(--ux-ring-track, rgba(255,255,255,0.08))' }} strokeWidth={strokeWidth} />
        <circle
          ref={ringRef}
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={gradient ? `url(#${gradId})` : color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference}
          style={glow ? { filter: `drop-shadow(0 0 6px ${color}) drop-shadow(0 0 14px ${color})`, transition: 'stroke 0.6s ease' } : { transition: 'stroke 0.6s ease' }}
        />
      </svg>
      {centerLabel && <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-1">{centerLabel}</div>}
    </div>
  )
}
