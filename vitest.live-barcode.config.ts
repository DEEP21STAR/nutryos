import path from 'node:path'
import { defineConfig } from 'vitest/config'

// `npm run gate:live-barcode`: real network, Node environment.
export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  test: {
    environment: 'node',
    include: ['scripts/live-barcode.gate.ts'],
    testTimeout: 600_000,
    reporters: ['default'],
  },
})
