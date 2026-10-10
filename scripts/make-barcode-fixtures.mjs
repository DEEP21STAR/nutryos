#!/usr/bin/env node
// Generates the 10 barcode test photos in e2e/fixtures/barcodes/ plus expected.json.
// bwip-js renders the bars, ImageMagick (`magick`) puts them on a pack-coloured 800x600 "photo" and
// applies the blur / angle / low-contrast variants. Run: node scripts/make-barcode-fixtures.mjs
//
// The codes are REAL products that Open Food Facts listed (with calories) when this was written,
// taken from OFF's own search results, not invented. NZ products carry the GS1 94 prefix.
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import bwipjs from 'bwip-js'

const root = new URL('..', import.meta.url).pathname
const out = join(root, 'e2e/fixtures/barcodes')
mkdirSync(out, { recursive: true })

// [file, code, bcid, variant, product]
const SPECS = [
  ['01-marmite-nz.png', '9414942110252', 'ean13', 'clean', 'Marmite (Sanitarium NZ)'],
  ['02-whittakers-dark-ghana-nz.png', '9403142001231', 'ean13', 'clean', "Whittaker's Dark Ghana"],
  ['03-pics-peanut-butter-nz.png', '9421901881160', 'ean13', 'clean', "Pic's Peanut Butter Smooth"],
  ['04-watties-baked-beans-nz.png', '9400547002634', 'ean13', 'clean', "Wattie's Baked Beans"],
  ['05-griffins-snax-nz.png', '9400553436485', 'ean13', 'clean', "Griffin's Snax Original"],
  ['06-mainland-buttersoft-nz-blurred.png', '9415007002062', 'ean13', 'blurred', 'Mainland Buttersoft'],
  ['07-doritos-cheese-supreme-nz-angled.png', '9400566006354', 'ean13', 'angled', 'Doritos Cheese Supreme'],
  ['08-nutella-upca.png', '062020000248', 'upca', 'clean', 'Nutella (UPC-A)'],
  ['09-whittakers-dark-ghana-nz-lowcontrast.png', '9403142001231', 'ean13', 'low-contrast', "Whittaker's Dark Ghana"],
  ['10-marmite-nz-rotated90.png', '9414942110252', 'ean13', 'rotated-90', 'Marmite (Sanitarium NZ)'],
]

function magick(args) {
  const r = spawnSync('magick', args, { stdio: ['ignore', 'inherit', 'inherit'] })
  if (r.status !== 0) throw new Error(`magick ${args.join(' ')} failed`)
}

const expected = []
for (const [file, code, bcid, variant, product] of SPECS) {
  const bars = await bwipjs.toBuffer({
    bcid,
    text: code,
    scale: 5,
    height: 16,
    includetext: true,
    textxalign: 'center',
    paddingwidth: 16,
    paddingheight: 10,
    backgroundcolor: 'FFFFFF',
  })
  const barsPath = join(out, `.bars-${file}`)
  writeFileSync(barsPath, bars)
  const dest = join(out, file)
  const base = ['-size', '800x600', 'xc:#b9b2a4', '(', barsPath, ')', '-gravity', 'center', '-composite']
  const variantArgs = {
    clean: [],
    blurred: ['-blur', '0x2.4'],
    angled: ['-background', '#b9b2a4', '-virtual-pixel', 'background', '-distort', 'Perspective', '120,80 150,120  680,80 640,60  120,520 100,500  680,520 700,540', '-rotate', '9', '-gravity', 'center', '-crop', '800x600+0+0', '+repage'],
    'low-contrast': ['-level', '0,100%', '+level', '36%,64%'],
    'rotated-90': ['-rotate', '90', '-gravity', 'center', '-background', '#b9b2a4', '-extent', '800x600'],
  }[variant]
  magick([...base, ...variantArgs, dest])
  expected.push({ file, code, format: bcid === 'upca' ? 'UPC-A' : 'EAN-13', variant, nz: code.startsWith('94'), product })
}
for (const [file] of SPECS) spawnSync('rm', ['-f', join(out, `.bars-${file}`)])
writeFileSync(join(out, 'expected.json'), JSON.stringify(expected, null, 2) + '\n')
console.log(`wrote ${SPECS.length} images + expected.json to ${out}`)
