import path from 'node:path'
import { defineConfig } from 'vitest/config'

// `npm run gate:live-foods`: real network, Node environment (no jsdom, no localStorage), long timeout
// because OFF searches are held to <= 8 per minute.
export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  test: {
    environment: 'node',
    include: ['scripts/live-foods.gate.ts'],
    testTimeout: 600_000,
    reporters: ['default'],
  },
})
