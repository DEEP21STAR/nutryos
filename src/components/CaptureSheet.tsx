import { useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { getCloudAiOptIn, setCloudAiOptIn } from '@/lib/cloudAi'
import { useDictation } from '@/lib/useDictation'

/** What the user decided about sending this photo to the cloud AI. 'private' = nothing leaves the phone. */
export type PhotoConsent = 'once' | 'always' | 'private'
type Source = 'camera' | 'gallery' | 'live'

/**
 * The one capture sheet (NUTRYOS Phase 4): camera, mic and keyboard in one place. A note (typed, or
 * spoken and transcribed on this device) rides along with the photo. The privacy choice for the photo
 * is made HERE, before the camera opens, so a first photo is: orb -> "Allow once" (opens the camera)
 * -> Log. Once the user has chosen "Always", the sheet shows a single "Photo" button instead.
 *
 * Every earlier entry point keeps its exact name: Voice, Type it, Eating Out, Scan barcode.
 */
export function CaptureSheet({
  onPhotoFile,
  onLiveCamera,
  onVoice,
  onType,
  onMenu,
  onBarcode,
  onCancel,
}: {
  onPhotoFile: (file: File, note: string, consent: PhotoConsent) => void
  onLiveCamera: (note: string, consent: PhotoConsent) => void
  onVoice: () => void
  onType: (note: string) => void
  onMenu: () => void
  onBarcode: () => void
  onCancel: () => void
}) {
  const [optedIn, setOptedIn] = useState(getCloudAiOptIn)
  const [note, setNote] = useState('')
  const [source, setSource] = useState<Source>('camera')
  const cameraInput = useRef<HTMLInputElement>(null)
  const galleryInput = useRef<HTMLInputElement>(null)
  const choiceRef = useRef<PhotoConsent>('private')
  const dictation = useDictation((t) => setNote((prev) => (prev.trim() ? `${prev.trim()}, ${t}` : t)))

  function choose(choice: PhotoConsent) {
    choiceRef.current = choice
    if (choice === 'always') {
      setCloudAiOptIn(true)
      setOptedIn(true)
    }
    if (source === 'live') onLiveCamera(note, choice)
    else (source === 'gallery' ? galleryInput.current : cameraInput.current)?.click()
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (file) onPhotoFile(file, note, optedIn ? 'always' : choiceRef.current)
  }

  const tall = 'min-h-11 whitespace-nowrap'
  const SOURCES: Array<[Source, string]> = [['camera', 'Camera'], ['gallery', 'Gallery'], ['live', 'Live view']]

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-end bg-black/60 p-4 pb-6">
      <div className="glass-card flex max-h-full w-full max-w-sm flex-col gap-2 overflow-y-auto bg-bg-primary/95 p-4 backdrop-blur-xl" data-testid="capture-sheet">
        <p className="text-center text-caption uppercase tracking-wide text-text-tertiary">Log a meal</p>

        <label className="flex flex-col gap-1">
          <span className="text-caption text-text-secondary">Note (optional), goes with a photo</span>
          <span className="flex items-stretch gap-2">
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. 2 scoops, no milk"
              maxLength={300}
              data-testid="capture-note"
              className={cn(tall, 'min-w-0 flex-1 rounded-md bg-bg-tertiary px-3 text-body text-text-primary outline-none ring-1 ring-white/10 focus:ring-accent-ai')}
            />
            <button
              type="button"
              onClick={() => (dictation.state === 'recording' ? dictation.stop() : void dictation.start())}
              disabled={dictation.state === 'transcribing'}
              aria-label={dictation.state === 'recording' ? 'Stop note' : 'Say a note'}
              data-testid="capture-note-mic"
              data-state={dictation.state}
              className={cn(
                'grid h-11 w-11 shrink-0 place-items-center rounded-full text-lg ring-1 transition active:scale-95 disabled:opacity-50',
                dictation.state === 'recording' ? 'bg-accent-danger/20 text-accent-danger ring-accent-danger/50 motion-safe:animate-pulse' : 'bg-accent-ai/10 text-accent-ai ring-accent-ai/40',
              )}
            >
              <span aria-hidden>{dictation.state === 'recording' ? '■' : dictation.state === 'transcribing' ? '…' : '🎙️'}</span>
            </button>
          </span>
          {dictation.state === 'transcribing' && <span className="text-caption text-text-tertiary">Turning that into text on this device…</span>}
          {dictation.error && <span className="text-caption text-accent-energy">{dictation.error}</span>}
        </label>

        <div className="flex flex-col gap-2 rounded-lg bg-white/[0.03] p-2.5 ring-1 ring-white/10" data-testid="photo-card">
          <div role="radiogroup" aria-label="Where the photo comes from" className="grid grid-cols-3 gap-1.5">
            {SOURCES.map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={source === key}
                onClick={() => setSource(key)}
                className={cn(tall, 'rounded-full px-2 text-caption font-semibold transition active:scale-95', source === key ? 'bg-accent-health/20 text-accent-health ring-1 ring-accent-health/50' : 'text-text-secondary ring-1 ring-white/10')}
              >
                {label}
              </button>
            ))}
          </div>

          {optedIn ? (
            <>
              <button
                onClick={() => choose('always')}
                className="glass flex min-h-12 items-center justify-center gap-2 rounded-full px-6 py-2.5 text-subtitle font-semibold text-accent-health shadow-[0_0_24px_4px_var(--glow-health)] transition active:scale-95"
              >
                <span aria-hidden>📷</span> Photo
              </button>
              <p className="text-center text-caption text-text-tertiary">Photos go to Google&rsquo;s free AI (you allowed this). Change it in Settings → Privacy.</p>
            </>
          ) : (
            <>
              <p className="text-body text-text-secondary">
                <span aria-hidden>📷</span> <span className="font-semibold text-text-primary">Photo</span> sends the picture and your note to Google&rsquo;s free AI, which may use it to improve their products. Nothing else about you is sent.
              </p>
              <div className="grid grid-cols-3 gap-1.5">
                <button onClick={() => choose('once')} className={cn(tall, 'rounded-full bg-accent-ai px-2 text-caption font-semibold text-white transition active:scale-95')}>
                  Allow once
                </button>
                <button onClick={() => choose('always')} className={cn(tall, 'rounded-full px-2 text-caption font-semibold text-accent-ai ring-1 ring-accent-ai/50 transition active:scale-95')}>
                  Always
                </button>
                <button onClick={() => choose('private')} className={cn(tall, 'rounded-full px-2 text-caption text-text-secondary ring-1 ring-white/15 transition active:scale-95')}>
                  Stay private
                </button>
              </div>
              <p className="text-center text-caption text-text-tertiary">&ldquo;Stay private&rdquo; keeps the photo on this phone and you add the food by hand.</p>
            </>
          )}
          <input ref={cameraInput} type="file" accept="image/*" capture="environment" className="hidden" data-testid="capture-photo-input" onChange={onFile} />
          <input ref={galleryInput} type="file" accept="image/*" className="hidden" data-testid="capture-gallery-input" onChange={onFile} />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={onVoice}
            className="glass flex min-h-12 items-center justify-center gap-2 rounded-full whitespace-nowrap px-2 py-2.5 text-[15px] font-semibold text-accent-ai transition active:scale-95"
          >
            <span aria-hidden>🎙️</span> Voice
          </button>
          <button
            onClick={() => onType(note)}
            className="glass flex min-h-12 items-center justify-center gap-2 rounded-full whitespace-nowrap px-2 py-2.5 text-[15px] font-semibold text-text-primary transition active:scale-95"
          >
            <span aria-hidden>⌨️</span> Type it
          </button>
          <button
            onClick={onMenu}
            className="glass flex min-h-12 items-center justify-center gap-2 rounded-full whitespace-nowrap px-2 py-2.5 text-[15px] font-semibold text-accent-energy transition active:scale-95"
          >
            <span aria-hidden>🍽️</span> Eating Out
          </button>
          <button
            onClick={onBarcode}
            className="glass flex min-h-12 items-center justify-center gap-2 rounded-full whitespace-nowrap px-2 py-2.5 text-[15px] font-semibold text-text-primary transition active:scale-95"
          >
            <span aria-hidden>📦</span> Scan barcode
          </button>
        </div>
        <button onClick={onCancel} className="mx-auto min-h-11 px-6 text-caption text-text-tertiary underline">
          Cancel
        </button>
      </div>
    </div>
  )
}
