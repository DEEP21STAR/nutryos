import { useRef } from 'react'
import { useFocusTrap } from '@/components/useFocusTrap'

/**
 * First-use consent for cloud AI (NUTRYOS addendum rule 6). NUTRYOS is private by default; nothing
 * goes to the cloud AI until the user picks "Allow once" (this request only) or "Always" (sets the
 * cloudAiOptIn setting). "Stay private" sends nothing.
 */
export type CloudAiChoice = 'once' | 'always' | 'private'

export function CloudAiConsentSheet({
  foodNames,
  onChoose,
}: {
  /** What would be sent, shown verbatim so the user sees exactly what leaves the phone. */
  foodNames: string[]
  onChoose: (choice: CloudAiChoice) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useFocusTrap(ref, () => onChoose('private'))
  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 p-4 pb-8" onClick={() => onChoose('private')}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cloud-ai-title"
        className="glass-card flex w-full max-w-sm flex-col gap-3 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="cloud-ai-title" className="text-subtitle font-semibold text-text-primary">
          Estimate with AI?
        </h3>
        <p className="text-body text-text-secondary">
          AI estimate sends the food name and portion ({foodNames.join(', ')}) to Google's free AI, which may use it to
          improve their products. Nothing else about you is sent.
        </p>
        <p className="text-caption text-text-tertiary">You can change this any time in Settings → Privacy.</p>
        <div className="mt-1 flex flex-col gap-2">
          <button
            onClick={() => onChoose('once')}
            className="rounded-full bg-accent-ai px-4 py-3 text-body font-semibold text-white transition active:scale-[0.98]"
          >
            Allow once
          </button>
          <button
            onClick={() => onChoose('always')}
            className="rounded-full px-4 py-3 text-body font-semibold text-accent-ai ring-1 ring-accent-ai/50 transition active:scale-[0.98]"
          >
            Always
          </button>
          <button onClick={() => onChoose('private')} className="rounded-full px-4 py-2.5 text-body text-text-secondary">
            Stay private
          </button>
        </div>
      </div>
    </div>
  )
}
