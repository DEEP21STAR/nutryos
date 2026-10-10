import { assessTranscript, audioRms, cleanTranscript, trimSilence, type TranscriptAssessment } from '@/lib/asr/transcriptQuality'
import { ASR_MODEL_BYTES, ASR_WASM_BYTES } from '@/lib/asr/asrConfig'

/**
 * Main-thread side of the on-device recogniser. The worker (and with it the ~46 MB of model + runtime)
 * is created only when prepareAsr()/transcribeBlob() is first called, i.e. when the user opens voice
 * capture. One worker is shared for the page's lifetime.
 */

export interface AsrProgress {
  loaded: number
  total: number
  fraction: number
}

export interface AsrResult {
  text: string
  /** Time spent inside the worker for this clip. */
  ms: number
  seconds: number
  assessment: TranscriptAssessment
}

type Listener = (p: AsrProgress) => void

let worker: Worker | null = null
let ready: Promise<void> | null = null
let nextId = 1
const listeners = new Set<Listener>()
const pending = new Map<number, { resolve: (r: { text: string; ms: number }) => void; reject: (e: Error) => void }>()
let lastProgress: AsrProgress = { loaded: 0, total: ASR_MODEL_BYTES + ASR_WASM_BYTES, fraction: 0 }

export const asrTotalBytes = () => ASR_MODEL_BYTES + ASR_WASM_BYTES

function ensureWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('./asrWorker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (e: MessageEvent) => {
    const m = e.data as { type: string; loaded?: number; total?: number; id?: number; text?: string; ms?: number; message?: string }
    if (m.type === 'progress') {
      lastProgress = { loaded: m.loaded ?? 0, total: m.total ?? lastProgress.total, fraction: Math.min(1, (m.loaded ?? 0) / (m.total || 1)) }
      listeners.forEach((l) => l(lastProgress))
    } else if (m.type === 'result' && m.id != null) {
      pending.get(m.id)?.resolve({ text: m.text ?? '', ms: m.ms ?? 0 })
      pending.delete(m.id)
    } else if (m.type === 'error' && m.id != null) {
      pending.get(m.id)?.reject(new Error(m.message))
      pending.delete(m.id)
    }
  }
  return worker
}

/** Starts (or joins) the model load. Resolves when the worker can transcribe; rejects if it cannot load. */
export function prepareAsr(onProgress?: Listener): Promise<void> {
  if (onProgress) {
    listeners.add(onProgress)
    onProgress(lastProgress)
  }
  if (ready) return ready
  const w = ensureWorker()
  ready = new Promise<void>((resolve, reject) => {
    const handler = (e: MessageEvent) => {
      const m = e.data as { type: string; id?: number; message?: string }
      if (m.type === 'ready') {
        w.removeEventListener('message', handler)
        lastProgress = { ...lastProgress, fraction: 1 }
        listeners.forEach((l) => l(lastProgress))
        resolve()
      } else if (m.type === 'error' && m.id == null) {
        w.removeEventListener('message', handler)
        ready = null
        worker?.terminate()
        worker = null
        reject(new Error(m.message || 'speech model failed to load'))
      }
    }
    w.addEventListener('message', handler)
    w.postMessage({ type: 'init', baseUrl: new URL(import.meta.env.BASE_URL, location.href).href })
  })
  ready.catch(() => {})
  return ready
}

export function removeAsrListener(l: Listener): void {
  listeners.delete(l)
}

/** Decodes a recorded blob to 16 kHz mono Float32 (what the model expects). */
export async function decodeTo16kMono(blob: Blob): Promise<Float32Array> {
  const bytes = await blob.arrayBuffer()
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  const ctx = new AC()
  try {
    const decoded = await ctx.decodeAudioData(bytes)
    const length = Math.max(1, Math.ceil(decoded.duration * 16000))
    const off = new OfflineAudioContext(1, length, 16000)
    const src = off.createBufferSource()
    src.buffer = decoded
    src.connect(off.destination)
    src.start()
    const rendered = await off.startRendering()
    return rendered.getChannelData(0).slice()
  } finally {
    ctx.close().catch(() => {})
  }
}

function runOnce(audio: Float32Array): Promise<{ text: string; ms: number }> {
  const id = nextId++
  const w = ensureWorker()
  return new Promise<{ text: string; ms: number }>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    w.postMessage({ type: 'transcribe', id, audio }, [audio.buffer])
  })
}

export async function transcribeBlob(blob: Blob): Promise<AsrResult> {
  const [decoded] = await Promise.all([decodeTo16kMono(blob), prepareAsr()])
  const seconds = decoded.length / 16000
  const rms = audioRms(decoded)
  const audio = trimSilence(decoded)
  // The worker takes ownership of the buffer it is sent, so keep a copy for the one retry below.
  let out = await runOnce(audio.slice())
  // A loud-enough clip that comes back empty is retried once: cheap (well under a second), and the
  // typed box is still the fallback if the second pass is empty too.
  if (!cleanTranscript(out.text) && rms >= 0.01 && seconds >= 0.8) {
    const second = await runOnce(audio.slice())
    out = { text: second.text, ms: out.ms + second.ms }
  }
  const text = cleanTranscript(out.text)
  return { text, ms: out.ms, seconds, assessment: assessTranscript(out.text, seconds, rms) }
}
