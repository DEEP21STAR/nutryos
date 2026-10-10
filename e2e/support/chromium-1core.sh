#!/bin/sh
# Runs Chromium pinned to one CPU core (core 3). With busy-loop burners on the same core
# (e2e/voiceSlowCpu.spec.ts) every browser thread, including Web Workers, gets a fraction of that core.
# CDP's CPU throttle does NOT slow dedicated workers (measured), so this is how a slow phone is approximated.
exec taskset -c 3 "$CHROME_REAL" "$@"
