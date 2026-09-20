/**
 * Synchronous, per-device cache of the user's display name (2026-09-20) — exists purely so the
 * splash screen's greeting ("Good Afternoon, Deep") can render on the very first frame instead of
 * showing generic text while it waits for `fetchDisplayName`'s Supabase round-trip. Supabase stays
 * the source of truth (this is a cache, not storage of its own) — same read-fast/write-through
 * pattern as theme.ts/accentColor.ts elsewhere in this file.
 */

const KEY = 'nutrios.displayName.v1'

export function getCachedDisplayName(): string | null {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

export function setCachedDisplayName(name: string | null): void {
  try {
    if (name) localStorage.setItem(KEY, name)
    else localStorage.removeItem(KEY)
  } catch {
    // Private-browsing / storage-blocked — the splash just falls back to the generic greeting.
  }
}
