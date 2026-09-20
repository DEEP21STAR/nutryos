/**
 * Shared-family vision fallback (2026-09-17) — calls the `identify-food` Supabase Edge
 * Function, which holds the one real Gemini API key server-side. No family member's device
 * ever sees a key or needs one; the app just calls this the same way every other Supabase
 * request already works. Needs internet (any kind — wifi or mobile data), but nothing
 * device-specific like WebGPU, so this is the reliable fallback when Ollama's unreachable,
 * ahead of the on-device path in the chain (see App.tsx's handleCapture).
 */
import { supabase } from '@/lib/supabase'
import type { IdentifiedItem, ConversationTurn, TextParseResult } from '@/lib/ollamaVision'

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result as string
      resolve(dataUrl.slice(dataUrl.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read image as base64'))
    reader.readAsDataURL(blob)
  })
}

/** Raw shape actually returned by the Edge Function — `estimated_grams`, snake_case, straight
 * from Gemini's own JSON. NOT the same shape as `IdentifiedItem` (`estimatedGrams`, camelCase) —
 * real bug, found live: casting the raw response directly as IdentifiedItem[] left
 * `estimatedGrams` undefined on every item, which cascaded into NaN kcal/macros on the confirm
 * screen. ollamaVision.ts already does this exact rename at its own boundary; this was just
 * missing here. */
type RawGeminiItem = { name: string; estimated_grams: number }

export async function identifyFoodViaGemini(photo: Blob): Promise<IdentifiedItem[]> {
  const imageBase64 = await blobToBase64(photo)
  const mimeType = photo.type || 'image/jpeg'

  const { data, error } = await supabase.functions.invoke<{ items?: RawGeminiItem[]; error?: string }>(
    'identify-food',
    { body: { imageBase64, mimeType } },
  )

  if (error) {
    throw new Error(`Shared vision service unreachable: ${error.message}`)
  }
  if (data?.error) {
    throw new Error(`Shared vision service error: ${data.error}`)
  }
  const rawItems = data?.items ?? []
  if (rawItems.length === 0) {
    throw new Error('Shared vision service returned zero items')
  }
  return rawItems.map((it) => ({ name: it.name, estimatedGrams: Number(it.estimated_grams) || 100 }))
}

/**
 * Text/voice meal-description fallback (2026-09-20) — same `identify-food` Edge Function as the
 * photo path above, distinguished by sending `{conversation}` instead of `{imageBase64, mimeType}`.
 * Exists because the text path had NO fallback at all before this: `VITE_OLLAMA_TAILSCALE_URL`
 * never reached the production build (only the Supabase secrets are wired into the GitHub Actions
 * workflow), so `candidateUrls()` resolved to just the caller's own `localhost:11434` for every
 * real deployed user — a phone's own loopback address, never reachable. VoiceCapture.tsx now
 * catches that and falls through to this, mirroring the photo path's Ollama -> Gemini cascade.
 */
export async function parseFoodTextViaGemini(
  conversation: ConversationTurn[],
): Promise<{ result: TextParseResult; endpointUsed: string }> {
  const { data, error } = await supabase.functions.invoke<
    { type?: string; question?: string; items?: { name: string; estimated_grams: number }[]; error?: string }
  >('identify-food', { body: { conversation } })

  if (error) {
    throw new Error(`Shared text-parsing service unreachable: ${error.message}`)
  }
  if (data?.error) {
    throw new Error(`Shared text-parsing service error: ${data.error}`)
  }
  if (data?.type === 'clarify' && data.question) {
    return { result: { type: 'clarify', question: data.question }, endpointUsed: 'gemini' }
  }
  if (data?.type === 'items' && Array.isArray(data.items) && data.items.length > 0) {
    const items = data.items.map((it) => ({ name: it.name, estimatedGrams: Number(it.estimated_grams) || 100 }))
    return { result: { type: 'items', items }, endpointUsed: 'gemini' }
  }
  throw new Error('Shared text-parsing service returned an unparseable result')
}
