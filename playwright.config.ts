import { defineConfig, devices } from '@playwright/test'
import { ensureFakeMicWav } from './e2e/support/wav'

// Generated test tone used as the fake microphone (see e2e/support/fakeMic.ts). Written at config
// load so Chromium can be pointed at it with --use-file-for-fake-audio-capture.
const FAKE_MIC_WAV = ensureFakeMicWav()

const PORT = 4173
const BASE = `http://127.0.0.1:${PORT}/nutryos/`

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 2,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: BASE,
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
  },
  // Serves the production build (dist/). `npm run e2e` and `npm run gate` build first.
  webServer: {
    command: `npx vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: BASE,
    reuseExistingServer: true,
    timeout: 60_000,
  },
  projects: [
    {
      name: 'chromium-mobile',
      testIgnore: /live\.spec\.ts/,
      use: {
        ...devices['Pixel 7'],
        launchOptions: {
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            `--use-file-for-fake-audio-capture=${FAKE_MIC_WAV}`,
          ],
        },
      },
    },
    {
      // isMobile is unsupported in Firefox: viewport + touch are set by hand.
      name: 'firefox',
      testIgnore: /live\.spec\.ts/,
      use: {
        ...devices['Desktop Firefox'],
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        deviceScaleFactor: 2,
      },
    },
    // Live tests: real network, run only via `npm run gate:live` (--project=live).
    { name: 'live', testMatch: /live\.spec\.ts/, use: { ...devices['Desktop Chrome'] } },
  ],
})
