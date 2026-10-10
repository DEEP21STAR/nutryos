/**
 * Pure barcode helpers (no browser APIs, so they are unit-testable): GTIN checksum validation,
 * normalisation to the form Open Food Facts indexes, and the "which engine decoded it" fallback
 * logic. NUTRYOS addendum rule 1: decide by RESULTS, not by feature-detection.
 */

export type GtinKind = 'EAN-13' | 'EAN-8' | 'UPC-A' | 'GTIN-14'

export interface NormalizedBarcode {
  /** What gets looked up: UPC-A is padded to 13 digits (OFF stores it that way), the rest as read. */
  code: string
  kind: GtinKind
  /** EAN-13 starting 94 = GS1 New Zealand member company. */
  isNz: boolean
}

/** GS1 mod-10 check: weights alternate 3,1,3,... starting from the digit next to the check digit. */
export function gtinChecksumValid(digits: string): boolean {
  if (!/^\d{8}$|^\d{12,14}$/.test(digits)) return false
  const body = digits.slice(0, -1)
  let sum = 0
  for (let i = 0; i < body.length; i++) {
    const fromRight = body.length - i // 1 = digit next to the check digit
    sum += Number(body[i]) * (fromRight % 2 === 1 ? 3 : 1)
  }
  return (10 - (sum % 10)) % 10 === Number(digits[digits.length - 1])
}

/** Strips spaces/dashes, validates length + checksum. Returns null for anything that isn't a real GTIN. */
export function normalizeBarcode(raw: string): NormalizedBarcode | null {
  const digits = raw.replace(/[\s-]/g, '')
  if (!gtinChecksumValid(digits)) return null
  switch (digits.length) {
    case 8:
      return { code: digits, kind: 'EAN-8', isNz: false }
    case 12:
      return { code: `0${digits}`, kind: 'UPC-A', isNz: false }
    case 13:
      return { code: digits, kind: 'EAN-13', isNz: digits.startsWith('94') }
    default:
      return { code: digits, kind: 'GTIN-14', isNz: false }
  }
}

/** Explains why typed digits were rejected, in words a person can act on. */
export function barcodeProblem(raw: string): string | null {
  const digits = raw.replace(/[\s-]/g, '')
  if (!digits) return null
  if (!/^\d+$/.test(digits)) return 'Barcodes are digits only.'
  if (![8, 12, 13, 14].includes(digits.length)) return `That is ${digits.length} digits. Most barcodes are 13 (or 12 or 8).`
  if (!gtinChecksumValid(digits)) return 'The last digit does not match, so one digit is probably wrong. Check it and try again.'
  return null
}

export interface RawDetection {
  rawValue: string
  format?: string
}
export interface FrameDetector {
  detect(source: unknown): Promise<RawDetection[]>
}

export type Engine = 'native' | 'ponyfill'
export interface ScanHit {
  barcode: NormalizedBarcode
  engine: Engine
  /** True when the native detector was present but the ponyfill is what actually decoded it. */
  fellBack: boolean
}

export interface FallbackOptions {
  /** The browser's BarcodeDetector, if it has one (null = absent). */
  native: FrameDetector | null
  /** Lazily loads the WASM ponyfill; only called when it is actually needed. */
  loadPonyfill: () => Promise<FrameDetector>
  /** Empty native frames tolerated before the ponyfill also runs on each frame. A still photo uses 1. */
  fallbackAfterEmptyFrames?: number
  /** A native call that takes longer than this counts as an empty frame. */
  nativeTimeoutMs?: number
  /** Native calls that time out/throw this many times in a row switch the native detector off. */
  nativeMaxTimeouts?: number
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve('timeout'), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

function firstValid(found: RawDetection[]): NormalizedBarcode | null {
  for (const f of found) {
    const n = normalizeBarcode(f.rawValue)
    if (n) return n
  }
  return null
}

/**
 * Per-frame scanner that trusts results. Native runs first when present. A frame where native
 * returns nothing valid (empty, invalid checksum, throws, or times out) counts as a miss. Once the
 * miss count reaches `fallbackAfterEmptyFrames`, the ponyfill also runs on every frame, and a code
 * from either engine wins. The ponyfill is also used immediately when native is absent.
 */
export function createFallbackScanner(opts: FallbackOptions) {
  const after = opts.fallbackAfterEmptyFrames ?? 3
  const timeoutMs = opts.nativeTimeoutMs ?? 1500
  const maxTimeouts = opts.nativeMaxTimeouts ?? 2
  let nativeAlive = !!opts.native
  let nativeMisses = 0
  let nativeTimeouts = 0
  let ponyfill: Promise<FrameDetector> | null = null

  const getPonyfill = () => (ponyfill ??= opts.loadPonyfill())

  return {
    /** Which engines have been used so far, for tests and diagnostics. */
    state: () => ({ nativeAlive, nativeMisses, nativeTimeouts, ponyfillLoaded: ponyfill !== null }),
    async scan(frame: unknown): Promise<ScanHit | null> {
      if (nativeAlive && opts.native) {
        try {
          const r = await withTimeout(opts.native.detect(frame), timeoutMs)
          if (r === 'timeout') {
            nativeTimeouts++
            if (nativeTimeouts >= maxTimeouts) nativeAlive = false
          } else {
            nativeTimeouts = 0
            const hit = firstValid(r)
            if (hit) return { barcode: hit, engine: 'native', fellBack: false }
          }
        } catch {
          nativeTimeouts++
          if (nativeTimeouts >= maxTimeouts) nativeAlive = false
        }
        nativeMisses++
      }
      const needPonyfill = !opts.native || !nativeAlive || nativeMisses >= after
      if (!needPonyfill) return null
      try {
        const det = await getPonyfill()
        const hit = firstValid(await det.detect(frame))
        if (hit) return { barcode: hit, engine: 'ponyfill', fellBack: !!opts.native }
      } catch {
        /* ponyfill failed to load/decode this frame: next frame retries */
      }
      return null
    },
  }
}
