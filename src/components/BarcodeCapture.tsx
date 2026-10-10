import { useCallback, useEffect, useRef, useState } from 'react'
import { hapticSuccess, hapticTap } from '@/lib/haptics'
import { playScanSuccessPing } from '@/lib/chime'
import { lookupByBarcode, scaleToPortion } from '@/lib/openFoodFacts'
import { barcodeProblem, normalizeBarcode, type ScanHit } from '@/lib/barcode'
import { createCameraScanner, createPhotoScanner, decodeBarcodeFromFile } from '@/lib/barcodeEngines'
import { findMyFoodByBarcode, localMyFoodsStore } from '@/lib/myFoods'
import { getCloudAiOptIn, readLabelViaCloud, setCloudAiOptIn, type LabelReading } from '@/lib/cloudAi'
import { CloudAiConsentSheet, type CloudAiChoice } from '@/components/CloudAiConsentSheet'
import { resizeImage } from '@/lib/imageResize'
import { uid } from '@/lib/utils'
import type { Per100g } from '@/lib/offMedian'
import type { FoodItem } from '@/lib/types'

/** Packaged-product barcode scan resolves to a per-100g profile, not a portion estimate the way
 * AI vision guesses grams from a photo. 100 g is the honest, editable starting point; the
 * ConfirmLog portion slider (same as every other path) is where a real serving size gets set. */
const DEFAULT_PORTION_G = 100

type Phase = 'scan' | 'looking-up' | 'label' | 'error'

/**
 * Barcode entry, three ways, all landing on the same lookup:
 *  1. live camera (native BarcodeDetector if it WORKS, otherwise the bundled ZXing-WASM ponyfill)
 *  2. photo of the barcode (file input)
 *  3. typed digits
 * A barcode Open Food Facts doesn't know, or knows without calories, goes to "Snap the nutrition
 * label" (consent-gated cloud reading) with "Enter numbers yourself" always available. Results
 * from that path are saved to My Foods, so scanning the same product again is instant.
 */
