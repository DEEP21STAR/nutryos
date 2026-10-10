import { createFallbackScanner, type FrameDetector, type ScanHit } from '@/lib/barcode'

/** Retail formats only. (QR etc. are not food barcodes and just add false positives.) */
export const BARCODE_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e']

/** The browser's own detector, or null if absent or it refuses these formats. */
export function getNativeDetector(): FrameDetector | null {
  try {
    if (typeof window === 'undefined' || !window.BarcodeDetector) return null
    const det = new window.BarcodeDetector({ formats: BARCODE_FORMATS })
    return { detect: (src) => det.detect(src as CanvasImageSource) }
  } catch {
    return null
  }
}

/** Dynamic import: the ponyfill JS + WASM only download on first use. */
export async function loadPonyfill(): Promise<FrameDetector> {
  const mod = await import('@/lib/barcodePonyfill')
  return mod.createPonyfillDetector(BARCODE_FORMATS)
}

/** Scanner for a live camera: native gets 3 empty frames before the ponyfill joins in. */
export function createCameraScanner(native: FrameDetector | null = getNativeDetector()) {
  return createFallbackScanner({ native, loadPonyfill, fallbackAfterEmptyFrames: 3 })
}

/** Scanner for a still photo: a single empty native result is enough to try the ponyfill. */
export function createPhotoScanner(native: FrameDetector | null = getNativeDetector()) {
  return createFallbackScanner({ native, loadPonyfill, fallbackAfterEmptyFrames: 1 })
}

function drawScaled(bitmap: ImageBitmap, maxEdge: number, enhance: boolean): HTMLCanvasElement {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  if (enhance) {
    // Auto-contrast (stretch the 2nd..98th percentile to 0..255) for washed-out photos.
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const d = img.data
    const hist = new Uint32Array(256)
    for (let i = 0; i < d.length; i += 4) hist[(d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0]++
    const total = d.length / 4
    let lo = 0
    let hi = 255
    for (let acc = 0; lo < 255 && (acc += hist[lo]) < total * 0.02; lo++);
    for (let acc = 0; hi > 0 && (acc += hist[hi]) < total * 0.02; hi--);
    const span = Math.max(1, hi - lo)
    for (let i = 0; i < d.length; i += 4) {
      const g = Math.max(0, Math.min(255, (((d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) - lo) * 255) / span))
      d[i] = d[i + 1] = d[i + 2] = g
    }
    ctx.putImageData(img, 0, 0)
  }
  return canvas
}

/**
 * Decodes a photo of a barcode. Tries a 1600 px version, a 1000 px version (helps when the file
 * is huge or soft), then a contrast-stretched copy (washed-out/low-light shots). First valid
 * checksum wins. Returns null when nothing decodes (never a guessed code).
 */
export async function decodeBarcodeFromFile(file: Blob, scanner = createPhotoScanner()): Promise<ScanHit | null> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    return null
  }
  try {
    for (const [edge, enhance] of [[1600, false], [1000, false], [1600, true]] as const) {
      const hit = await scanner.scan(drawScaled(bitmap, edge, enhance))
      if (hit) return hit
    }
    return null
  } finally {
    bitmap.close()
  }
}
