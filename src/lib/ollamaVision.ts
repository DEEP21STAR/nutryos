/**
 * Core-loop vision step. Two real endpoints, tried in order:
 *   1. ZENITH's Ollama over Tailscale (cross-device — phone reaching the
 *      desktop's GPU). Configure via VITE_OLLAMA_TAILSCALE_URL.
 *   2. Same-machine Ollama at localhost:11434 (confirmed live, `qwen2.5vl:3b`
 *      loaded with vision+completion capability — verified via a real curl
 *      call against a real downloaded food photo before this file was written).
 * If neither responds, callers fall back to the on-device WebGPU model
 * (lib/onDeviceVision.ts).
 *
 * BOUNDING-BOX OVERLAY — REAL FEASIBILITY TEST RESULT (Phase 5, 2026-09-17): the brief asked for
 * a MyFitnessPal-style labeled box drawn on the photo per detected item, but ONLY if qwen2.5vl:3b
 * actually returns usable grounded coordinates through this Ollama setup. Tested for real against
 * the live localhost:11434 endpoint with a real downloaded multi-item food photo (three plates +
 * garnishes), three separate prompt attempts:
 *   1. JSON-schema-forced prompt asking for a 0-1000 normalized box per item -> model returned
 *      `{"items":[]}` every time (2 runs), generating only 5 tokens — it recognized the shape but
 *      declined to fill it in rather than guess.
 *   2. Freeform prompt asking for pixel-coordinate boxes, one line per item -> returned a single
 *      vague box labeled generically "food item", not per-item.
 *   3. Freeform prompt naming the actual items in the photo (steak/cashews/chili/lettuce) and
 *      asking for a pixel box each -> DID return per-item boxes, but they are not real: for a
 *      640x427px image it returned x-coordinates over 1000 and near-duplicate boxes repeated
 *      6-11 times per item (a degenerate loop, same failure family as the original repetition bug
 *      this file's PROMPT/GENERATION_OPTIONS comment above already documents) — i.e. plausible-
 *      looking numbers that are not grounded to the actual photo.
 * Conclusion: this model, at this size, through this Ollama GGUF build, does not return real
 * bounding-box coordinates — it either refuses or hallucinates them. Per the task's explicit
 * instruction not to fabricate fake box positions to make a UI look done, NO bounding-box overlay
 * was built this phase (not even the "tap to highlight roughly" fallback the brief allowed —
 * decided that even a rough highlight risks reading as "the AI found this", which it didn't).
 * Skipping is the honest call here, flagged explicitly in the phase handback.
 *
 * NOTE on Tailscale: `tailscaled` was found installed but NOT RUNNING on this
 * dev machine, and starting it requires an interactive sudo password this
 * session doesn't have. So candidate #1 will fail here until Deep starts it
 * himself (`sudo systemctl start tailscaled`, then `tailscale up`). Candidate
 * #2 (localhost) is what's actually been verified end-to-end so far.
 */

export interface IdentifiedItem {
  name: string
  estimatedGrams: number
}

const MODEL = 'qwen2.5vl:3b'

/**
 * Prompt + generation options were both tuned against REAL failures found
 * during live testing (a real downloaded food photo, sent to the real
 * localhost Ollama endpoint): the first attempt, with an unconstrained
 * prompt and default sampling options, correctly identified the food
 * (pepperoni/ham/mushroom/olive pizza) but then fell into a degenerate
 * repetition loop — re-listing the same items at ever-halving gram values
 * forever — and hit the output-length limit (`done_reason: "length"`)
 * without ever closing the JSON, after 4m43s of CPU-only inference. Fixed by:
 * (1) explicitly telling the model not to repeat items and capping the count,
 * (2) low temperature + repeat_penalty to suppress the loop, (3) a hard
 * num_predict ceiling so a still-degenerate response fails fast instead of
 * burning minutes, (4) sending a resized (max ~640px) image, which cuts
 * vision-token count and inference time.
 */