export function BarcodeCapture({
  onResolved,
  onCancel,
}: {
  onResolved: (items: FoodItem[]) => void
  onCancel: () => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const resolvingRef = useRef(false)

  const [manualCode, setManualCode] = useState('')
  const [scanning, setScanning] = useState(false)
  const [cameraError, setCameraError] = useState(false)
  const [phase, setPhase] = useState<Phase>('scan')
  // Bumped to restart the camera after a failed lookup or when going back from the label screen.
  const [session, setSession] = useState(0)
  const [message, setMessage] = useState<string | null>(null)
  const [engine, setEngine] = useState<string>('')
  // Label flow state: which barcode we're filling numbers for, the OFF name (if any), form values.
  const [labelFor, setLabelFor] = useState<{ code: string; name: string; why: 'unknown' | 'no-kcal' } | null>(null)
  const [pendingLabelPhoto, setPendingLabelPhoto] = useState<Blob | null>(null)
  const [labelBusy, setLabelBusy] = useState(false)
  const [labelNote, setLabelNote] = useState<string | null>(null)
  const [form, setForm] = useState({ name: '', kcal: '', protein: '', fat: '', carbs: '' })
  const [formError, setFormError] = useState<string | null>(null)

  const finishWithCode = useCallback(
    async (code: string) => {
      hapticTap()
      setPhase('looking-up')
      setMessage(null)
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
      setScanning(false)
      // 1) My Foods: a product you've scanned before resolves instantly, with no network.
      const mine = findMyFoodByBarcode(code)
      if (mine) {
        const grams = mine.usualGrams ?? DEFAULT_PORTION_G
        const f = grams / 100
        hapticSuccess()
        playScanSuccessPing()
        onResolved([
          {
            id: uid(),
            name: mine.name,
            estimatedGrams: grams,
            calories: Math.round(mine.per100g.kcal * f),
            proteinG: Math.round(mine.per100g.proteinG * f * 10) / 10,
            fatG: Math.round(mine.per100g.fatG * f * 10) / 10,
            carbsG: Math.round(mine.per100g.carbsG * f * 10) / 10,
            source: 'my-foods',
            confidence: 'high',
            sourceRef: `My Foods (barcode ${code})`,
          },
        ])
        return
      }
      try {
        const r = await lookupByBarcode(code)
        if (r.kind === 'found') {
          const off = r.macros
          const item: FoodItem = {
            id: uid(),
            name: off.productName,
            estimatedGrams: DEFAULT_PORTION_G,
            offCode: off.code,
            ...scaleToPortion(off, DEFAULT_PORTION_G),
            source: 'barcode',
            confidence: 'high',
            sourceRef: `Open Food Facts product ${off.code}`,
          }
          hapticSuccess()
          playScanSuccessPing()
          onResolved([item])
          return
        }
        // Unknown to OFF, or known without calories: never a silent 0 -> label / manual path.
        setLabelFor(
          r.kind === 'no-kcal'
            ? { code, name: r.productName, why: 'no-kcal' }
            : { code, name: '', why: 'unknown' },
        )
        setForm({ name: r.kind === 'no-kcal' ? r.productName : '', kcal: '', protein: '', fat: '', carbs: '' })
        setFormError(null)
        setLabelNote(null)
        setPhase('label')
      } catch {
        setPhase('error')
        setMessage('Lookup failed. Check your connection and try again, or type the numbers yourself.')
        resolvingRef.current = false
        setSession((n) => n + 1)
      }
    },
    [onResolved],
  )

  const handleHit = useCallback(
    (hit: ScanHit) => {
      if (resolvingRef.current) return
      resolvingRef.current = true
      setEngine(hit.engine)
      void finishWithCode(hit.barcode.code)
    },
    [finishWithCode],
  )

  // Live camera. The scanner decides by results: native first when present, the ponyfill joins in
  // after 3 empty frames (or at once when there is no native detector).
  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    const scanner = createCameraScanner()

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraError(true)
        return
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1280 } },
          audio: false,
        })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = stream
        const video = videoRef.current
        if (video) {
          video.srcObject = stream
          await video.play()
        }
        setScanning(true)
        const tick = async () => {
          if (cancelled || resolvingRef.current) return
          if (video && video.readyState >= 2 && video.videoWidth > 0) {
            const hit = await scanner.scan(video).catch(() => null)
            if (hit && !cancelled) {
              handleHit(hit)
              return
            }
          }
          timer = window.setTimeout(tick, 250)
        }
        tick()
      } catch {
        setCameraError(true)
      }
    }
    start()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      streamRef.current?.getTracks().forEach((t) => t.stop())
    }
  }, [handleHit, session])

  async function onBarcodePhoto(file: File | undefined) {
    if (!file || resolvingRef.current) return
    resolvingRef.current = true
    setPhase('looking-up')
    setMessage('Reading the barcode photo…')
    const hit = await decodeBarcodeFromFile(file, createPhotoScanner())
    if (!hit) {
      resolvingRef.current = false
      setPhase('scan')
      setMessage('Could not read a barcode in that photo. Try again closer and in better light, or type the number.')
      return
    }
    setEngine(hit.engine)
    void finishWithCode(hit.barcode.code)
  }

  function onManualLookup() {
    const problem = barcodeProblem(manualCode)
    const n = normalizeBarcode(manualCode)
    if (!n) {
      setMessage(problem ?? 'Type the barcode digits.')
      return
    }
    if (resolvingRef.current) return
    resolvingRef.current = true
    setMessage(null)
    void finishWithCode(n.code)
  }

  // --- label / manual numbers ---
  function applyLabel(r: LabelReading) {
    setForm((f) => ({
      name: f.name || r.name,
      kcal: String(r.per100g.kcal),
      protein: String(r.per100g.proteinG),
      fat: String(r.per100g.fatG),
      carbs: String(r.per100g.carbsG),
    }))
    setLabelNote('Read from your photo. Check these against the label, then edit anything that is off.')
  }

  async function runLabelRead(photo: Blob) {
    setLabelBusy(true)
    setLabelNote(null)
    try {
      const small = await resizeImage(photo, 1600, 'image/jpeg', 0.85)
      const r = await readLabelViaCloud(small)
      if (r) applyLabel(r)
      else setLabelNote("Couldn't read numbers from that photo. Try again with the whole panel in frame, or enter them yourself below.")
    } catch {
      setLabelNote("Label reading isn't available right now. Enter the numbers yourself below.")
    } finally {
      setLabelBusy(false)
    }
  }

  function onLabelPhoto(file: File | undefined) {
    if (!file) return
    if (getCloudAiOptIn()) void runLabelRead(file)
    else setPendingLabelPhoto(file)
  }

  function onLabelConsent(choice: CloudAiChoice) {
    const photo = pendingLabelPhoto
    setPendingLabelPhoto(null)
    if (choice === 'private' || !photo) {
      setLabelNote('Photo stays on your phone. Enter the numbers yourself below.')
      return
    }
    if (choice === 'always') setCloudAiOptIn(true)
    void runLabelRead(photo)
  }

  function submitNumbers() {
    if (!labelFor) return
    const num = (s: string) => (s.trim() === '' ? 0 : Number(s.replace(',', '.')))
    const name = form.name.trim()
    const per100g: Per100g = { kcal: num(form.kcal), proteinG: num(form.protein), fatG: num(form.fat), carbsG: num(form.carbs) }
    if (!name) return setFormError('Give it a name so you can find it later.')
    if (![per100g.kcal, per100g.proteinG, per100g.fatG, per100g.carbsG].every((v) => Number.isFinite(v) && v >= 0))
      return setFormError('Numbers only, zero or more.')
    if (!(per100g.kcal > 0)) return setFormError('Enter the calories per 100 g from the label. A silent 0 would throw your day off.')
    if (per100g.kcal > 950 || per100g.proteinG + per100g.fatG + per100g.carbsG > 105)
      return setFormError('Those numbers are not possible for 100 g. Check you used the per 100 g column.')
    localMyFoodsStore.save({
      id: `barcode-${labelFor.code}`,
      name,
      barcode: labelFor.code,
      per100g,
      usualGrams: DEFAULT_PORTION_G,
      updatedAt: new Date().toISOString(),
    })
    hapticSuccess()
    onResolved([
      {
        id: uid(),
        name,
        estimatedGrams: DEFAULT_PORTION_G,
        calories: Math.round(per100g.kcal),
        proteinG: per100g.proteinG,
        fatG: per100g.fatG,
        carbsG: per100g.carbsG,
        source: 'user',
        sourceRef: `Nutrition label for barcode ${labelFor.code}`,
      },
    ])
  }

  const inputCls =
    'w-full rounded-xl border border-white/10 bg-bg-secondary px-3 py-2.5 text-body text-text-primary outline-none focus:border-accent-health'
  const btnGhost =
    'glass flex items-center justify-center gap-2 rounded-full px-4 py-3 text-body font-semibold text-text-primary transition active:scale-95'

  return (
    <div className="fixed inset-0 z-50 flex flex-col overflow-y-auto bg-bg-primary" data-testid="barcode-capture">
      <div className="glass flex items-center justify-between px-4 pt-[calc(env(safe-area-inset-top,0px)+12px)] pb-3">
        <button onClick={onCancel} className="text-caption text-text-tertiary">
          Cancel
        </button>
        <h2 className="text-caption uppercase tracking-wide text-text-secondary">
          {phase === 'label' ? 'Nutrition label' : 'Scan Barcode'}
        </h2>
        <div className="w-12" />
      </div>

      {phase !== 'label' && (
        <div className="flex flex-1 flex-col items-center gap-4 p-5">
          {!cameraError && (
            <div className="relative w-full max-w-sm overflow-hidden rounded-2xl bg-black" style={{ aspectRatio: '4 / 3' }}>
              <video ref={videoRef} muted playsInline className="h-full w-full object-cover" data-testid="barcode-video" />
              {/* Wide horizontal guide: barcodes are wide and short, unlike the square food-photo viewfinder. */}
              <div
                aria-hidden
                className="absolute inset-x-6 top-1/2 h-16 -translate-y-1/2 rounded-lg border-2 border-accent-health"
                style={{ boxShadow: '0 0 16px 2px var(--glow-health)' }}
              />
              <p className="absolute inset-x-0 bottom-3 text-center text-caption text-white/80">
                {phase === 'looking-up' ? 'Looking up…' : scanning ? 'Line up the barcode' : 'Starting camera…'}
              </p>
            </div>
          )}
          {cameraError && (
            <p className="text-center text-caption text-text-tertiary" data-testid="barcode-no-camera">
              No camera available here. Take a photo of the barcode or type the number below.
            </p>
          )}

          <div className="flex w-full max-w-sm flex-col gap-3">
            <label className={`${btnGhost} cursor-pointer`}>
              <span aria-hidden>🖼️</span> Photo of barcode
              <input
                type="file"
                accept="image/*"
                data-testid="barcode-photo-input"
                className="sr-only"
                onChange={(e) => {
                  void onBarcodePhoto(e.target.files?.[0])
                  e.target.value = ''
                }}
              />
            </label>

            <div className="flex flex-col gap-2">
              <label htmlFor="barcode-digits" className="text-caption text-text-tertiary">
                Or type the number under the bars
              </label>
              <div className="flex gap-2">
                <input
                  id="barcode-digits"
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  value={manualCode}
                  onChange={(e) => setManualCode(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && onManualLookup()}
                  placeholder="Barcode number"
                  className={inputCls}
                />
                <button
                  onClick={onManualLookup}
                  disabled={!manualCode.trim() || phase === 'looking-up'}
                  className="shrink-0 rounded-xl bg-accent-health px-5 text-body font-semibold text-bg-primary disabled:opacity-40"
                >
                  Look up
                </button>
              </div>
            </div>

            <p role="status" aria-live="polite" className="min-h-5 text-center text-caption text-text-secondary" data-testid="barcode-status">
              {message}
            </p>
            {engine && (
              <p className="text-center text-caption text-text-tertiary" data-testid="barcode-engine">
                Decoded by {engine === 'native' ? 'this browser' : 'built-in scanner'}
              </p>
            )}
          </div>
        </div>
      )}

      {phase === 'label' && labelFor && (
        <div className="flex flex-1 flex-col items-center gap-4 p-5" data-testid="barcode-label-flow">
          <div className="w-full max-w-sm">
            <h3 className="text-subtitle font-semibold text-text-primary">Snap the nutrition label</h3>
            <p className="mt-1 text-body text-text-secondary">
              {labelFor.why === 'no-kcal'
                ? `Open Food Facts lists “${labelFor.name}” but has no calories for it.`
                : `Barcode ${labelFor.code} isn't in Open Food Facts yet.`}{' '}
              Nothing is logged until you have real numbers.
            </p>
          </div>

          <div className="flex w-full max-w-sm flex-col gap-2">
            <label className={`${btnGhost} cursor-pointer text-accent-ai`}>
              <span aria-hidden>📷</span> {labelBusy ? 'Reading label…' : 'Snap the nutrition label'}
              <input
                type="file"
                accept="image/*"
                data-testid="label-photo-input"
                className="sr-only"
                disabled={labelBusy}
                onChange={(e) => {
                  onLabelPhoto(e.target.files?.[0])
                  e.target.value = ''
                }}
              />
            </label>
            <p className="text-center text-caption text-text-tertiary">
              The photo goes to Google's free AI only if you allow it. Or skip it and type the numbers.
            </p>
          </div>

          <div className="flex w-full max-w-sm flex-col gap-3 rounded-2xl border border-white/10 p-4" data-testid="barcode-numbers-form">
            <h4 className="text-body font-semibold text-text-primary">Enter numbers yourself</h4>
            {labelNote && (
              <p role="status" className="text-caption text-text-secondary" data-testid="label-note">
                {labelNote}
              </p>
            )}
            <label className="flex flex-col gap-1 text-caption text-text-tertiary">
              Name
              <input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Whey protein" />
            </label>
            <p className="text-caption text-text-tertiary">Use the per 100 g column on the label.</p>
            <div className="grid grid-cols-2 gap-3">
              {(
                [
                  ['kcal', 'Calories (kcal)'],
                  ['protein', 'Protein (g)'],
                  ['fat', 'Fat (g)'],
                  ['carbs', 'Carbs (g)'],
                ] as const
              ).map(([k, label]) => (
                <label key={k} className="flex flex-col gap-1 text-caption text-text-tertiary">
                  {label}
                  <input
                    className={inputCls}
                    inputMode="decimal"
                    value={form[k]}
                    onChange={(e) => setForm({ ...form, [k]: e.target.value })}
                    aria-label={label}
                  />
                </label>
              ))}
            </div>
            {formError && (
              <p role="alert" className="text-caption text-accent-danger" data-testid="label-form-error">
                {formError}
              </p>
            )}
            <button onClick={submitNumbers} className="rounded-xl bg-accent-health py-3 text-body font-semibold text-bg-primary">
              Use these numbers
            </button>
          </div>

          <button
            onClick={() => {
              resolvingRef.current = false
              setPhase('scan')
              setLabelFor(null)
              setSession((n) => n + 1)
            }}
            className="text-caption text-text-tertiary underline"
          >
            Scan a different barcode
          </button>
        </div>
      )}

      {pendingLabelPhoto && <CloudAiConsentSheet foodNames={[]} kind="label" onChoose={onLabelConsent} />}
    </div>
  )
}
