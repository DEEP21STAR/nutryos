#!/usr/bin/env node
// Builds src/data/curatedFoods.json (NUTRYOS Phase 1 curated table) from REAL sources only:
//   - FSANZ Australian Food Composition Database (AFCD) Release 3, "Nutrient profiles" workbook
//   - USDA FoodData Central SR Legacy (CSV bundle)
//   - Open Food Facts search (real User-Agent, <= 8 search requests per minute)
// No nutrition value is typed by hand: scripts/foods-spec.mjs only says WHICH record each food uses.
// Re-runnable: downloads and OFF responses are cached in scripts/.cache/ (delete it to refetch).
//
//   node scripts/build-foods.mjs            # build
//   node scripts/build-foods.mjs --offline  # fail instead of touching the network (cache only)

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateRawSync } from 'node:zlib'
import { FOODS } from './foods-spec.mjs'
import { pickMedianProduct } from '../src/lib/offMedian.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = join(ROOT, 'scripts', '.cache')
const OUT = join(ROOT, 'src', 'data', 'curatedFoods.json')
const OFFLINE = process.argv.includes('--offline')
const USER_AGENT = 'NUTRYOS-food-table-builder/1.0 (+https://deep21star.github.io/nutryos/)'

const AFCD_URL = 'https://www.foodstandards.gov.au/sites/default/files/2025-12/AFCD%20Release%203%20-%20Nutrient%20profiles.xlsx'
const AFCD_PAGE = 'https://www.foodstandards.gov.au/science-data/food-nutrient-databases/afcd'
const USDA_URL = 'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_csv_2018-04.zip'

mkdirSync(CACHE, { recursive: true })

// ── downloads ────────────────────────────────────────────────────────────────────────────────
async function download(url, file) {
  const path = join(CACHE, file)
  if (existsSync(path)) return readFileSync(path)
  if (OFFLINE) throw new Error(`--offline and ${file} is not cached`)
  console.error(`download ${url}`)
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  writeFileSync(path, buf)
  return buf
}

// ── minimal ZIP reader (central directory + raw inflate) ───────────────────────────────────────
function unzip(buf) {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a zip file')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const files = new Map()
  for (let n = 0; n < count; n++) {
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOff = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    files.set(name, () => {
      const lNameLen = buf.readUInt16LE(localOff + 26)
      const lExtraLen = buf.readUInt16LE(localOff + 28)
      const start = localOff + 30 + lNameLen + lExtraLen
      const data = buf.subarray(start, start + compSize)
      if (method === 0) return data
      if (method === 8) return inflateRawSync(data)
      throw new Error(`zip method ${method} unsupported (${name})`)
    })
    p += 46 + nameLen + extraLen + commentLen
  }
  return files
}

// ── AFCD (xlsx) ───────────────────────────────────────────────────────────────────────────────
function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&')
}

