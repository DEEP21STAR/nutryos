import { useEffect, useRef, useState } from 'react'
import { hapticSuccess, hapticTap } from '@/lib/haptics'
import { playScanSuccessPing } from '@/lib/chime'
import { lookupByBarcode, scaleToPortion } from '@/lib/openFoodFacts'
import { uid } from '@/lib/utils'
import type { FoodItem } from '@/lib/types'

/** Packaged-product barcode scan resolves to a per-100g profile, not a portion estimate the way
 * AI vision guesses grams from a photo — 100g is the honest, editable starting point; the
 * ConfirmLog portion slider (same as every other path) is where a real serving size gets set. */
const DEFAULT_PORTION_G = 100
const BARCODE_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e']

/**
 * Real barcode scanning where the browser supports it (Chrome/Edge/Android — BarcodeDetector is
 * not in Safari/iOS at all, confirmed via research before building this, no timeline from Apple
 * to add it). Rather than pull in a heavyweight WASM decoder library to paper over that gap, this
 * degrades honestly: unsupported browsers skip straight to manual barcode entry, which hits the
 * exact same lookupByBarcode()/OFF product endpoint and produces an identical result — the
 * feature still fully works everywhere, just without the camera magic on iOS.
 */
export function BarcodeCapture({
  onResolved,
  onCancel,
}: {
  onResolved: (items: FoodItem[]) => void
  onCancel: () => void
}) {
  const supported = typeof window !== 'undefined' && !!window.BarcodeDetector
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const detectorRef = useRef<BarcodeDetector | null>(null)
  const resolvingRef = useRef(false)

  const [manualCode, setManualCode] = useState('')
  const [scanning, setScanning] = useState(false)
  const [cameraError, setCameraError] = useState(false)
  const [lookupState, setLookupState] = useState<'idle' | 'looking-up' | 'not-found' | 'error'>('idle')

  useEffect(() => {
    if (!supported) return
    let cancelled = false
    let intervalId: number | undefined

    async function start() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1080 } },
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
        detectorRef.current = new window.BarcodeDetector!({ formats: BARCODE_FORMATS })
        setScanning(true)
        intervalId = window.setInterval(async () => {
          if (resolvingRef.current || !videoRef.current || !detectorRef.current) return
          try {
            const codes = await detectorRef.current.detect(videoRef.current)
            if (codes.length > 0 && !resolvingRef.current) {
              resolvingRef.current = true
              handleCode(codes[0].rawValue)
            }
          } catch {
            // Transient per-frame detect failure (e.g. video not ready yet) — next tick retries.
          }
        }, 400)
      } catch {
        setCameraError(true)
      }
    }
    start()

    return () => {
      cancelled = true
      if (intervalId) clearInterval(intervalId)
      streamRef.current?.getTracks().forEach((t) => t.stop())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once for this screen's one real lifecycle
  }, [])

  async function handleCode(code: string) {
    hapticTap()
    setLookupState('looking-up')
    try {
      const off = await lookupByBarcode(code)
      if (!off) {
        setLookupState('not-found')
        resolvingRef.current = false
        return
      }
      const macros = scaleToPortion(off, DEFAULT_PORTION_G)
      const item: FoodItem = {
        id: uid(),
        name: off.productName,
        estimatedGrams: DEFAULT_PORTION_G,
        offCode: off.code,
        ...macros,
        source: 'barcode',
        confidence: 'high',
        sourceRef: `Open Food Facts product ${off.code}`,
      }
      hapticSuccess()
      playScanSuccessPing()
      onResolved([item])
    } catch {
      setLookupState('error')
      resolvingRef.current = false
    }
  }

  function handleManualLookup() {
    const code = manualCode.trim()
    if (!code || resolvingRef.current) return
    resolvingRef.current = true
    handleCode(code)
  }

  const showManualEntry = !supported || cameraError || lookupState === 'not-found' || lookupState === 'error'

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-bg-primary">
      <div className="glass flex items-center justify-between px-4 pt-[calc(env(safe-area-inset-top,0px)+12px)] pb-3">
        <button onClick={onCancel} className="text-caption text-text-tertiary">
          Cancel
        </button>
        <h2 className="text-caption uppercase tracking-wide text-text-secondary">Scan Barcode</h2>
        <div className="w-12" />
      </div>

      <div className="flex flex-1 flex-col items-center justify-center gap-6 p-6">
        {supported && !cameraError && (
          <div className="relative w-full max-w-xs overflow-hidden rounded-2xl bg-black" style={{ aspectRatio: '4 / 3' }}>
            <video ref={videoRef} muted playsInline className="h-full w-full object-cover" />
            {/* Wide horizontal guide — barcodes are wide/short, unlike the square food-photo
                viewfinder, so this deliberately isn't the same brackets shape. */}
            <div
              aria-hidden
              className="absolute inset-x-6 top-1/2 h-16 -translate-y-1/2 rounded-lg border-2 border-accent-health"
              style={{ boxShadow: '0 0 16px 2px var(--glow-health)' }}
            />
            <p className="absolute inset-x-0 bottom-3 text-center text-caption text-white/80">
              {lookupState === 'looking-up' ? 'Looking up…' : scanning ? 'Line up the barcode' : 'Starting camera…'}
            </p>
          </div>
        )}

        {!supported && (
          <p className="text-center text-caption text-text-tertiary">
            Live barcode scanning isn't available in this browser — enter the number below instead.
          </p>
        )}
        {cameraError && (
          <p className="text-center text-caption text-text-tertiary">
            Couldn't access the camera — enter the barcode number below instead.
          </p>
        )}
        {lookupState === 'not-found' && (
          <p className="text-center text-caption text-accent-danger">
            No product found for that barcode — check the number, or log it manually from the confirm screen.
          </p>
        )}
        {lookupState === 'error' && (
          <p className="text-center text-caption text-accent-danger">Lookup failed — check your connection and try again.</p>
        )}

        {showManualEntry && (
          <div className="flex w-full max-w-xs flex-col gap-2">
            <input
              type="text"
              inputMode="numeric"
              value={manualCode}
              onChange={(e) => setManualCode(e.target.value)}
              placeholder="Barcode number"
              className="rounded-xl border border-white/10 bg-bg-secondary px-4 py-3 text-center text-body text-text-primary outline-none focus:border-accent-health"
            />
            <button
              onClick={handleManualLookup}
              disabled={!manualCode.trim() || lookupState === 'looking-up'}
              className="rounded-xl bg-accent-health py-3 text-body font-semibold text-bg-primary disabled:opacity-40"
            >
              {lookupState === 'looking-up' ? 'Looking up…' : 'Look up'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
