/**
 * Lazy chunk: the `barcode-detector` ponyfill (ZXing-C++ compiled to WASM, MIT). Imported ONLY via
 * dynamic import from barcodeEngines.ts so none of it (JS or the ~1 MB .wasm) loads until a scan
 * actually needs it. The WASM file is bundled with the app (Vite `?url`) and served from our own
 * origin; the library's default is a jsDelivr CDN URL, which is overridden below so a scan never
 * contacts a third party.
 */
import { BarcodeDetector, setZXingModuleOverrides } from 'barcode-detector/ponyfill'
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url'
import type { FrameDetector } from '@/lib/barcode'

let configured = false

export function createPonyfillDetector(formats: string[]): FrameDetector {
  if (!configured) {
    setZXingModuleOverrides({
      locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasmUrl : prefix + path),
    })
    configured = true
  }
  const det = new BarcodeDetector({ formats: formats as never })
  return { detect: (src) => det.detect(src as never) }
}
