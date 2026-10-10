/// <reference lib="webworker" />
/**
 * On-device speech recognition worker (NUTRYOS Phase 2). Runs transformers.js + ONNX Runtime WASM with
 * Moonshine-tiny (q8) entirely in this worker. Everything it loads comes from the app's own origin:
 * model files under <base>models/moonshine-tiny/ and the ORT wasm bundled by Vite, so nothing about
 * the user's speech or the download touches a third party. Model files are cached by transformers.js
 * in the Cache API ("transformers-cache"); the ORT wasm + loader are cached here in "nutryos-asr-v1".
 */
import { env, pipeline } from '@huggingface/transformers'
import wasmUrl from '../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url'
import mjsUrl from '../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs?url'
import { ASR_MODEL_ID, ASR_MODEL_BYTES, ASR_WASM_BYTES } from '@/lib/asr/asrConfig'

type In =
  | { type: 'init'; baseUrl: string }
  | { type: 'transcribe'; id: number; audio: Float32Array }

const ctx = self as unknown as DedicatedWorkerGlobalScope

// SPA hosts (vite preview, some static hosts) answer a missing optional file such as
// processor_config.json with index.html and status 200. transformers.js would then try to parse HTML
// as JSON and end up with a null processor, so such answers are turned into a real 404 here.
const realFetch = ctx.fetch.bind(ctx)
env.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const res = await realFetch(input, init)
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (res.ok && /\/models\/[^?]*\.(json|txt|jinja)$/.test(url) && (res.headers.get('content-type') ?? '').includes('text/html')) {
    return new Response(null, { status: 404, statusText: 'Not Found' })
  }
  return res
}
const WASM_CACHE = 'nutryos-asr-v1'

let loaded = 0
let wasmDone = 0
const perFile = new Map<string, number>()
const post = (m: unknown) => ctx.postMessage(m)
function emitProgress() {
  const modelLoaded = [...perFile.values()].reduce((a, b) => a + b, 0)
  loaded = wasmDone + modelLoaded
  post({ type: 'progress', loaded: Math.min(loaded, ASR_MODEL_BYTES + ASR_WASM_BYTES), total: ASR_MODEL_BYTES + ASR_WASM_BYTES })
}

async function cachedFetch(url: string, countProgress: boolean): Promise<ArrayBuffer> {
  let cache: Cache | null = null
  try {
    cache = await caches.open(WASM_CACHE)
    const hit = await cache.match(url)
    if (hit) {
      const buf = await hit.arrayBuffer()
      if (countProgress) { wasmDone += buf.byteLength; emitProgress() }
      return buf
    }
  } catch { /* Cache API unavailable: plain fetch below */ }
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`fetch ${url}: ${res.status}`)
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let got = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    got += value.length
    if (countProgress) { wasmDone += value.length; emitProgress() }
  }
  const out = new Uint8Array(got)
  let o = 0
  for (const c of chunks) { out.set(c, o); o += c.length }
  try { await cache?.put(url, new Response(out.slice().buffer, { headers: { 'content-type': 'application/octet-stream' } })) } catch { /* quota: next use refetches */ }
  return out.buffer
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let asr: any = null
let initPromise: Promise<void> | null = null

async function init(baseUrl: string) {
  const abs = (u: string) => new URL(u, ctx.location.href).href
  const [wasmBinary, mjsBytes] = await Promise.all([cachedFetch(abs(wasmUrl), true), cachedFetch(abs(mjsUrl), false)])
  const mjsBlob = URL.createObjectURL(new Blob([mjsBytes], { type: 'text/javascript' }))

  env.allowRemoteModels = false
  env.allowLocalModels = true
  // A path (not an absolute URL): transformers.js only probes local files for path-style roots.
  env.localModelPath = new URL('models/', baseUrl).pathname
  env.useBrowserCache = true
  env.useWasmCache = false
  const onnx = env.backends.onnx as unknown as { wasm: { wasmPaths: unknown; wasmBinary?: ArrayBuffer; numThreads?: number } }
  onnx.wasm.wasmPaths = { mjs: mjsBlob, wasm: abs(wasmUrl) }
  onnx.wasm.wasmBinary = wasmBinary
  onnx.wasm.numThreads = 1 // GitHub Pages cannot send COOP/COEP, so no SharedArrayBuffer threads

  asr = await pipeline('automatic-speech-recognition', ASR_MODEL_ID, {
    dtype: 'q8',
    device: 'wasm',
    progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
      if (p.status === 'progress' && p.file && typeof p.loaded === 'number') {
        perFile.set(p.file, p.loaded)
        emitProgress()
      }
    },
  })
}

ctx.onmessage = async (e: MessageEvent<In>) => {
  const m = e.data
  if (m.type === 'init') {
    initPromise ??= init(m.baseUrl)
    try {
      await initPromise
      post({ type: 'ready' })
    } catch (err) {
      initPromise = null
      post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  } else if (m.type === 'transcribe') {
    try {
      await initPromise
      const seconds = m.audio.length / 16000
      const t0 = performance.now()
      const out = await asr(m.audio, { max_new_tokens: Math.ceil(seconds * 8) + 16 })
      const text = Array.isArray(out) ? out.map((o: { text: string }) => o.text).join(' ') : out.text
      post({ type: 'result', id: m.id, text: String(text ?? ''), ms: Math.round(performance.now() - t0) })
    } catch (err) {
      post({ type: 'error', id: m.id, message: err instanceof Error ? err.message : String(err) })
    }
  }
}