const PROMPT =
  'Identify the distinct food items visible in this photo. List each DISTINCT item only ONCE — ' +
  'do not repeat any item, and do not list the same food at different portion sizes. Maximum 6 items total. ' +
  'Respond ONLY with valid JSON, no markdown, no commentary, in this exact shape: ' +
  '{"items":[{"name":"string","estimated_grams":number}]}. ' +
  'Use short, generic food names suitable for a nutrition database lookup (e.g. "grilled chicken breast", ' +
  'not "delicious juicy chicken"). Estimate a realistic portion size in grams for each item based on what is visible.'

const GENERATION_OPTIONS = {
  temperature: 0.1,
  repeat_penalty: 1.3,
  repeat_last_n: 256,
  num_predict: 300,
}

function candidateUrls(): string[] {
  // Ollama is a personal power-user option: it is contacted ONLY when the user (or the build) has
  // configured a URL. There is deliberately no default http://localhost:11434 probe, because on a
  // phone that is the phone's own loopback and the public site must not make that request.
  const urls: string[] = []
  const configured = getOllamaUrl()
  if (configured) urls.push(configured)
  const tailscaleUrl = import.meta.env.VITE_OLLAMA_TAILSCALE_URL as string | undefined
  if (tailscaleUrl) urls.push(tailscaleUrl.replace(/\/$/, ''))
  return [...new Set(urls)]
}

const OLLAMA_URL_KEY = 'nutryos.ollamaUrl.v1'

/** The Ollama base URL the user typed in Settings ('' when none). */
export function getOllamaUrl(): string {
  try {
    return (localStorage.getItem(OLLAMA_URL_KEY) ?? '').trim().replace(/\/$/, '')
  } catch {
    return ''
  }
}

export function setOllamaUrl(url: string): void {
  try {
    const v = url.trim().replace(/\/$/, '')
    if (v) localStorage.setItem(OLLAMA_URL_KEY, v)
    else localStorage.removeItem(OLLAMA_URL_KEY)
  } catch {
    /* storage blocked: not persisted */
  }
}

