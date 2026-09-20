import { useCallback, useEffect, useRef, useState } from 'react'
import gsap from 'gsap'
import { cn, prefersReducedMotion } from '@/lib/utils'
import { parseFoodTextViaOllama } from '@/lib/ollamaVision'
import type { ConversationTurn } from '@/lib/ollamaVision'
import { parseFoodTextViaGemini } from '@/lib/geminiVision'
import { resolveIdentifiedItems } from '@/lib/resolveFoodItems'
import type { FoodItem } from '@/lib/types'

/**
 * Voice/text input mode for the Input Orb (Phase 2, 2026-09-16). Real
 * MediaRecorder audio capture + a live level/waveform visualization, with
 * the Web Speech API (SpeechRecognition) for live transcription where the
 * browser actually supports it, and a manual-transcript fallback everywhere
 * else. Once the user sends a description, it goes to the AI for parsing —
 * and if the AI is genuinely uncertain, it asks ONE real follow-up question
 * back (a small conversational loop, capped at MAX_CLARIFY_ROUNDS turns so
 * a stubbornly-ambiguous description can't loop forever) instead of
 * silently guessing. This is the differentiator Deep specifically asked for
 * — no major competitor (Hoot, MyFitnessPal, Cronometer, MacroFactor, per
 * the 2026-09-16 competitive research) does this proactively.
 *
 * REAL BROWSER SUPPORT, checked not assumed: SpeechRecognition /
 * webkitSpeechRecognition is Chrome/Edge/Chromium-only in any real sense —
 * Firefox has never shipped it and Safari's implementation is unreliable/
 * partial. So this component treats live STT as a progressive enhancement,
 * never a requirement: audio recording + an editable transcript textarea
 * (pre-filled with whatever live STT captured, or empty if none) is the
 * actual first-class path, not an error state.
 */

const NUM_BARS = 24
const MAX_CLARIFY_ROUNDS = 3

type Phase = 'recording' | 'reviewing' | 'parsing' | 'clarifying' | 'error'

// Minimal ambient shape for the Web Speech API — there is no official TS DOM
// lib type for it (still a non-standard/experimental API in the spec sense),
// so this types only the handful of members actually used here rather than
// pulling in a full @types package for two fields.
interface MinimalSpeechRecognition {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((event: unknown) => void) | null
  onerror: ((event: unknown) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
}

function getSpeechRecognitionCtor(): (new () => MinimalSpeechRecognition) | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => MinimalSpeechRecognition
    webkitSpeechRecognition?: new () => MinimalSpeechRecognition
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

interface SpeechResultLike {
  resultIndex: number
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>
}

export function VoiceCapture({
  onResolved,
  onCancel,
}: {
  onResolved: (items: FoodItem[]) => void
  onCancel: () => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [closing, setClosing] = useState(false)

  const [phase, setPhase] = useState<Phase>('recording')
  const [micError, setMicError] = useState<string | null>(null)
  const [transcript, setTranscript] = useState('')
  const [liveInterim, setLiveInterim] = useState('')
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [level, setLevel] = useState(0)
  const [conversation, setConversation] = useState<ConversationTurn[]>([])
  const [clarifyQuestion, setClarifyQuestion] = useState<string | null>(null)
  const [replyText, setReplyText] = useState('')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const speechSupported = useRef(getSpeechRecognitionCtor() !== null).current
  const reducedMotion = useRef(prefersReducedMotion()).current

  const streamRef = useRef<MediaStream | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const recognitionRef = useRef<MinimalSpeechRecognition | null>(null)
  const finalTranscriptRef = useRef('')
  const audioCtxRef = useRef<AudioContext | null>(null)
  const rafRef = useRef<number | null>(null)
  const levelIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const barsRef = useRef<(HTMLDivElement | null)[]>([])

  // Same elastic-spring entrance/exit as CameraCapture, duplicated rather
  // than shared — small enough (12 lines) that factoring it out into a hook
  // isn't worth touching CameraCapture's working code for.
  useEffect(() => {
    const el = panelRef.current
    if (!el) return
    if (prefersReducedMotion()) {
      gsap.set(el, { opacity: 1, scale: 1 })
      return
    }
    gsap.fromTo(
      el,
      { scale: 0.15, opacity: 0, borderRadius: 9999 },
      { scale: 1, opacity: 1, borderRadius: 0, duration: 0.9, ease: 'elastic.out(1, 0.4)', transformOrigin: '50% 100%' },
    )
  }, [])

  function playExitThen(cb: () => void) {
    const el = panelRef.current
    if (!el || prefersReducedMotion()) {
      cb()
      return
    }
    setClosing(true)
    gsap.to(el, {
      scale: 0.15,
      opacity: 0,
      borderRadius: 9999,
      duration: 0.45,
      ease: 'power3.in',
      transformOrigin: '50% 100%',
      onComplete: cb,
    })
  }

  const stopLevelMeter = useCallback(() => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    if (levelIntervalRef.current != null) clearInterval(levelIntervalRef.current)
    levelIntervalRef.current = null
    audioCtxRef.current?.close().catch(() => {})
    audioCtxRef.current = null
  }, [])

  const startLevelMeter = useCallback(
    (stream: MediaStream) => {
      const AudioCtxCtor =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!AudioCtxCtor) return
      const ctx = new AudioCtxCtor()
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 64
      source.connect(analyser)
      audioCtxRef.current = ctx
      const data = new Uint8Array(analyser.frequencyBinCount)

      if (reducedMotion) {
        // Simple, non-continuous level meter: sampled 4x/sec, no animation/
        // transition applied to it — a numeric snap, not a particle effect.
        levelIntervalRef.current = setInterval(() => {
          analyser.getByteFrequencyData(data)
          const avg = data.reduce((a, b) => a + b, 0) / data.length
          setLevel(Math.min(1, avg / 140))
        }, 250)
        return
      }

      const bucket = Math.max(1, Math.floor(data.length / NUM_BARS))
      const tick = () => {
        analyser.getByteFrequencyData(data)
        for (let i = 0; i < NUM_BARS; i++) {
          const v = data[i * bucket] ?? 0
          const pct = 12 + (v / 255) * 88
          const el = barsRef.current[i]
          if (el) el.style.height = `${pct}%`
        }
        rafRef.current = requestAnimationFrame(tick)
      }
      rafRef.current = requestAnimationFrame(tick)
    },
    [reducedMotion],
  )

