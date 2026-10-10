import { supabase } from '@/lib/supabase'

/**
 * Cloud AI opt-in (NUTRYOS addendum rule 6: private by default). `cloudAiOptIn` is false until the
 * user taps "Always" on the consent sheet or turns it on in Settings. "Allow once" sends a single
 * request without changing this flag. Stored per device in localStorage.
 */
const OPT_IN_KEY = 'nutryos.cloudAiOptIn.v1'

export function getCloudAiOptIn(): boolean {
  try {
    return localStorage.getItem(OPT_IN_KEY) === 'true'
  } catch {
    return false
  }
}

export function setCloudAiOptIn(value: boolean): void {
  try {
    localStorage.setItem(OPT_IN_KEY, value ? 'true' : 'false')
  } catch {
    /* storage blocked: the opt-in simply doesn't persist */
  }
}

export interface AiEstimate {
  name: string
  calories: number
  proteinG: number
  fatG: number
  carbsG: number
  confidence: 'low' | 'medium'
}

interface RawEstimate {
  name?: string
  kcal?: number
  protein_g?: number
  fat_g?: number
  carbs_g?: number
  confidence?: string
}

/**
 * Step 4: asks the identify-food edge function (Gemini key held server-side, never in the app) to
 * estimate macros for the given portions. Sends ONLY the food names and grams. Returns one entry
 * per input item, or null for an item the AI couldn't estimate (an estimate of 0 kcal counts as
 * "couldn't", so it can't sneak a silent zero back in).
 */
export async function estimateMacrosViaCloud(items: Array<{ name: string; grams: number }>): Promise<Array<AiEstimate | null>> {
  const { data, error } = await supabase.functions.invoke<{ items?: RawEstimate[]; error?: string }>('identify-food', {
    body: { estimate: items.map((i) => ({ name: i.name, grams: i.grams })) },
  })
  if (error) throw new Error(`AI estimate service unreachable: ${error.message}`)
  if (data?.error) throw new Error(`AI estimate service error: ${data.error}`)
  const raw = data?.items ?? []
  return items.map((it, i) => {
    const r = raw[i]
    const kcal = Number(r?.kcal)
    if (!r || !(kcal > 0)) return null
    const n = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v) * 10) / 10 : 0)
    return {
      name: it.name,
      calories: Math.round(kcal),
      proteinG: n(r.protein_g),
      fatG: n(r.fat_g),
      carbsG: n(r.carbs_g),
      // An AI estimate is never 'high', whatever the model claims about itself.
      confidence: r.confidence === 'medium' || r.confidence === 'high' ? 'medium' : 'low',
    }
  })
}

/** Per-100 g numbers read off a nutrition panel. */
export interface LabelReading {
  name: string
  per100g: { kcal: number; proteinG: number; fatG: number; carbsG: number }
  servingG?: number
}

interface RawLabel {
  name?: unknown
  serving_g?: unknown
  per_100g?: { kcal?: unknown; protein_g?: unknown; fat_g?: unknown; carbs_g?: unknown }
  per_serving?: { kcal?: unknown; protein_g?: unknown; fat_g?: unknown; carbs_g?: unknown }
}

const pos = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined
}

/**
 * Validates what the label-reading service says (pure, unit-tested). Prefers the printed per-100 g
 * column; otherwise scales the per-serving column by 100 / serving_g. Returns null unless kcal > 0
 * and the numbers are physically possible, so a bad read can never become a silent 0.
 */
export function parseLabelReading(raw: RawLabel | null | undefined): LabelReading | null {
  if (!raw) return null
  const servingG = pos(raw.serving_g)
  let src = raw.per_100g
  let factor = 1
  if (!(pos(src?.kcal)! > 0)) {
    src = raw.per_serving
    if (!servingG || !(servingG > 0)) return null
    factor = 100 / servingG
  }
  const kcal = pos(src?.kcal)
  if (kcal === undefined || !(kcal > 0)) return null
  const r1 = (v: number) => Math.round(v * factor * 10) / 10
  const per100g = {
    kcal: Math.round(kcal * factor),
    proteinG: r1(pos(src?.protein_g) ?? 0),
    fatG: r1(pos(src?.fat_g) ?? 0),
    carbsG: r1(pos(src?.carbs_g) ?? 0),
  }
  if (per100g.kcal > 950 || per100g.proteinG + per100g.fatG + per100g.carbsG > 105) return null
  return {
    name: typeof raw.name === 'string' ? raw.name.trim().slice(0, 80) : '',
    per100g,
    servingG: servingG && servingG > 0 && servingG <= 3000 ? servingG : undefined,
  }
}

/**
 * Reads a nutrition-label photo through the identify-food edge function (the Gemini key stays
 * server-side). Callers MUST have the user's cloud-AI consent first (CloudAiConsentSheet). The
 * function must support `{label:{imageBase64,mimeType}}`; the version deployed before Phase 3 does
 * not and answers 400, which surfaces here as a thrown error so the UI shows the manual path.
 * Returns null when the service answered but could not read usable numbers.
 */
export async function readLabelViaCloud(photo: Blob): Promise<LabelReading | null> {
  const imageBase64 = await new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
    r.onerror = () => reject(r.error)
    r.readAsDataURL(photo)
  })
  const { data, error } = await supabase.functions.invoke<{ label?: RawLabel; error?: string }>('identify-food', {
    body: { label: { imageBase64, mimeType: photo.type || 'image/jpeg' } },
  })
  if (error) throw new Error(`Label reading unavailable: ${error.message}`)
  if (data?.error) throw new Error(`Label reading unavailable: ${data.error}`)
  return parseLabelReading(data?.label)
}