function colIndex(ref) {
  const letters = ref.match(/^[A-Z]+/)[0]
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

function readAfcd(buf) {
  const files = unzip(buf)
  const shared = [...files.get('xl/sharedStrings.xml')().toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    decodeXml([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')),
  )
  // The per-100 g profiles live on the largest worksheet.
  const sheetName = [...files.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort(
    (a, b) => files.get(b)().length - files.get(a)().length,
  )[0]
  const xml = files.get(sheetName)().toString('utf8')
  const rows = []
  for (const r of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = []
    for (const c of r[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[2]
      const inner = c[3] ?? ''
      const v = inner.match(/<v>([\s\S]*?)<\/v>/)
      let val = null
      if (/t="s"/.test(attrs) && v) val = shared[Number(v[1])]
      else if (/t="inlineStr"/.test(attrs)) val = decodeXml((inner.match(/<t[^>]*>([\s\S]*?)<\/t>/) ?? [])[1] ?? '')
      else if (v) val = decodeXml(v[1])
      row[colIndex(c[1])] = val
    }
    rows.push(row)
  }
  const headerIdx = rows.findIndex((r) => r.includes('Public Food Key'))
  if (headerIdx < 0) throw new Error('AFCD header row not found')
  const header = rows[headerIdx].map((h) => (h ?? '').replace(/\s+/g, ' ').trim())
  const col = (re) => {
    const i = header.findIndex((h) => re.test(h))
    if (i < 0) throw new Error(`AFCD column not found: ${re}`)
    return i
  }
  const C = {
    key: col(/^Public Food Key$/),
    name: col(/^Food Name$/),
    kj: col(/^Energy with dietary fibre, equated \(kJ\)$/),
    protein: col(/^Protein \(g\)$/),
    fat: col(/^Fat, total \(g\)$/),
    fibre: col(/^Total dietary fibre \(g\)$/),
    sugars: col(/^Total sugars \(g\)$/),
    carbs: col(/^Available carbohydrate, with sugar alcohols \(g\)$/),
  }
  const map = new Map()
  for (const r of rows.slice(headerIdx + 1)) {
    const key = r[C.key]
    if (!key || !/^F\d+$/.test(key)) continue
    const n = (i) => (r[i] === null || r[i] === undefined || r[i] === '' ? undefined : Number(r[i]))
    map.set(key, {
      name: String(r[C.name]).trim(),
      per100g: {
        kcal: n(C.kj) / 4.184,
        proteinG: n(C.protein) ?? 0,
        fatG: n(C.fat) ?? 0,
        carbsG: n(C.carbs) ?? 0,
        fiberG: n(C.fibre),
        sugarG: n(C.sugars),
      },
    })
  }
  return map
}

// ── USDA SR Legacy (csv) ──────────────────────────────────────────────────────────────────────
function parseCsvLine(line) {
  const out = []
  let cur = ''
  let q = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"'
        i++
      } else if (ch === '"') q = false
      else cur += ch
    } else if (ch === '"') q = true
    else if (ch === ',') {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out
}

function readUsda(buf, wantedIds) {
  const files = unzip(buf)
  const find = (suffix) => {
    const k = [...files.keys()].find((f) => f.endsWith(suffix))
    if (!k) throw new Error(`USDA bundle missing ${suffix}`)
    return files.get(k)().toString('utf8')
  }
  const names = new Map()
  for (const line of find('/food.csv').split('\n').slice(1)) {
    if (!line) continue
    const [id, , desc] = parseCsvLine(line)
    if (wantedIds.has(id)) names.set(id, desc)
  }
  const NUT = { 1008: 'kcal', 1003: 'proteinG', 1004: 'fatG', 1005: 'carbsG', 1079: 'fiberG', 2000: 'sugarG' }
  const per = new Map()
  for (const line of find('/food_nutrient.csv').split('\n').slice(1)) {
    if (!line) continue
    const f = parseCsvLine(line)
    if (!wantedIds.has(f[1])) continue
    const key = NUT[f[2]]
    if (!key) continue
    if (!per.has(f[1])) per.set(f[1], {})
    per.get(f[1])[key] = Number(f[3])
  }
  const map = new Map()
  for (const id of wantedIds) {
    const p = per.get(id)
    if (!names.has(id) || !p || p.kcal === undefined) throw new Error(`USDA fdc_id ${id} not found or has no energy`)
    map.set(id, { name: names.get(id), per100g: { kcal: p.kcal, proteinG: p.proteinG ?? 0, fatG: p.fatG ?? 0, carbsG: p.carbsG ?? 0, fiberG: p.fiberG, sugarG: p.sugarG } })
  }
  return map
}

// ── Open Food Facts (rate-limited search) ─────────────────────────────────────────────────────
const OFF_MIN_GAP_MS = 8000 // 7.5 requests/minute max, under the 8/min budget
let lastOffCall = 0

async function offSearch({ category, terms }) {
  const params = new URLSearchParams({ action: 'process', json: '1', page_size: '40', fields: 'code,product_name,product_name_en,nutriments,countries_tags' })
  if (terms) {
    params.set('search_terms', terms)
    params.set('search_simple', '1')
  }
  if (category) {
    params.set('tagtype_0', 'categories')
    params.set('tag_contains_0', 'contains')
    params.set('tag_0', category)
  }
  const url = `https://world.openfoodfacts.org/cgi/search.pl?${params}`
  const cacheFile = join(CACHE, `off-${createHash('sha1').update(url).digest('hex').slice(0, 16)}.json`)
  if (existsSync(cacheFile)) return { url, data: JSON.parse(readFileSync(cacheFile, 'utf8')) }
  if (OFFLINE) throw new Error(`--offline and OFF query not cached: ${url}`)
  for (let attempt = 0; attempt < 4; attempt++) {
    const wait = lastOffCall + OFF_MIN_GAP_MS - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    lastOffCall = Date.now()
    console.error(`OFF search ${category ?? ''} ${terms ?? ''}`)
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
    const text = await res.text()
    try {
      const data = JSON.parse(text)
      writeFileSync(cacheFile, JSON.stringify(data))
      return { url, data }
    } catch {
      console.error(`  OFF returned non-JSON (HTTP ${res.status}); backing off 60 s`)
      await new Promise((r) => setTimeout(r, 60000))
    }
  }
  throw new Error(`OFF search failed repeatedly: ${url}`)
}

// ── resolution ────────────────────────────────────────────────────────────────────────────────
const round1 = (n) => (n === undefined || Number.isNaN(n) ? undefined : Math.round(n * 10) / 10)
function roundPer(p) {
  const o = { kcal: round1(p.kcal), proteinG: round1(p.proteinG), fatG: round1(p.fatG), carbsG: round1(p.carbsG) }
  if (p.fiberG !== undefined && !Number.isNaN(p.fiberG)) o.fiberG = round1(p.fiberG)
  if (p.sugarG !== undefined && !Number.isNaN(p.sugarG)) o.sugarG = round1(p.sugarG)
  return o
}

function collectRefs(spec, set, prefix) {
  const visit = (s) => {
    if (typeof s === 'string' && s.startsWith(prefix)) set.add(s.slice(prefix.length))
    else if (s && s.recipe) s.recipe.forEach(([r]) => visit(r))
  }
  visit(spec.src)
  visit(spec.ref)
}

async function resolve(s, afcd, usda) {
  if (typeof s === 'string') {
    const [db, id] = s.split(':')
    if (db === 'afcd') {
      const rec = afcd.get(id)
      if (!rec) throw new Error(`AFCD key ${id} not found`)
      return { per100g: rec.per100g, source: { db: 'AFCD', id, name: rec.name, url: AFCD_PAGE } }
    }
    if (db === 'usda') {
      const rec = usda.get(id)
      return { per100g: rec.per100g, source: { db: 'USDA SR Legacy', id, name: rec.name, url: `https://fdc.nal.usda.gov/food-details/${id}/nutrients` } }
    }
    throw new Error(`unknown source ${s}`)
  }
  if (s.off) {
    const { url, data } = await offSearch(s.off)
    const pick = pickMedianProduct(data.products ?? [])
    if (!pick || pick.validCount < 3) throw new Error(`OFF ${JSON.stringify(s.off)}: fewer than 3 plausible products`)
    return {
      per100g: pick.per100g,
      source: {
        db: 'Open Food Facts (median)',
        id: pick.product.code,
        name: `${pick.product.product_name_en || pick.product.product_name} (median kcal of ${pick.validCount} plausible products)`,
        url: `https://world.openfoodfacts.org/product/${pick.product.code}`,
        query: url,
        sampleCodes: pick.validCodes.slice(0, 15),
      },
    }
  }
  if (s.recipe) {
    let total = 0
    const acc = { kcal: 0, proteinG: 0, fatG: 0, carbsG: 0, fiberG: 0, sugarG: 0 }
    const parts = []
    for (const [ref, grams] of s.recipe) {
      const r = await resolve(ref, afcd, usda)
      total += grams
      for (const k of Object.keys(acc)) acc[k] += ((r.per100g[k] ?? 0) * grams) / 100
      parts.push({ grams, ...r.source })
    }
    for (const k of Object.keys(acc)) acc[k] = (acc[k] / total) * 100
    return { per100g: acc, source: { db: 'Recipe of sourced records', id: parts.map((p) => `${p.id}x${p.grams}g`).join('+'), name: 'Weighted mix (component grams are a portion assumption)', url: parts[0].url, components: parts } }
  }
  throw new Error(`bad source spec ${JSON.stringify(s)}`)
}

async function main() {
  const ids = new Set(FOODS.map((f) => f.id))
  if (ids.size !== FOODS.length) throw new Error('duplicate food id in foods-spec.mjs')

  const afcd = readAfcd(await download(AFCD_URL, 'afcd-r3-nutrient-profiles.xlsx'))
  const usdaIds = new Set()
  FOODS.forEach((f) => collectRefs(f, usdaIds, 'usda:'))
  const usda = readUsda(await download(USDA_URL, 'usda-sr-legacy-csv.zip'), usdaIds)

  const foods = []
  for (const f of FOODS) {
    const src = await resolve(f.src, afcd, usda)
    const ref = f.ref ? await resolve(f.ref, afcd, usda) : null
    if (!(src.per100g.kcal >= 0)) throw new Error(`${f.id}: no energy value`)
    const isOff = !!(f.src && f.src.off)
    const isRecipe = !!(f.src && f.src.recipe)
    foods.push({
      id: f.id,
      name: f.name,
      category: f.cat,
      aliases: f.aliases,
      per100g: roundPer(src.per100g),
      serving: { grams: f.serve[0], label: f.serve[1], basis: 'portion assumption (not from the nutrient source)' },
      source: src.source,
      ...(ref ? { reference: { per100g: roundPer(ref.per100g), source: ref.source } } : {}),
      confidence: isOff || isRecipe ? 'medium' : 'high',
    })
  }

  const out = {
    generatedBy: 'scripts/build-foods.mjs',
    generatedAt: new Date().toISOString(),
    note: 'Every nutrition value below was read from the cited source at build time. Do not hand-edit; change scripts/foods-spec.mjs and rebuild.',
    sources: {
      AFCD: { title: 'Australian Food Composition Database - Release 3 (Nutrient profiles, per 100 g)', publisher: 'Food Standards Australia New Zealand', url: AFCD_PAGE, file: AFCD_URL, terms: 'FSANZ copyright notice applies; attribution: Food Standards Australia New Zealand (2025) Australian Food Composition Database - Release 3' },
      'USDA SR Legacy': { title: 'FoodData Central SR Legacy (April 2018)', publisher: 'U.S. Department of Agriculture, Agricultural Research Service', url: 'https://fdc.nal.usda.gov/', file: USDA_URL, terms: 'Public domain (CC0 1.0)' },
      'Open Food Facts (median)': { title: 'Open Food Facts', url: 'https://world.openfoodfacts.org/', terms: 'Database: Open Database License (ODbL)' },
    },
    foods,
  }
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, `${JSON.stringify(out, null, 1)}\n`)
  console.error(`wrote ${foods.length} foods -> ${OUT.replace(ROOT + '/', '')}`)
}

main().catch((e) => {
  console.error(`build-foods FAILED: ${e.message}`)
  process.exit(1)
})
