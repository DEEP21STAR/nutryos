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
