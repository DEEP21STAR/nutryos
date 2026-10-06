import { useEffect, useRef, useState } from 'react'
import gsap from 'gsap'
import { cn, prefersReducedMotion } from '@/lib/utils'
import { hapticTap } from '@/lib/haptics'

/**
 * NUTRYOS Input Orb — collapsed state. 64px floating glassmorphic button
 * with a GSAP breathing loop (an idle "it's alive" cue, not CSS keyframes,
 * so it can be killed cleanly and is trivially gated by
 * prefers-reduced-motion). This is the ONLY entry point into Photo mode.
 */
export function InputOrbButton({ onClick }: { onClick: () => void }) {
  const orbRef = useRef<HTMLButtonElement>(null)
  const glowRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const orb = orbRef.current
    const glow = glowRef.current
    if (!orb || !glow || prefersReducedMotion()) return
    const tl = gsap.timeline({ repeat: -1, yoyo: true, defaults: { duration: 1.8, ease: 'sine.inOut' } })
    tl.to(orb, { scale: 1.08 }, 0)
    tl.to(glow, { scale: 1.35, opacity: 0.95 }, 0)
    return () => {
      tl.kill()
    }
  }, [])

  return (
    <div data-tour="orb" className="fixed bottom-24 left-1/2 z-40 -translate-x-1/2">
      <div
        ref={glowRef}
        aria-hidden
        className="absolute inset-0 rounded-full blur-xl"
        style={{ background: 'var(--glow-ai)', opacity: 0.55 }}
      />
      <button
        ref={orbRef}
        onClick={onClick}
        aria-label="Log a meal"
        className="glass relative grid h-16 w-16 place-items-center rounded-full text-2xl shadow-[0_0_24px_4px_var(--glow-ai)] transition active:scale-90"
      >
        <span aria-hidden>📷</span>
      </button>
    </div>
  )
}

/**
 * NUTRYOS's own camera "lens" — the branded viewfinder treatment Deep asked for so opening the
 * camera feels like part of this app, not a generic file picker. Emerald corner brackets (same
 * bracket/tag visual language reused for real detected items on the confirm screen) plus a real
 * GSAP-driven scan-line that sweeps top-to-bottom on a loop while the shutter is live, and a
 * rotating set of hint captions — genuine motion, not a static decorative frame. Purely visual:
 * no live per-frame detection exists in this pipeline (identification happens once, after the
 * shutter), so the sweep communicates "the AI is watching" rather than claiming real-time vision.
 */
const SCAN_HINTS = ['Center your meal in frame', 'Good lighting helps accuracy', 'Hold steady for a clear shot']

function ViewfinderBrackets() {
  const corner = 'absolute h-8 w-8 border-[3px] border-accent-health drop-shadow-[0_0_8px_var(--glow-health)]'
  const scanLineRef = useRef<HTMLDivElement>(null)
  const [hintIndex, setHintIndex] = useState(0)

  useEffect(() => {
    const el = scanLineRef.current
    if (!el || prefersReducedMotion()) return
    const tl = gsap.timeline({ repeat: -1 })
    tl.fromTo(el, { top: '2%', opacity: 0 }, { opacity: 1, duration: 0.3 })
      .to(el, { top: '98%', duration: 1.6, ease: 'sine.inOut' })
      .to(el, { opacity: 0, duration: 0.3 })
    return () => {
      tl.kill()
    }
  }, [])

  useEffect(() => {
    const id = setInterval(() => setHintIndex((i) => (i + 1) % SCAN_HINTS.length), 2600)
    return () => clearInterval(id)
  }, [])

  return (
    <>
      <div className="pointer-events-none absolute inset-6 overflow-hidden sm:inset-10">
        <div className={cn(corner, 'top-0 left-0 rounded-tl-lg border-r-0 border-b-0')} />
        <div className={cn(corner, 'top-0 right-0 rounded-tr-lg border-l-0 border-b-0')} />
        <div className={cn(corner, 'bottom-0 left-0 rounded-bl-lg border-r-0 border-t-0')} />
        <div className={cn(corner, 'bottom-0 right-0 rounded-br-lg border-l-0 border-t-0')} />
        <div
          ref={scanLineRef}
          aria-hidden
          className="absolute inset-x-0 h-[2px]"
          style={{
            background: 'linear-gradient(90deg, transparent, var(--color-accent-health), transparent)',
            boxShadow: '0 0 12px 2px var(--glow-health)',
            opacity: 0,
          }}
        />
      </div>
      <p className="pointer-events-none absolute inset-x-0 bottom-[19%] text-center text-caption text-text-secondary drop-shadow-[0_1px_4px_rgba(0,0,0,0.8)]">
        {SCAN_HINTS[hintIndex]}
      </p>
    </>
  )
}