async function fileToBase64(file: Blob): Promise<string> {
  const buf = await file.arrayBuffer()
  let binary = ''
  const bytes = new Uint8Array(buf)
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

interface OllamaGenerateResponse {
  response: string
}

/**
 * Sends a photo to the first reachable Ollama endpoint and returns the
 * identified food items. Throws if every configured endpoint is unreachable
 * or returns unparseable output — callers must catch and fall back to the
 * on-device model rather than silently showing an empty result.
 */
export async function identifyFoodViaOllama(
  photo: Blob,
  { signal, timeoutMs = 45000 }: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ items: IdentifiedItem[]; endpointUsed: string }> {
  const base64 = await fileToBase64(photo)
  const errors: string[] = []

  for (const base of candidateUrls()) {
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort)
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          prompt: PROMPT,
          images: [base64],
          stream: false,
          format: 'json',
          options: GENERATION_OPTIONS,
        }),
        signal: controller.signal,
      })
      if (!res.ok) {
        errors.push(`${base}: HTTP ${res.status}`)
        continue
      }
      const data = (await res.json()) as OllamaGenerateResponse
      const parsed = JSON.parse(data.response) as { items?: Array<{ name: string; estimated_grams: number }> }
      const items = (parsed.items ?? []).map((it) => ({
        name: it.name,
        estimatedGrams: it.estimated_grams,
      }))
      if (items.length === 0) {
        errors.push(`${base}: model returned zero items`)
        continue
      }
      return { items, endpointUsed: base }
    } catch (err) {
      errors.push(`${base}: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  throw new Error(`All Ollama endpoints failed: ${errors.join(' | ')}`)
}

/**
 * Menu-photo OCR + dish extraction (Phase 3, Restaurant/Takeaway Mode, 2026-09-16). Same
 * client setup, same JSON-shape-forcing system-prompt technique, and same error handling as
 * identifyFoodViaOllama above — the only real differences are the prompt (read text off a menu
 * and list distinct DISH NAMES, not "identify food visible in a photo") and a slightly higher
 * item cap (a menu page can legitimately list many more distinct dishes than a single plate of
 * food ever would). Still /api/generate with `images`, still qwen2.5vl:3b — no new model, per
 * the task's explicit instruction to reuse the already-proven vision pipeline for OCR.
 *
 * `estimated_grams` here is a "typical serving size for this kind of dish" guess, not a
 * portion-in-the-photo guess (there is no plate in this photo) — it exists only so this
 * function can return the same IdentifiedItem[] shape as identifyFoodViaOllama and flow through
 * the exact same resolveIdentifiedItems() -> Open Food Facts name-based lookup path, per the
 * task's instruction not to build a new estimation system. The caller (MenuCapture.tsx) treats
 * these as editable defaults, same as every other portion estimate in this app.
 */
const MENU_PROMPT =
  'This photo shows a restaurant or takeaway menu (or menu section). Read the text and list the ' +
  'DISTINCT DISH NAMES you can actually read — ignore prices, descriptions, section headers, and ' +
  'anything that is not a specific orderable dish. List each dish only ONCE. Maximum 12 dishes total. ' +
  'Respond ONLY with valid JSON, no markdown, no commentary, in this exact shape: ' +
  '{"items":[{"name":"string","estimated_grams":number}]}. ' +
  'Use short, generic dish names suitable for a nutrition database lookup (e.g. "butter chicken", ' +
  'not "our famous creamy butter chicken"). For estimated_grams, give a typical restaurant serving ' +
  'size in grams for that kind of dish (a reasonable guess, e.g. ~350-450 for a main, ~150-250 for a ' +
  'side/starter) — this is a rough default the user will confirm or edit, not a measurement of ' +
  'anything visible in the photo.'

/**
 * Menu OCR is a harder, higher-hallucination-risk task than plate-food ID (small/rotated/stylized
 * menu text vs. clearly-lit food) — kept the same low-temperature/repeat-penalty discipline that
 * fixed the original repetition-loop bug in identifyFoodViaOllama, plus a larger num_predict
 * ceiling since up to 12 dish names is more output tokens than 6 food items.
 */
const MENU_GENERATION_OPTIONS = {
  temperature: 0.1,
  repeat_penalty: 1.3,
  repeat_last_n: 256,
  num_predict: 450,
}

/**
 * Sends a menu photo to the first reachable Ollama endpoint and returns the distinct dish names
 * it could read. Throws under the exact same conditions as identifyFoodViaOllama (every endpoint
 * unreachable, or every one returns unparseable/empty output) — callers must catch and fall back
 * to manual dish entry, same discipline as every other vision call in this file.
 */
export async function identifyMenuItemsViaOllama(
  photo: Blob,
  { signal, timeoutMs = 45000 }: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ items: IdentifiedItem[]; endpointUsed: string }> {
  const base64 = await fileToBase64(photo)
  const errors: string[] = []

  for (const base of candidateUrls()) {
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort)
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          prompt: MENU_PROMPT,
          images: [base64],
          stream: false,
          format: 'json',
          options: MENU_GENERATION_OPTIONS,
        }),
        signal: controller.signal,
      })
      if (!res.ok) {
        errors.push(`${base}: HTTP ${res.status}`)
        continue
      }
      const data = (await res.json()) as OllamaGenerateResponse
      const parsed = JSON.parse(data.response) as { items?: Array<{ name: string; estimated_grams: number }> }
      const items = (parsed.items ?? []).map((it) => ({
        name: it.name,
        estimatedGrams: Number(it.estimated_grams) || 350,
      }))
      if (items.length === 0) {
        errors.push(`${base}: model returned zero items`)
        continue
      }
      return { items, endpointUsed: base }
    } catch (err) {
      errors.push(`${base}: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  throw new Error(`All Ollama endpoints failed: ${errors.join(' | ')}`)
}

/**
 * Voice/text-input parsing step (Phase 2, 2026-09-16). Distinct entry point
 * from identifyFoodViaOllama above — same model, same candidate endpoints,
 * but /api/chat (multi-turn messages) instead of /api/generate (single
 * prompt + image), since the whole point of this path is a real back-and-
 * forth when the model is uncertain, not a one-shot call.
 *
 * Judgment call: qwen2.5vl:3b is a vision-language model, but its language
 * backbone is a full Qwen2.5 LLM — sending it text-only messages (no
 * `images` field) uses that backbone directly and is standard practice for
 * this model family (LLaVA/Qwen-VL-style models are always "LLM + vision
 * adapter", never vision-only). No second text model needed. This was
 * verified with a real /api/chat call against the running localhost Ollama
 * during this feature's build (see build notes) — not assumed.
 */
export interface ParsedFoodItems {
  type: 'items'
  items: IdentifiedItem[]
}
export interface ClarifyQuestion {
  type: 'clarify'
  question: string
}
export type TextParseResult = ParsedFoodItems | ClarifyQuestion

export interface ConversationTurn {
  role: 'user' | 'assistant'
  content: string
}

const TEXT_PARSE_SYSTEM_PROMPT =
  'You are a nutrition-logging assistant. The user describes food they ate in natural language, ' +
  'possibly transcribed from speech so it may contain minor transcription errors. Convert their ' +
  'description into a food item list for a nutrition database lookup.\n\n' +
  'Respond ONLY with valid JSON, no markdown, no commentary, in exactly one of these two shapes:\n' +
  '1. If you can confidently identify every food item and a reasonable portion size: ' +
  '{"type":"items","items":[{"name":"string","estimated_grams":number}]}\n' +
  '2. If any part is genuinely ambiguous (unclear quantity, unclear food identity, a vague amount ' +
  'like "some" or "a bit" with no sensible default, or multiple plausible interpretations) and asking ' +
  'would meaningfully improve accuracy: {"type":"clarify","question":"a short, specific, single ' +
  'follow-up question a person could answer in one short sentence"}\n\n' +
  'Rules: prefer "items" over "clarify" whenever a reasonable default estimate is possible — do not ' +
  'ask about things you can estimate sensibly (e.g. "a coffee" -> assume a 240ml black coffee unless ' +
  'told otherwise). Only ask ONE question at a time, about the single most important ambiguity. Use ' +
  'short, generic food names suitable for a nutrition database lookup (e.g. "scrambled eggs", not ' +
  '"delicious fluffy eggs"). Maximum 8 items total. Never fabricate detail the user did not say or imply.'

const TEXT_GENERATION_OPTIONS = {
  temperature: 0.2,
  repeat_penalty: 1.2,
  repeat_last_n: 128,
  num_predict: 250,
}

interface OllamaChatResponse {
  message?: { role?: string; content?: string }
}

/**
 * Sends the running conversation (user description + any prior
 * clarify/reply turns) to the first reachable Ollama endpoint. Throws if
 * every endpoint is unreachable or returns something unparseable — callers
 * (VoiceCapture) must catch and fall back to manual entry, same discipline
 * as identifyFoodViaOllama's callers.
 */
export async function parseFoodTextViaOllama(
  conversation: ConversationTurn[],
  { signal, timeoutMs = 30000 }: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ result: TextParseResult; endpointUsed: string }> {
  const errors: string[] = []

  for (const base of candidateUrls()) {
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort)
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: 'system', content: TEXT_PARSE_SYSTEM_PROMPT }, ...conversation],
          stream: false,
          format: 'json',
          options: TEXT_GENERATION_OPTIONS,
        }),
        signal: controller.signal,
      })
      if (!res.ok) {
        errors.push(`${base}: HTTP ${res.status}`)
        continue
      }
      const data = (await res.json()) as OllamaChatResponse
      const content = data.message?.content
      if (!content) {
        errors.push(`${base}: empty response`)
        continue
      }
      const parsed = JSON.parse(content) as {
        type?: string
        question?: string
        items?: Array<{ name: string; estimated_grams: number }>
      }
      if (parsed.type === 'clarify' && typeof parsed.question === 'string' && parsed.question.trim()) {
        return { result: { type: 'clarify', question: parsed.question.trim() }, endpointUsed: base }
      }
      if (parsed.type === 'items' && Array.isArray(parsed.items)) {
        const items = parsed.items
          .filter((it) => it && typeof it.name === 'string' && it.name.trim().length > 0)
          .map((it) => ({ name: it.name, estimatedGrams: Number(it.estimated_grams) || 100 }))
        if (items.length > 0) {
          return { result: { type: 'items', items }, endpointUsed: base }
        }
        errors.push(`${base}: model returned zero valid items`)
        continue
      }
      errors.push(`${base}: unparseable response shape`)
    } catch (err) {
      errors.push(`${base}: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  throw new Error(`All Ollama endpoints failed: ${errors.join(' | ')}`)
}
