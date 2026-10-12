import { supabase } from '@/lib/supabase'
import type { IdentifiedItem } from '@/lib/ollamaVision'
import type { CloudFixOp } from '@/lib/fixIt'

/**
 * Cloud calls for the Phase 4 capture sheet. Both go through the identify-food edge function (the
 * Gemini key stays server-side). Callers MUST have the user's consent first (CloudAiConsentSheet:
 * Allow once / Always). Only food content is sent: the photo, the note the user typed or said, and food
 * names with grams. No name, weight, goals or date of birth ever goes into these bodies.
 */

export interface PlateItem extends IdentifiedItem {
  /** 'added-fat' is the explicit "added fats" line (oil, butter, dressing the camera cannot see). */
  kind: 'food' | 'added-fat'
}

export interface PlateResult {
  items: PlateItem[]
  /** True only when the deployed function says it already used the note. The version deployed before
   * Phase 4 ignores the note, so the app applies it itself (see App.tsx). */
  noteApplied: boolean
}

interface RawPlateItem {
  name?: unknown
  estimated_grams?: unknown
  kind?: unknown
}

/** Tolerant of both response shapes: the old `{items:[{name, estimated_grams}]}` and the new one with `kind` and `note_applied`. Pure. */
export function parsePlateResponse(data: { items?: RawPlateItem[]; note_applied?: unknown } | null | undefined): PlateResult {
  const out: PlateItem[] = []
  for (const r of data?.items ?? []) {
    const name = typeof r.name === 'string' ? r.name.trim().slice(0, 80) : ''
    if (!name) continue
    const g = Number(r.estimated_grams)
    const kind = r.kind === 'added_fat' || r.kind === 'added-fat' || r.kind === 'fat' ? 'added-fat' : 'food'
    if (kind === 'added-fat' && !(g > 0)) continue // "no added fat" is simply no line, never a 0 g row
    out.push({ name, estimatedGrams: Number.isFinite(g) && g > 0 && g <= 3000 ? g : 100, kind })
  }
  return { items: out.slice(0, 10), noteApplied: data?.note_applied === true }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
    r.onerror = () => reject(r.error ?? new Error('Failed to read image'))
    r.readAsDataURL(blob)
  })
}

/**
 * Photo (plus an optional note) -> separate items and an added-fats line. Throws when the service is
 * unreachable or sees no food, so the caller can fall back to the manual path.
 */
export async function analysePlateViaCloud(photo: Blob, note: string): Promise<PlateResult> {
  const imageBase64 = await blobToBase64(photo)
  const body: Record<string, unknown> = { imageBase64, mimeType: photo.type || 'image/jpeg', split: true }
  const n = note.trim().slice(0, 300)
  if (n) body.note = n
  const { data, error } = await supabase.functions.invoke<{ items?: RawPlateItem[]; note_applied?: unknown; error?: string }>('identify-food', { body })
  if (error) throw new Error(`Photo service unreachable: ${error.message}`)
  if (data?.error) throw new Error(`Photo service error: ${data.error}`)
  const result = parsePlateResponse(data)
  if (result.items.length === 0) throw new Error('The photo service did not see any food')
  return result
}

/**
 * Harder Fix-it wording the private parser could not read. Sends the user's words and the item names
 * with grams (nothing else) and gets back proposed operations; the app validates them
 * (cloudOpsToFixOps) and applies them itself, so every number still comes from the resolution chain.
 * The function deployed before Phase 4 has no fix mode and answers 400 or an unrelated shape: that
 * surfaces here as a thrown error and the UI says so without changing anything.
 */
export async function fixViaCloud(text: string, items: Array<{ name: string; grams: number }>): Promise<CloudFixOp[]> {
  const { data, error } = await supabase.functions.invoke<{ fix?: { ops?: CloudFixOp[] }; error?: string }>('identify-food', {
    body: { fix: { text: text.trim().slice(0, 300), items: items.slice(0, 12).map((i) => ({ name: i.name.slice(0, 80), grams: i.grams })) } },
  })
  if (error) throw new Error(`Fix service unreachable: ${error.message}`)
  if (data?.error) throw new Error(`Fix service error: ${data.error}`)
  if (!Array.isArray(data?.fix?.ops)) throw new Error('Fix service is not available yet')
  return data!.fix!.ops!
}