/**
 * Three genuinely distinct capture paths, not one input trying to do
 * everything. Per the HTML spec / MDN's documented `capture` attribute
 * behavior (not guessed): its PRESENCE hints the UA to open a capture UI
 * (camera/mic) directly; its ABSENCE lets the UA present its normal
 * media-selection UI (photo library + on-device files, and often camera
 * too, presented by the OS/browser — a web page cannot force "gallery
 * only" vs "files only" any further than that, there is no separate HTML
 * lever for it on either iOS Safari or Android Chrome).
 * So: "Take a Photo" forces the camera via `capture="environment"`
 * (useful even when the live getUserMedia preview isn't available, e.g.
 * permission denied for live preview but the native camera app still
 * works). "Photos & Files" drops `capture` entirely so the OS's own
 * chooser — which is what actually splits Photos vs Files vs Camera on
 * both platforms — takes over. This was NOT verified on a physical
 * iOS/Android device in this session (none available here); it follows
 * documented spec behavior rather than a guess, and should get one real
 * on-device check before shipping.
 */
function UploadOptions({ onFile }: { onFile: (e: React.ChangeEvent<HTMLInputElement>) => void }) {
  return (
    <div className="flex w-full flex-col gap-2">
      <label className="glass flex cursor-pointer items-center justify-center gap-2 rounded-full px-6 py-3 text-subtitle font-semibold text-accent-health shadow-[0_0_24px_4px_var(--glow-health)] transition active:scale-95">
        <span aria-hidden>📸</span> Take a Photo
        <input type="file" accept="image/*" capture="environment" className="hidden" onChange={onFile} />
      </label>
      <label className="glass flex cursor-pointer items-center justify-center gap-2 rounded-full px-6 py-3 text-subtitle font-semibold text-accent-ai shadow-[0_0_24px_4px_var(--glow-ai)] transition active:scale-95">
        <span aria-hidden>🖼️</span> Photos &amp; Files
        <input type="file" accept="image/*" className="hidden" onChange={onFile} />
      </label>
    </div>
  )
}

/**
 * Core-loop step 1: camera capture. Uses a real `getUserMedia` live preview
 * (per spec) with an in-browser shutter button. Falls back to a native
 * `<input type="file" accept="image/*" capture="environment">` picker when
 * `getUserMedia` is unavailable or permission is denied — this is a REAL,
 * common failure mode (desktop browsers with no camera, iOS Safari camera
 * permission denied in a PWA context, etc.), not a hypothetical, so the
 * fallback is a first-class path rather than an error dead-end.
 *
 * Visual layer only, restyled to the NUTRYOS Cinematic Tech spec: the panel
 * enters with a GSAP elastic-spring expansion from the orb's position
 * (skipped for prefers-reduced-motion, which gets a plain 200ms fade
 * instead), and Cancel plays the same spring in reverse before actually
 * unmounting. Detection/capture logic below is completely unchanged.
 */
