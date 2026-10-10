#!/usr/bin/env python3
"""Regenerates e2e/fixtures/voice/*.wav from sentences.json with Piper (local, offline TTS).
Run with the Piper-enabled venv:  ~/.local/share/read-along/venv/bin/python3 scripts/make-voice-fixtures.py
Output: 16 kHz mono 16-bit WAV (what a phone mic pipeline hands the recogniser). Synthetic speech: it is
cleaner than a real voice, so WER measured on it is optimistic."""
import json, subprocess, sys, wave, os
from pathlib import Path
from piper import PiperVoice

root = Path(__file__).resolve().parent.parent
out = root / "e2e/fixtures/voice"
voices = Path.home() / ".local/share/piper-voices"
fallback = Path.home() / ".local/share/wake-dictation"
cache = {}
for s in json.loads((out / "sentences.json").read_text()):
    name = s["voice"]
    p = voices / f"{name}.onnx"
    if not p.exists():
        p = fallback / f"{name}.onnx"
    voice = cache.setdefault(name, PiperVoice.load(str(p)))
    raw = out / f"{s['id']}.raw.wav"
    with wave.open(str(raw), "wb") as w:
        voice.synthesize_wav(s["text"], w)
    dst = out / f"{s['id']}.wav"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(raw), "-ar", "16000", "-ac", "1", "-af", "adelay=300|300,apad=pad_dur=0.4", str(dst)], check=True)
    raw.unlink()
    print(s["id"], name, os.path.getsize(dst))