  const startRecording = useCallback(() => {
    let cancelled = false

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setMicError('no-getUserMedia')
        return
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = stream

        const supportedType = ['audio/webm', 'audio/mp4', 'audio/ogg'].find((t) =>
          typeof MediaRecorder.isTypeSupported === 'function' ? MediaRecorder.isTypeSupported(t) : false,
        )
        const recorder = supportedType ? new MediaRecorder(stream, { mimeType: supportedType }) : new MediaRecorder(stream)
        chunksRef.current = []
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data)
        }
        recorder.start()
        mediaRecorderRef.current = recorder

        startLevelMeter(stream)

        const SR = getSpeechRecognitionCtor()
        if (SR) {
          const recognition = new SR()
          recognition.continuous = true
          recognition.interimResults = true
          recognition.lang = navigator.language || 'en-US'
          finalTranscriptRef.current = ''
          recognition.onresult = (event) => {
            const e = event as SpeechResultLike
            let interim = ''
            for (let i = e.resultIndex; i < e.results.length; i++) {
              const res = e.results[i]
              if (res.isFinal) finalTranscriptRef.current += res[0].transcript
              else interim += res[0].transcript
            }
            setLiveInterim(interim)
          }
          // Real gap: recognition can drop mid-session (network blip, no-speech
          // timeout, etc). Audio recording is unaffected by this — the user
          // still gets a correct editable transcript box at the review step,
          // it just won't have live captions from that point on.
          recognition.onerror = () => {}
          recognition.onend = () => {}
          recognition.start()
          recognitionRef.current = recognition
        }
      } catch (err) {
        setMicError(err instanceof Error ? err.name : 'unknown')
      }
    }

    start()
    return () => {
      cancelled = true
    }
  }, [startLevelMeter])

  useEffect(() => {
    const cleanup = startRecording()
    return () => {
      cleanup()
      recognitionRef.current?.stop()
      stopLevelMeter()
      streamRef.current?.getTracks().forEach((t) => t.stop())
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop()
      }
    }
    // Intentionally run once on mount — re-recording calls startRecording()
    // directly rather than re-triggering this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Shared by the "Stop" button and the "Type instead / skip audio" escape
   * hatch — both just mean "I'm done producing audio, move to review",
   * whether or not any audio actually exists yet. */
  function finishRecording() {
    recognitionRef.current?.stop()
    stopLevelMeter()
    const recorder = mediaRecorderRef.current
    if (recorder && recorder.state !== 'inactive') {
      const mt = recorder.mimeType
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mt || 'audio/webm' })
        setAudioUrl(URL.createObjectURL(blob))
        streamRef.current?.getTracks().forEach((t) => t.stop())
      }
      recorder.stop()
    } else {
      streamRef.current?.getTracks().forEach((t) => t.stop())
    }
    setTranscript((finalTranscriptRef.current + ' ' + liveInterim).trim())
    setPhase('reviewing')
  }

  function reRecord() {
    if (audioUrl) URL.revokeObjectURL(audioUrl)
    setAudioUrl(null)
    setTranscript('')
    setLiveInterim('')
    finalTranscriptRef.current = ''
    setMicError(null)
    setPhase('recording')
    startRecording()
  }

  async function runParse(conv: ConversationTurn[]) {
    setPhase('parsing')
    setErrorMessage(null)
    try {
      // Ollama first (free, local — works when Deep's own machine is reachable), Gemini as the
      // real fallback. Real bug found 2026-09-20: this path previously had NO fallback at all —
      // VITE_OLLAMA_TAILSCALE_URL never reached the production build, so every deployed user's
      // only candidate was their own device's localhost:11434, which always fails. Mirrors the
      // Ollama -> Gemini cascade App.tsx's handleCapture already does for the photo path.
      let result
      try {
        ;({ result } = await parseFoodTextViaOllama(conv))
      } catch (ollamaErr) {
        console.warn('parseFoodTextViaOllama failed, falling back to Gemini:', ollamaErr)
        ;({ result } = await parseFoodTextViaGemini(conv))
      }
      if (result.type === 'clarify') {
        const askedSoFar = conv.filter((t) => t.role === 'assistant').length
        if (askedSoFar >= MAX_CLARIFY_ROUNDS) {
          // Safety cap — stop asking and hand back to ConfirmLog's manual
          // fallback rather than looping the user through more questions.
          onResolved([])
          return
        }
        setConversation([...conv, { role: 'assistant', content: result.question }])
        setClarifyQuestion(result.question)
        setReplyText('')
        setPhase('clarifying')
        return
      }
      const resolved = await resolveIdentifiedItems(result.items)
      onResolved(resolved)
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Could not understand that — try again or add items manually.',
      )
      setPhase('error')
    }
  }

  function sendTranscript() {
    const text = transcript.trim()
    if (!text) return
    const conv: ConversationTurn[] = [...conversation, { role: 'user', content: text }]
    setConversation(conv)
    runParse(conv)
  }

  function sendReply() {
    const text = replyText.trim()
    if (!text) return
    const conv: ConversationTurn[] = [...conversation, { role: 'user', content: text }]
    setConversation(conv)
    runParse(conv)
  }

  function quickVoiceReply() {
    const SR = getSpeechRecognitionCtor()
    if (!SR) return
    const recognition = new SR()
    recognition.lang = navigator.language || 'en-US'
    recognition.interimResults = true
    recognition.onresult = (event) => {
      const e = event as SpeechResultLike
      let text = ''
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript
      setReplyText(text)
    }
    recognition.onerror = () => {}
    recognition.onend = () => {}
    recognition.start()
  }

  function cancel() {
    playExitThen(onCancel)
  }

  const micBlocked = micError != null

  return (
    <div
      ref={panelRef}
      className={cn('fixed inset-0 z-50 flex flex-col overflow-y-auto bg-bg-primary', closing && 'pointer-events-none')}
    >
      <div className="flex items-center justify-between p-4">
        <button onClick={cancel} className="glass rounded-full px-4 py-2 text-caption text-text-primary">
          Cancel
        </button>
        <span className="glass rounded-full px-3 py-1 text-caption text-accent-ai shadow-[0_0_16px_2px_var(--glow-ai)]">
          Voice mode
        </span>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6 pb-10">
        {phase === 'recording' && (
          <>
            {micBlocked ? (
              <div className="glass-card max-w-xs p-6 text-center">
                <p className="text-body text-text-secondary">
                  {micError === 'no-getUserMedia'
                    ? 'Microphone recording is not available in this browser.'
                    : 'Microphone permission was denied or no microphone was found.'}
                </p>
                <p className="mt-2 text-caption text-text-tertiary">You can still type what you ate.</p>
              </div>
            ) : (
              <>
                <div className="text-caption text-accent-ai motion-safe:animate-pulse">Listening…</div>
                {reducedMotion ? (
                  <div className="h-3 w-48 overflow-hidden rounded-full bg-bg-tertiary">
                    <div
                      className="h-full rounded-full bg-accent-ai"
                      style={{ width: `${12 + level * 88}%`, transition: 'none' }}
                    />
                  </div>
                ) : (
                  <div className="glass-card flex h-24 w-full max-w-xs items-end justify-center gap-1 px-4 py-3">
                    {Array.from({ length: NUM_BARS }).map((_, i) => (
                      <div
                        key={i}
                        ref={(el) => {
                          barsRef.current[i] = el
                        }}
                        className="w-1.5 rounded-full bg-accent-ai shadow-[0_0_6px_1px_var(--glow-ai)]"
                        style={{ height: '12%' }}
                      />
                    ))}
                  </div>
                )}
                {speechSupported ? (
                  <p className="max-w-xs text-center text-body text-text-secondary">
                    {finalTranscriptRef.current || liveInterim || 'Say what you ate…'}
                  </p>
                ) : (
                  <p className="max-w-xs text-center text-caption text-text-tertiary">
                    Live captions aren't available in this browser — you'll get to edit the text after stopping.
                  </p>
                )}
                <button
                  onClick={finishRecording}
                  className="rounded-full bg-accent-ai px-8 py-3 text-subtitle font-semibold text-white shadow-[0_0_28px_6px_var(--glow-ai)] transition active:scale-95"
                >
                  Stop
                </button>
              </>
            )}
            <button onClick={finishRecording} className="text-caption text-text-tertiary underline">
              {micBlocked ? 'Type it instead' : 'Skip recording, type instead'}
            </button>
          </>
        )}

        {phase === 'reviewing' && (
          <div className="flex w-full max-w-xs flex-col gap-3">
            {audioUrl && <audio controls src={audioUrl} className="w-full" />}
            <textarea
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
              placeholder="e.g. I had a handful of almonds, a black coffee, and two scrambled eggs with hot sauce"
              rows={4}
              className="w-full resize-none rounded-md bg-bg-tertiary px-3 py-2 text-body text-text-primary outline-none ring-1 ring-white/5 focus:ring-accent-ai"
            />
            <div className="flex gap-2">
              <button
                onClick={reRecord}
                className="glass flex-1 rounded-full px-4 py-2.5 text-caption text-text-secondary transition active:scale-95"
              >
                Re-record
              </button>
              <button
                onClick={sendTranscript}
                disabled={!transcript.trim()}
                className="flex-1 rounded-full bg-accent-ai px-4 py-2.5 text-caption font-semibold text-white shadow-[0_0_20px_4px_var(--glow-ai)] transition active:scale-95 disabled:opacity-40 disabled:shadow-none"
              >
                Send
              </button>
            </div>
          </div>
        )}

        {phase === 'parsing' && (
          <div className="flex flex-col items-center gap-3">
            <div className="glass-card p-6">
              <span className="text-3xl" aria-hidden>
                🤖
              </span>
            </div>
            <p className="text-body text-accent-ai motion-safe:animate-pulse">Understanding your meal…</p>
          </div>
        )}

        {phase === 'clarifying' && clarifyQuestion && (
          <div className="flex w-full max-w-xs flex-col gap-3">
            <div className="glass-card self-start p-3 text-body text-text-primary">{clarifyQuestion}</div>
            <div className="flex items-center gap-2">
              <input
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                placeholder="Your answer…"
                className="min-w-0 flex-1 rounded-full bg-bg-tertiary px-4 py-2.5 text-body text-text-primary outline-none ring-1 ring-white/5 focus:ring-accent-ai"
              />
              {speechSupported && (
                <button
                  onClick={quickVoiceReply}
                  aria-label="Answer by voice"
                  className="glass grid h-10 w-10 shrink-0 place-items-center rounded-full text-accent-ai"
                >
                  🎙️
                </button>
              )}
            </div>
            <button
              onClick={sendReply}
              disabled={!replyText.trim()}
              className="rounded-full bg-accent-ai px-4 py-2.5 text-caption font-semibold text-white shadow-[0_0_20px_4px_var(--glow-ai)] transition active:scale-95 disabled:opacity-40 disabled:shadow-none"
            >
              Send reply
            </button>
          </div>
        )}

        {phase === 'error' && (
          <div className="flex w-full max-w-xs flex-col gap-3 text-center">
            <div className="glass-card p-4 text-body text-accent-danger">{errorMessage}</div>
            <button
              onClick={() => runParse(conversation)}
              className="glass rounded-full px-4 py-2.5 text-caption text-text-secondary transition active:scale-95"
            >
              Try again
            </button>
            <button
              onClick={() => onResolved([])}
              className="rounded-full bg-accent-health px-4 py-2.5 text-caption font-semibold text-bg-primary shadow-[0_0_20px_4px_var(--glow-health)] transition active:scale-95"
            >
              Add manually instead
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