export function CameraCapture({
  onCapture,
  onCancel,
}: {
  onCapture: (photo: Blob) => void
  onCancel: () => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [closing, setClosing] = useState(false)
  const [showUploadOptions, setShowUploadOptions] = useState(false)

  // Elastic-spring entrance. Spec pseudocode gives a spring in
  // stiffness/damping/mass terms (300/30/0.8); GSAP's real elastic ease API
  // takes (amplitude, period) instead, which are not the same units and
  // don't convert 1:1. That stiffness/damping/mass combo works out to a
  // damping ratio of ~0.97 (just under critical) — i.e. a fast settle with
  // only a hint of overshoot, not a big wobble — so amplitude 1 / period
  // 0.4 was chosen to reproduce that *character* (quick, slightly springy,
  // no bounce-back-and-forth), not a literal unit conversion.
  useEffect(() => {
    const el = panelRef.current
    if (!el) return
    if (prefersReducedMotion()) {
      gsap.set(el, { opacity: 1, scale: 1 })
      return
    }
    gsap.fromTo(
      el,
      { scale: 0.15, opacity: 0, borderRadius: 9999 },
      { scale: 1, opacity: 1, borderRadius: 0, duration: 0.9, ease: 'elastic.out(1, 0.4)', transformOrigin: '50% 100%' },
    )
  }, [])

  function playExitThen(cb: () => void) {
    const el = panelRef.current
    if (!el || prefersReducedMotion()) {
      cb()
      return
    }
    setClosing(true)
    gsap.to(el, {
      scale: 0.15,
      opacity: 0,
      borderRadius: 9999,
      duration: 0.45,
      ease: 'power3.in',
      transformOrigin: '50% 100%',
      onComplete: cb,
    })
  }

  useEffect(() => {
    let cancelled = false
    // Real gap found during testing (no-camera environment): getUserMedia can
    // simply never resolve or reject at all — no error event ever fires,
    // leaving the user stuck on a permanently disabled shutter with only
    // Cancel to escape. A hard timeout guarantees the file-input fallback is
    // always reachable, not just on an explicit permission/NotFound error.
    const stallTimer = setTimeout(() => {
      if (!cancelled) setError((prev) => prev ?? 'timeout')
    }, 6000)
    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('no-getUserMedia')
        return
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1080 }, height: { ideal: 1080 } },
          audio: false,
        })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play()
        }
        clearTimeout(stallTimer)
        setReady(true)
      } catch (err) {
        clearTimeout(stallTimer)
        setError(err instanceof Error ? err.name : 'unknown')
      }
    }
    start()
    return () => {
      cancelled = true
      clearTimeout(stallTimer)
      streamRef.current?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  function shoot() {
    hapticTap()
    const video = videoRef.current
    if (!video) return
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(video, 0, 0)
    canvas.toBlob(
      (blob) => {
        if (blob) onCapture(blob)
      },
      'image/jpeg',
      0.9,
    )
  }

  function handleFileFallback(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) onCapture(file)
  }

  function cancel() {
    playExitThen(onCancel)
  }

  const useFallback = error != null

  return (
    <div
      ref={panelRef}
      className={cn('fixed inset-0 z-50 flex flex-col overflow-hidden bg-bg-primary', closing && 'pointer-events-none')}
    >
      {useFallback ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
          <div className="glass-card max-w-xs p-6">
            <p className="text-body text-text-secondary">
              {error === 'no-getUserMedia'
                ? 'Live camera preview is not available in this browser.'
                : error === 'timeout'
                  ? 'Camera preview is taking too long to start.'
                  : 'Camera permission was denied or no camera was found.'}
            </p>
          </div>
          <div className="w-full max-w-xs">
            <UploadOptions onFile={handleFileFallback} />
          </div>
          <button onClick={cancel} className="text-caption text-text-tertiary underline">
            Cancel
          </button>
        </div>
      ) : (
        <>
          <video ref={videoRef} playsInline muted className="h-full w-full flex-1 object-cover" />
          {/* cinematic vignette so glass controls stay legible over any frame */}
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/60 via-transparent to-black/70" />
          {ready && <ViewfinderBrackets />}

          <div className="absolute inset-x-0 top-0 flex items-center justify-between p-4">
            <button onClick={cancel} className="glass rounded-full px-4 py-2 text-caption text-text-primary">
              Cancel
            </button>
            <span className="glass rounded-full px-3 py-1 text-caption text-accent-health shadow-[0_0_16px_2px_var(--glow-health)]">
              Photo mode
            </span>
          </div>

          {/* Live preview succeeding doesn't mean gallery/files should be
              unreachable — Deep's explicit ask: camera, gallery, and file
              upload need to stay real, distinct options at every point in
              this flow, not just after getUserMedia fails. */}
          {showUploadOptions ? (
            <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-2 p-6">
              <div className="w-full max-w-xs">
                <UploadOptions onFile={handleFileFallback} />
              </div>
              <button
                onClick={() => setShowUploadOptions(false)}
                className="glass rounded-full px-4 py-1.5 text-caption text-text-secondary"
              >
                Back to camera
              </button>
            </div>
          ) : (
            <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-3 pb-10">
              <button
                onClick={shoot}
                disabled={!ready}
                className={cn(
                  'h-20 w-20 rounded-full border-4 border-white/90 bg-white/10 backdrop-blur-sm transition',
                  ready ? 'active:scale-90 shadow-[0_0_32px_6px_var(--glow-health)]' : 'opacity-40',
                )}
                aria-label="Take photo"
              />
              <button
                onClick={() => setShowUploadOptions(true)}
                className="glass rounded-full px-4 py-1.5 text-caption text-text-secondary"
              >
                Upload instead
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
