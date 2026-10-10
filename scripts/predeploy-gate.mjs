#!/usr/bin/env node
// Pre-deploy gate. Runs: tsc -b, vitest, build, e2e smoke/layout/splash (chromium-mobile + firefox),
// secret-pattern scan of src/ and dist/. No third-party network calls (e2e blocks non-local origins).
// Live tests (real edge function) are separate: `npm run gate:live`.
// Prints exactly one final line: `GATE PASS` or `GATE FAIL: <reason>`.
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const steps = [
  ['typecheck (tsc -b)', 'npx', ['tsc', '-b']],
  ['unit tests (vitest)', 'npx', ['vitest', 'run']],
  ['build', 'npm', ['run', 'build']],
  ['e2e (chromium-mobile + firefox)', 'npx', ['playwright', 'test', '--project=chromium-mobile', '--project=firefox']],
]

function fail(reason) {
  console.log(`GATE FAIL: ${reason}`)
  process.exit(1)
}

for (const [name, cmd, args] of steps) {
  console.error(`\n=== ${name} ===`)
  const r = spawnSync(cmd, args, { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] })
  if (r.status !== 0) fail(`${name} exited ${r.status}`)
}

// Secret scan. The Supabase publishable key (sb_publishable_) is public by design and allowed.
const PATTERNS = [
  ['Supabase secret key', /sb_secret_[A-Za-z0-9_-]{10,}/],
  ['Google API key', /AIza[0-9A-Za-z_-]{35}/],
  ['OpenAI/Anthropic-style key', /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['Private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['Groq key', /\bgsk_[A-Za-z0-9]{30,}/],
]
const TEXT_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.css', '.html', '.json', '.svg', '.webmanifest', '.map', '.txt'])

function* walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    const s = statSync(p)
    if (s.isDirectory()) yield* walk(p)
    else if (TEXT_EXT.has(extname(p))) yield p
  }
}

// service_role JWTs: any eyJ... token whose payload decodes to role=service_role.
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.(eyJ[A-Za-z0-9_-]{8,})\.[A-Za-z0-9_-]{8,}/g
console.error('\n=== secret scan (src/, dist/) ===')
const hits = []
for (const dir of ['src', 'dist']) {
  for (const f of walk(join(root, dir))) {
    const text = readFileSync(f, 'utf8')
    for (const [label, re] of PATTERNS) if (re.test(text)) hits.push(`${label} in ${f.replace(root, '')}`)
    for (const m of text.matchAll(JWT)) {
      try {
        if (JSON.parse(Buffer.from(m[1], 'base64url').toString()).role === 'service_role') hits.push(`service_role JWT in ${f.replace(root, '')}`)
      } catch {
        /* not a JWT */
      }
    }
  }
}
if (hits.length) fail(`secret pattern match: ${[...new Set(hits)].join('; ')}`)

console.log('GATE PASS')
