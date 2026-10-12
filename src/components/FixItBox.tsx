import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import type { FoodItem } from '@/lib/types'
import { loadCuratedFoods } from '@/lib/curatedFoods'
import { applyFixOps, cloudOpsToFixOps, planFix, type FixOp, type FixTargetOption } from '@/lib/fixIt'
import { fixViaCloud } from '@/lib/photoAnalysis'
import { getCloudAiOptIn, setCloudAiOptIn } from '@/lib/cloudAi'
import { CloudAiConsentSheet, type CloudAiChoice } from '@/components/CloudAiConsentSheet'

/**
 * "Fix it" (NUTRYOS Phase 4): a result is never final. Say what was wrong in plain words ("it was 2
 * scoops, no milk") or tap a one-tap chip. The private deterministic reader (lib/fixIt.ts) handles the
 * simple corrections on this device; only wording it cannot read can go to the cloud helper, and only
 * after the same Allow once / Always / Stay private choice. Only the item(s) the correction names are
 * re-worked; every other item is left exactly as it was. Undo restores the whole list.
 */

const CHIPS: Array<{ key: string; label: string; op: { scale: number } | 'remove' }> = [
  { key: 'half', label: 'Half', op: { scale: 0.5 } },
  { key: 'double', label: 'Double', op: { scale: 2 } },
  { key: 'more', label: 'A bit more', op: { scale: 1.25 } },
  { key: 'less', label: 'A bit less', op: { scale: 0.75 } },
  { key: 'large', label: 'Large', op: { scale: 1.5 } },
  { key: 'small', label: 'Small', op: { scale: 0.75 } },
  { key: 'remove', label: 'Not eaten', op: 'remove' },
]

