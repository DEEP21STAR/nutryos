import { useCallback, useEffect, useRef, useState } from 'react'

export type DictationState = 'idle' | 'recording' | 'transcribing'

const MAX_MS = 25_000

/**
 * Short spoken note for the capture sheet ("no milk, two scoops"). Records with MediaRecorder and
 * transcribes ON THIS DEVICE with the same self-hosted speech model as voice logging (asrClient), so
 * speaking a note sends nothing anywhere. The speech model is imported lazily: nothing is downloaded or
 * started until the user first taps the mic. Never throws to the caller: a failure just reports `error`
 * and the typed box stays usable.
 */
export function useDictation(onText: (text: string) => void) {
  const [state, setState] = useState<DictationState>('idle')
  const [error, setError] = useState<string | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const aliveRef = useRef(true)
  const onTextRef = useRef(onText)
  onTextRef.current = onText

  const release = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }, [])

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      release()
      const r = recorderRef.current
      if (r && r.state !== 'inactive') {
        r.onstop = null
        r.stop()
      }
    }
  }, [release])

  const stop = useCallback(() => {
    const r = recorderRef.current
    if (r && r.state !== 'inactive') r.stop()
  }, [])

  const start = useCallback(async () => {
    setError(null)
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('This browser cannot record. Type the note instead.')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (!aliveRef.current) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      streamRef.current = stream
      const type = ['audio/webm', 'audio/mp4', 'audio/ogg'].find((t) => (typeof MediaRecorder.isTypeSupported === 'function' ? MediaRecorder.isTypeSupported(t) : false))
      const recorder = type ? new MediaRecorder(stream, { mimeType: type }) : new MediaRecorder(stream)
      chunksRef.current = []
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      recorder.onstop = async () => {
        release()
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
        if (!aliveRef.current) return
        if (blob.size === 0) {
          console.warn('dictation: empty recording')
          setState('idle')
          setError("Didn't catch that. Try again or type it.")
          return
        }
        setState('transcribing')
        try {
          const { transcribeBlob } = await import('@/lib/asr/asrClient')
          const r = await transcribeBlob(blob)
          if (!aliveRef.current) return
          if (!r.assessment.ok) console.warn('dictation assessment', r.assessment.reason, JSON.stringify(r.text), r.seconds)
          if (r.text.trim()) onTextRef.current(r.text.trim())
          else setError("Didn't catch that. Try again or type it.")
        } catch {
          if (aliveRef.current) setError("Couldn't turn that into text on this device. Type it instead.")
        }
        if (aliveRef.current) setState('idle')
      }
      recorder.start()
      recorderRef.current = recorder
      setState('recording')
      timerRef.current = setTimeout(stop, MAX_MS)
    } catch (e) {
      release()
      setState('idle')
      setError(e instanceof DOMException && e.name === 'NotAllowedError' ? 'Microphone is blocked. Type the note instead.' : 'No microphone found. Type the note instead.')
    }
  }, [release, stop])

  return { state, error, start, stop }
}