export function FixItBox({
  items,
  onApply,
  seed = '',
  initialChanges = [],
}: {
  items: FoodItem[]
  /** `touched` = ids whose portion was reset by the fix (the stepper re-bases on them). */
  onApply: (next: FoodItem[], touched: string[]) => void
  /** Words the app could not apply by itself (e.g. an unread part of the photo note): pre-fills the box. */
  seed?: string
  /** Lines describing what the photo note already changed. */
  initialChanges?: string[]
}) {
  // Open from the start when there is a note result to show or just one item (so the chips are one tap).
  const [open, setOpen] = useState(seed.length > 0 || initialChanges.length > 0 || items.length === 1)
  const [text, setText] = useState(seed)
  const [targetId, setTargetId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [changes, setChanges] = useState<string[]>(initialChanges)
  const [notes, setNotes] = useState<string[]>([])
  const [ask, setAsk] = useState<{ clause: string; candidates: FixTargetOption[] } | null>(null)
  const [unhandled, setUnhandled] = useState<string[]>([])
  const [message, setMessage] = useState<string | null>(null)
  const [undo, setUndo] = useState<FoodItem[] | null>(null)
  const [consentFor, setConsentFor] = useState<string | null>(null)
  const itemsRef = useRef(items)
  itemsRef.current = items

  // A removed item can no longer be the target.
  useEffect(() => {
    if (targetId && !items.some((i) => i.id === targetId)) setTargetId(null)
  }, [items, targetId])

  function commit(before: readonly FoodItem[], next: FoodItem[], touched: string[], lines: string[]) {
    setUndo([...before])
    setChanges(lines)
    onApply(next, touched)
  }

  /** Runs a correction. `forcedTarget` answers an earlier "Which item?" question. */
  async function run(words: string, forcedTarget?: string) {
    const said = words.trim()
    if (!said || busy) return
    setBusy(true)
    setMessage(null)
    setAsk(null)
    setNotes([])
    setUnhandled([])
    try {
      const before = itemsRef.current
      const foods = await loadCuratedFoods()
      const plan = planFix(said, before, foods, { targetId: forcedTarget ?? targetId })
      let lines: string[] = []
      let touched: string[] = []
      if (plan.ops.length > 0) {
        const r = await applyFixOps(before, plan.ops)
        lines = r.changes
        touched = r.touched
        commit(before, r.items, touched, lines)
      } else {
        setChanges([])
      }
      setNotes(plan.notes)
      setAsk(plan.ask)
      setUnhandled(plan.unhandled)
      if (plan.ops.length === 0 && !plan.ask && plan.unhandled.length === 0 && plan.notes.length === 0) setMessage('Nothing to change.')
      if (plan.ops.length > 0 && plan.unhandled.length === 0 && !plan.ask) setText('')
    } finally {
      setBusy(false)
    }
  }

  async function runChip(chip: (typeof CHIPS)[number]) {
    if (busy) return
    const before = itemsRef.current
    const target = targetId ? before.find((i) => i.id === targetId) : before.length === 1 ? before[0] : undefined
    setMessage(null)
    setNotes([])
    setUnhandled([])
    if (!target) {
      setAsk({ clause: chip.label, candidates: before.map((i) => ({ id: i.id, name: i.name })) })
      return
    }
    setAsk(null)
    await runOps(chip.op === 'remove' ? [{ kind: 'remove', id: target.id }] : [{ kind: 'scale', id: target.id, factor: chip.op.scale }])
  }

  async function runOps(ops: FixOp[]) {
    setBusy(true)
    try {
      const before = itemsRef.current
      const r = await applyFixOps(before, ops)
      commit(before, r.items, r.touched, r.changes)
    } finally {
      setBusy(false)
    }
  }

  /** The ask-which-item chips: answer the question, then re-run the same words on that item. */
  async function answerAsk(id: string) {
    if (!ask) return
    const clause = ask.clause
    const chip = CHIPS.find((c) => c.label === clause)
    setTargetId(id)
    if (chip) {
      setAsk(null)
      await runOps(chip.op === 'remove' ? [{ kind: 'remove', id }] : [{ kind: 'scale', id, factor: chip.op.scale }])
    } else {
      await run(clause, id)
    }
  }

  function requestCloud(words: string) {
    if (getCloudAiOptIn()) void runCloud(words)
    else setConsentFor(words)
  }

  async function runCloud(words: string) {
    setBusy(true)
    setMessage(null)
    try {
      const before = itemsRef.current
      const raw = await fixViaCloud(words, before.map((i) => ({ name: i.name, grams: i.estimatedGrams })))
      const ops = cloudOpsToFixOps(raw, before)
      if (ops.length === 0) {
        setMessage("The AI didn't suggest a change for that. Nothing was changed.")
        return
      }
      const r = await applyFixOps(before, ops)
      commit(before, r.items, r.touched, r.changes)
      setUnhandled([])
      setText('')
    } catch {
      setMessage("The AI helper isn't available right now, so nothing was changed. Try simpler words, a chip above, or edit the item.")
    } finally {
      setBusy(false)
    }
  }

  function onConsent(choice: CloudAiChoice) {
    const words = consentFor ?? ''
    setConsentFor(null)
    if (choice === 'private') {
      setMessage('Nothing was sent. Try simpler words, a chip above, or edit the item.')
      return
    }
    if (choice === 'always') setCloudAiOptIn(true)
    void runCloud(words)
  }

  function doUndo() {
    if (!undo) return
    onApply(undo, undo.map((i) => i.id))
    setUndo(null)
    setChanges(['Undone.'])
    setNotes([])
    setAsk(null)
    setUnhandled([])
  }

  const single = items.length === 1

  return (
    <div className="glass-card mx-4 mt-4 flex flex-col gap-2 p-3" data-testid="fixit">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-testid="fixit-toggle"
        className="flex min-h-11 items-center justify-between gap-2 text-left"
      >
        <span className="flex items-center gap-2 text-body font-semibold text-accent-ai">
          <span aria-hidden>✏️</span> Fix it
          <span className="text-caption font-normal text-text-tertiary">say what was wrong</span>
        </span>
        <span aria-hidden className="text-text-tertiary">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <>
          {!single && (
            <div className="flex flex-col gap-1.5">
              <span className="text-caption text-text-secondary">It&rsquo;s about (tap one, or just name it below)</span>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Which item">
                {items.map((it) => (
                  <button
                    key={it.id}
                    type="button"
                    aria-pressed={targetId === it.id}
                    onClick={() => setTargetId((cur) => (cur === it.id ? null : it.id))}
                    className={cn(
                      'min-h-11 max-w-[11rem] truncate rounded-full px-3 text-caption font-semibold ring-1 transition active:scale-95',
                      targetId === it.id ? 'bg-accent-ai/25 text-accent-ai ring-accent-ai/60' : 'text-text-secondary ring-white/15',
                    )}
                  >
                    {it.name || 'Unnamed item'}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="flex items-stretch gap-2">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void run(text)
              }}
              placeholder="e.g. it was 2 scoops, no milk"
              aria-label="Say what to fix"
              data-testid="fixit-input"
              maxLength={300}
              className="min-h-11 min-w-0 flex-1 rounded-md bg-bg-tertiary px-3 text-body text-text-primary outline-none ring-1 ring-white/10 focus:ring-accent-ai"
            />
            <button
              type="button"
              onClick={() => void run(text)}
              disabled={busy || !text.trim()}
              data-testid="fixit-submit"
              className="min-h-11 shrink-0 rounded-full bg-accent-ai px-4 text-body font-semibold text-white transition active:scale-95 disabled:opacity-40"
            >
              Fix it
            </button>
          </div>

          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Quick fixes">
            {CHIPS.map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={() => void runChip(c)}
                disabled={busy}
                data-testid={`fixit-chip-${c.key}`}
                className="min-h-11 rounded-full px-3 text-caption font-semibold text-text-secondary ring-1 ring-white/15 transition active:scale-95 disabled:opacity-40"
              >
                {c.label}
              </button>
            ))}
          </div>

          {ask && (
            <div className="flex flex-col gap-1.5 rounded-md bg-accent-energy/10 p-2.5 ring-1 ring-accent-energy/30" data-testid="fixit-ask">
              <p className="text-caption text-accent-energy">Which item did you mean for &ldquo;{ask.clause}&rdquo;? Nothing has changed yet.</p>
              <div className="flex flex-wrap gap-1.5">
                {ask.candidates.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => void answerAsk(c.id)}
                    className="min-h-11 max-w-[11rem] truncate rounded-full px-3 text-caption font-semibold text-accent-energy ring-1 ring-accent-energy/50 transition active:scale-95"
                  >
                    {c.name || 'Unnamed item'}
                  </button>
                ))}
              </div>
            </div>
          )}

          {unhandled.length > 0 && (
            <div className="flex flex-col gap-1.5 rounded-md bg-white/[0.04] p-2.5 ring-1 ring-white/10" data-testid="fixit-unhandled">
              <p className="text-caption text-text-secondary">I couldn&rsquo;t apply &ldquo;{unhandled.join(', ')}&rdquo; on this phone.</p>
              <button
                type="button"
                onClick={() => requestCloud(unhandled.join(', '))}
                disabled={busy}
                data-testid="fixit-ask-ai"
                className="min-h-11 self-start rounded-full px-4 text-caption font-semibold text-accent-ai ring-1 ring-accent-ai/50 transition active:scale-95 disabled:opacity-40"
              >
                Ask the AI to apply this
              </button>
            </div>
          )}

          <div aria-live="polite" className="flex flex-col gap-1" data-testid="fixit-summary">
            {changes.map((c, i) => (
              <p key={`${i}-${c}`} className="text-caption text-accent-health">✓ {c}</p>
            ))}
            {notes.map((n) => (
              <p key={n} className="text-caption text-accent-energy">{n}</p>
            ))}
            {message && <p className="text-caption text-text-secondary">{message}</p>}
          </div>

          {undo && (
            <button
              type="button"
              onClick={doUndo}
              data-testid="fixit-undo"
              className="min-h-11 self-start rounded-full px-4 text-caption font-semibold text-text-secondary ring-1 ring-white/15 transition active:scale-95"
            >
              Undo
            </button>
          )}
        </>
      )}

      {consentFor !== null && (
        <CloudAiConsentSheet kind="fix" foodNames={items.map((i) => `${i.name}, ${i.estimatedGrams} g`)} onChoose={onConsent} />
      )}
    </div>
  )
}
