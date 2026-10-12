import { readFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import type { Page, TestInfo } from '@playwright/test'
import { test, expect } from './fixtures'
import { setFakeMicClip } from './support/fakeMic'
import {
  FIXTURE,
  homeToSheet,
  installTapCounter,
  mockMealSave,
  mockPlateService,
  photoPath,
  photoResponse,
  photoToConfirm,
  pickPhoto,
  readTaps,
  scenarioResponse,
  snapshotRows,
  type RowSnap,
} from './support/capture'

/**
 * NUTRYOS Phase 4: the one capture sheet (photo + note + voice + keyboard), the multi-item split with
 * an added-fats line, Fix it in plain words, and the per-item portion steps.
 *
 * IMPORTANT: the photo path is exercised against SIMULATED edge-function responses
 * (e2e/fixtures/meals/responses.json, hand-written to the Phase 4 schema, not recorded from Gemini):
 * the Phase 4 function is not deployed, so the real model cannot be reached from here. These tests prove
 * the app (privacy gating, splitting into rows, merge, Fix it, steppers, saving), not model accuracy.
 * Set SHOTS_DIR to also write the 390x844 review screenshots (nutryos_p4_*.png).
 */

const SHOTS = process.env.SHOTS_DIR
if (SHOTS) mkdirSync(SHOTS, { recursive: true })
const engine = (info: TestInfo) => (info.project.name.startsWith('chromium') ? 'chromium' : 'firefox')
async function shot(page: Page, info: TestInfo, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/nutryos_p4_${name}_${engine(info)}.png` })
}

const OPT_IN_KEY = 'nutryos.cloudAiOptIn.v1'
async function optIn(page: Page) {
  await page.addInitScript((k: string) => localStorage.setItem(k, 'true'), OPT_IN_KEY)
}

const rows = (page: Page) => page.getByTestId('item-row')

async function totalKcal(page: Page): Promise<number> {
  const t = await page.locator('.glass.sticky.bottom-0').innerText()
  return Number(/(\d+)\s*kcal/.exec(t)![1])
}

/** Every visible button/input inside `scope` is at least 44 px in both directions and none overlap another. */
async function expectLayoutClean(page: Page, scopeSelector: string, opts: { minSize?: number } = {}) {
  const min = opts.minSize ?? 44
  const problems = await page.locator(scopeSelector).evaluateAll((scopes, minSize) => {
    const out: string[] = []
    for (const scope of scopes) {
      const els = Array.from(scope.querySelectorAll<HTMLElement>('button, input:not([type=file]):not([type=range]), textarea')).filter((e) => {
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'
      })
      const rects = els.map((e) => ({ e, r: e.getBoundingClientRect() }))
      for (const { e, r } of rects) {
        const label = (e.getAttribute('aria-label') || e.innerText || e.getAttribute('data-testid') || e.tagName).trim().slice(0, 30)
        // 1px tolerance for sub-pixel layout
        if (r.height < minSize - 1 || r.width < minSize - 1) out.push(`small target "${label}" ${Math.round(r.width)}x${Math.round(r.height)}`)
        if (r.right > window.innerWidth + 1 || r.left < -1) out.push(`off-screen "${label}"`)
      }
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i].r
          const b = rects[j].r
          const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left)
          const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
          if (ox > 1 && oy > 1) out.push(`overlap "${(rects[i].e.innerText || rects[i].e.getAttribute('aria-label') || '').slice(0, 20)}" x "${(rects[j].e.innerText || rects[j].e.getAttribute('aria-label') || '').slice(0, 20)}"`)
        }
      }
    }
    return out
  }, min)
  expect(problems, problems.join('\n')).toEqual([])
}

async function noHorizontalScroll(page: Page) {
  const w = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }))
  expect(w.sw).toBeLessThanOrEqual(w.iw)
}

test.describe('capture sheet', () => {
  test.beforeEach(async ({ app }) => {
    await app.setViewportSize({ width: 390, height: 844 })
  })

  test('shows camera, mic, keyboard and the earlier entries, inside 390x844, tap targets >= 44px, nothing overlapping', async ({ app }, info) => {
    await homeToSheet(app)
    for (const name of ['Allow once', 'Always', 'Stay private', 'Voice', 'Type it', 'Eating Out', 'Scan barcode', 'Cancel', 'Say a note']) {
      await expect(app.getByRole('button', { name, exact: true }), name).toBeVisible()
      await expect(app.getByRole('button', { name, exact: true }), name).toBeInViewport({ ratio: 1 })
    }
    await expect(app.getByTestId('capture-note')).toBeVisible()
    await expectLayoutClean(app, '[data-testid="capture-sheet"]')
    await noHorizontalScroll(app)
    await shot(app, info, 'capture_sheet')
  })

  test('once "Always" is chosen the sheet shows a single Photo button and the same layout rules hold', async ({ app }) => {
    await optIn(app)
    await homeToSheet(app)
    await expect(app.getByRole('button', { name: 'Photo', exact: true })).toBeVisible()
    await expect(app.getByRole('button', { name: 'Allow once', exact: true })).toHaveCount(0)
    await expectLayoutClean(app, '[data-testid="capture-sheet"]')
  })
})

test.describe('photo flow: taps and privacy', () => {
  test.beforeEach(async ({ app }) => {
    await app.setViewportSize({ width: 390, height: 844 })
  })

  test('single-item photo, Allow once: home -> saved log in 3 taps (counted)', async ({ app }) => {
    await installTapCounter(app)
    const service = await mockPlateService(app, photoResponse('07-single-banana.jpg'))
    const saved = await mockMealSave(app)
    await homeToSheet(app, { countTaps: true }) // tap 1: the orb
    await pickPhoto(app, 'Allow once', '07-single-banana.jpg') // tap 2: Allow once opens the camera/picker
    await expect(app.getByRole('heading', { name: 'Confirm meal' })).toBeVisible({ timeout: 30_000 })
    await expect(rows(app)).toHaveCount(1)
    await app.getByRole('button', { name: 'Log this meal' }).click() // tap 3
    await expect.poll(() => saved.length).toBe(1)
    const taps = await readTaps(app)
    expect(taps).toBe(3)
    const items = saved[0].items as Array<{ name: string; calories: number; source: string; estimatedGrams: number }>
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ name: 'Banana', source: 'curated', estimatedGrams: 118 })
    expect(items[0].calories).toBeGreaterThan(0)
    // privacy: one request, only food content
    expect(service.bodies).toHaveLength(1)
    expect(Object.keys(service.bodies[0]).sort()).toEqual(['imageBase64', 'mimeType', 'split'])
    expect(service.directGoogle).toEqual([])
    console.log(`TAPS single-item photo Allow once = ${taps}`)
  })

  test('after "Always": orb -> Photo -> Log is 3 taps and the consent sheet never appears again', async ({ app }) => {
    await installTapCounter(app)
    await optIn(app)
    await mockPlateService(app, photoResponse('07-single-banana.jpg'))
    const saved = await mockMealSave(app)
    await homeToSheet(app, { countTaps: true })
    await pickPhoto(app, 'Photo', '07-single-banana.jpg')
    await expect(app.getByRole('heading', { name: 'Confirm meal' })).toBeVisible({ timeout: 30_000 })
    await app.getByRole('button', { name: 'Log this meal' }).click()
    await expect.poll(() => saved.length).toBe(1)
    expect(await readTaps(app)).toBe(3)
  })

  test('Stay private: the photo is never sent, the flow ends in manual entry and a manual item saves', async ({ app }) => {
    await installTapCounter(app)
    const service = await mockPlateService(app, photoResponse('07-single-banana.jpg'))
    const saved = await mockMealSave(app)
    await homeToSheet(app, { countTaps: true })
    await pickPhoto(app, 'Stay private', '07-single-banana.jpg')
    await expect(app.getByRole('heading', { name: 'Confirm meal' })).toBeVisible({ timeout: 30_000 })
    await expect(app.getByTestId('identification-note')).toContainText('Photo scan is off because you chose to stay private')
    await expect(rows(app)).toHaveCount(0)
    await expect(app.getByRole('button', { name: 'Log this meal' })).toBeDisabled() // never a silent empty/0 log
    // manual path
    await app.getByRole('button', { name: '+ Add item manually' }).click()
    await app.getByPlaceholder('Food name').fill('banana')
    await app.locator('input[data-field="kcal"]').fill('105')
    await expect(app.getByRole('button', { name: 'Log this meal' })).toBeEnabled()
    await app.getByRole('button', { name: 'Log this meal' }).click()
    await expect.poll(() => saved.length).toBe(1)
    expect((saved[0].items as Array<{ calories: number }>)[0].calories).toBe(105)
    expect(service.bodies).toHaveLength(0)
    expect(service.directGoogle).toEqual([])
  })

  test('Stay private with a typed note: the private parser turns the note into items, still nothing sent', async ({ app }) => {
    const service = await mockPlateService(app, photoResponse('07-single-banana.jpg'))
    await homeToSheet(app)
    await app.getByTestId('capture-note').fill('two scrambled eggs and a banana')
    await pickPhoto(app, 'Stay private', '07-single-banana.jpg')
    await expect(app.getByRole('heading', { name: 'Confirm meal' })).toBeVisible({ timeout: 30_000 })
    await expect(rows(app)).toHaveCount(2)
    const snap = await snapshotRows(app)
    expect(snap.map((r) => r.name.toLowerCase())).toEqual(expect.arrayContaining([expect.stringContaining('egg'), expect.stringContaining('banana')]))
    for (const r of snap) expect(Number(r.kcal)).toBeGreaterThan(0)
    expect(service.bodies).toHaveLength(0)
  })

  test('a photo that reaches the app without a privacy choice (PWA shortcut) gets the consent sheet first', async ({ app }) => {
    const service = await mockPlateService(app, photoResponse('07-single-banana.jpg'))
    // Open the live camera directly via the shortcut deep link; no camera here, so use its upload fallback.
    await app.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('no camera in this test', 'NotFoundError'))
    })
    await app.goto('./?action=log-meal')
    await app.getByRole('button', { name: 'Skip' }).click()
    await expect(app.getByText('Camera permission was denied or no camera was found.')).toBeVisible({ timeout: 15_000 })
    const [chooser] = await Promise.all([app.waitForEvent('filechooser'), app.getByText('Photos & Files').click()])
    await chooser.setFiles(photoPath('07-single-banana.jpg'))
    await expect(app.getByRole('dialog', { name: 'Scan the photo with AI?' })).toBeVisible()
    expect(service.bodies).toHaveLength(0) // nothing sent before the choice
    await app.getByRole('button', { name: 'Stay private' }).click()
    await expect(app.getByRole('heading', { name: 'Confirm meal' })).toBeVisible()
    expect(service.bodies).toHaveLength(0)
    await expect(rows(app)).toHaveCount(0)
  })

  test('a photo with a typed note: the note is sent, and an old function that ignores it still gets the note applied here', async ({ app }, info) => {
    const service = await mockPlateService(app, photoResponse('07-single-banana.jpg')) // note_applied:false = the old function
    await homeToSheet(app)
    await app.getByTestId('capture-note').fill('double')
    await shot(app, info, 'photo_with_note_sheet')
    await pickPhoto(app, 'Allow once', '07-single-banana.jpg')
    await expect(app.getByRole('heading', { name: 'Confirm meal' })).toBeVisible({ timeout: 30_000 })
    expect(service.bodies[0].note).toBe('double')
    expect(Object.keys(service.bodies[0]).sort()).toEqual(['imageBase64', 'mimeType', 'note', 'split'])
    // identified 118 g, note "double" applied by the app -> 236 g
    const [r] = await snapshotRows(app)
    expect(r.grams).toBe('236')
    await expect(app.getByTestId('fixit-summary')).toContainText('118 g → 236 g')
    await shot(app, info, 'photo_with_note_result')
  })

  test('the simulated NEW function (note_applied:true) is not applied twice', async ({ app }) => {
    await mockPlateService(app, () => ({ items: [{ name: 'banana', estimated_grams: 236, kind: 'food' }], note_applied: true }))
    await homeToSheet(app)
    await app.getByTestId('capture-note').fill('double')
    await pickPhoto(app, 'Allow once', '07-single-banana.jpg')
    await expect(app.getByRole('heading', { name: 'Confirm meal' })).toBeVisible({ timeout: 30_000 })
    expect((await snapshotRows(app))[0].grams).toBe('236')
  })

  test('a photo the service cannot read ends in manual entry, with the reason', async ({ app }) => {
    await mockPlateService(app, () => ({ items: [], note_applied: false }))
    await homeToSheet(app)
    await pickPhoto(app, 'Allow once', '03-meatloaf-plate.jpg')
    await expect(app.getByRole('heading', { name: 'Confirm meal' })).toBeVisible({ timeout: 30_000 })
    await expect(rows(app)).toHaveCount(0)
    await expect(app.getByTestId('identification-note')).toContainText('did not see any food')
    await expect(app.getByRole('button', { name: 'Log this meal' })).toBeDisabled()
  })

  test('spoken note: the mic transcribes ON THIS DEVICE into the note box, and the note then rides with a private photo', async ({ app }) => {
    test.setTimeout(240_000)
    const service = await mockPlateService(app, photoResponse('07-single-banana.jpg'))
    app.on('console', (m) => { if (/dictation|asr/i.test(m.text())) console.log('PAGE', m.text()) })
    await homeToSheet(app)
    const seconds = await setFakeMicClip(app, 'e2e/fixtures/voice/s04.wav') // "A protein bar and an apple"; set AFTER the page load that homeToSheet does
    await app.getByRole('button', { name: 'Say a note' }).click()
    await expect(app.getByRole('button', { name: 'Stop note' })).toBeVisible()
    await app.waitForTimeout(seconds * 1000 + 1200)
    await app.getByRole('button', { name: 'Stop note' }).click()
    const note = app.getByTestId('capture-note')
    await expect.poll(async () => (await note.inputValue()).trim().length, { timeout: 180_000 }).toBeGreaterThan(0)
    const said = (await note.inputValue()).toLowerCase()
    console.log(`SPOKEN NOTE transcript: "${said}"`)
    expect(said).toMatch(/protein|apple/)
    await pickPhoto(app, 'Stay private', '07-single-banana.jpg')
    await expect(app.getByRole('heading', { name: 'Confirm meal' })).toBeVisible({ timeout: 30_000 })
    expect(await rows(app).count()).toBeGreaterThanOrEqual(1)
    expect(service.bodies).toHaveLength(0)
  })
})

test.describe('split result', () => {
  test.beforeEach(async ({ app }) => {
    await app.setViewportSize({ width: 390, height: 844 })
  })

  test('3 items + an added-fats line render as 4 separate editable rows, each with a source badge', async ({ app }, info) => {
    await mockPlateService(app, photoResponse('02-chicken-fried-rice-peas.jpg'))
    await homeToSheet(app)
    await photoToConfirm(app, '02-chicken-fried-rice-peas.jpg')
    await expect(rows(app)).toHaveCount(4)
    const snap = await snapshotRows(app)
    expect(snap.map((r) => r.name)).toEqual(['Chicken breast, baked', 'White rice, cooked', 'Peas, frozen, boiled', 'Olive oil'])
    for (const r of snap) {
      expect(r.badge).toMatch(/NZ\/AU food table/)
      expect(Number(r.kcal)).toBeGreaterThan(0)
    }
    await expect(app.locator('[data-role="added-fat"]')).toHaveCount(1)
    await expect(app.getByText('Added fats (oil, butter, dressing)')).toBeVisible()
    for (const n of await rows(app).count().then((c) => Array.from({ length: c }, (_, i) => i))) {
      await expect(rows(app).nth(n).locator('input[placeholder="Food name"]')).toBeEditable()
      await expect(rows(app).nth(n).getByTestId('source-badge')).toBeVisible()
    }
    // editable: type a new name in row 2 and the other rows stay put
    await rows(app).nth(1).locator('input[placeholder="Food name"]').fill('Jasmine rice')
    expect((await snapshotRows(app))[0]).toEqual(snap[0])
    await shot(app, info, 'split_4rows_top')
    await rows(app).nth(3).scrollIntoViewIfNeeded()
    await shot(app, info, 'split_4rows_bottom')
  })

  test('6 real CC0 meal photos upload and lay out cleanly (rows match the simulated split, no overflow, 44px targets)', async ({ app }, info) => {
    test.setTimeout(180_000)
    const files = Object.keys(FIXTURE.photos).filter((f) => f !== '07-single-banana.jpg')
    expect(files).toHaveLength(6)
    let current = files[0]
    await mockPlateService(app, () => FIXTURE.photos[current].response) // the response follows the file picked
    for (const f of files) {
      current = f
      await homeToSheet(app)
      await photoToConfirm(app, f)
      const expected = (FIXTURE.photos[f].response as { items: unknown[] }).items.length
      await expect(rows(app), f).toHaveCount(expected)
      await noHorizontalScroll(app)
      await expectLayoutClean(app, '[data-testid="fixit"]')
      await expectLayoutClean(app, '[data-testid="item-row"]')
      for (const r of await snapshotRows(app)) expect(r.badge, `${f} ${r.name}`).not.toBe('')
      await shot(app, info, `real_${f.slice(0, 2)}`)
      await app.reload()
    }
  })
})

// ---------------------------------------------------------------------------------------------
// Fix it
// ---------------------------------------------------------------------------------------------

type Scenario = 'shake' | 'bowl' | 'breakfast'
interface Fix {
  say: string
  scenario: Scenario
  /** Item the user picks with the "It's about" chip first (when the words name none). */
  pick?: string
  /** Row index that may change (or be removed). */
  index: number
  removes?: boolean
  expect?: (after: RowSnap[], before: RowSnap[]) => void
}

const FIXES: Fix[] = [
  { say: 'it was 2 scoops', scenario: 'shake', index: 0, expect: (a) => expect(a[0].grams).toBe('60') },
  { say: 'no milk', scenario: 'shake', index: 1, removes: true },
  { say: 'oat milk instead of milk', scenario: 'shake', index: 1, expect: (a) => { expect(a[1].name).toBe('Oat milk'); expect(a[1].grams).toBe('250'); expect(a[1].badge).toMatch(/NZ\/AU food table/) } },
  { say: 'just half the banana', scenario: 'shake', index: 2, expect: (a) => expect(a[2].grams).toBe('60') },
  { say: 'make the rice a cup', scenario: 'bowl', index: 0, expect: (a) => expect(a[0].grams).toBe('180') },
  { say: 'that was a large', scenario: 'bowl', pick: 'Chicken breast, grilled', index: 1, expect: (a) => expect(a[1].grams).toBe('225') },
  { say: 'chicken was 200g', scenario: 'bowl', index: 1, expect: (a) => expect(a[1].grams).toBe('200') },
  { say: 'double the broccoli', scenario: 'bowl', index: 2, expect: (a) => expect(a[2].grams).toBe('180') },
  { say: 'half', scenario: 'bowl', pick: 'White rice, cooked', index: 0, expect: (a) => expect(a[0].grams).toBe('125') },
  { say: 'no butter', scenario: 'breakfast', index: 3, removes: true },
]

async function toConfirm(app: Page, scenario: Scenario) {
  await mockPlateService(app, scenarioResponse(scenario))
  await homeToSheet(app)
  await pickPhoto(app, 'Allow once', '07-single-banana.jpg') // the photo is a stand-in; the scenario response is what the "service" says
  await expect(app.getByRole('heading', { name: 'Confirm meal' })).toBeVisible({ timeout: 30_000 })
}

test.describe('Fix it: scripted corrections change ONLY the targeted item', () => {
  test.beforeEach(async ({ app }) => {
    await app.setViewportSize({ width: 390, height: 844 })
  })

  for (const fx of FIXES) {
    test(`"${fx.say}" (${fx.scenario})`, async ({ app }) => {
      await toConfirm(app, fx.scenario)
      const before = await snapshotRows(app)
      expect(before).toHaveLength(4)
      await app.getByTestId('fixit-toggle').click()
      if (fx.pick) await app.getByRole('group', { name: 'Which item' }).getByRole('button', { name: fx.pick, exact: true }).click()
      await app.getByTestId('fixit-input').fill(fx.say)
      await app.getByTestId('fixit-submit').click()
      await expect(app.getByTestId('fixit-summary').locator('p').first()).toBeVisible()
      const after = await snapshotRows(app)
      expect(after).toHaveLength(fx.removes ? 3 : 4)
      // every OTHER row is byte-identical (name, grams, kcal, P, F, C, badge)
      const beforeOthers = before.filter((_, i) => i !== fx.index)
      const afterOthers = after.filter((_, i) => (fx.removes ? true : i !== fx.index))
      expect(JSON.stringify(afterOthers)).toBe(JSON.stringify(beforeOthers))
      if (!fx.removes) expect(JSON.stringify(after[fx.index])).not.toBe(JSON.stringify(before[fx.index]))
      fx.expect?.(after, before)
      for (const r of after) expect(Number(r.kcal)).toBeGreaterThan(0)
    })
  }

  test('two corrections in one sentence: "it was 2 scoops, no milk" changes whey, drops milk, leaves banana and fats', async ({ app }) => {
    await toConfirm(app, 'shake')
    const before = await snapshotRows(app)
    await app.getByTestId('fixit-toggle').click()
    await app.getByTestId('fixit-input').fill('it was 2 scoops, no milk')
    await app.getByTestId('fixit-submit').click()
    await expect.poll(async () => (await snapshotRows(app)).length).toBe(3)
    const after = await snapshotRows(app)
    expect(after[0].grams).toBe('60')
    expect(JSON.stringify([after[1], after[2]])).toBe(JSON.stringify([before[2], before[3]]))
  })

  test('words that name no item among several: it asks which one, changes nothing, then applies to the answer only', async ({ app }) => {
    await toConfirm(app, 'bowl')
    const before = await snapshotRows(app)
    await app.getByTestId('fixit-toggle').click()
    await app.getByTestId('fixit-input').fill('make it bigger')
    await app.getByTestId('fixit-submit').click()
    await expect(app.getByTestId('fixit-ask')).toBeVisible()
    expect(JSON.stringify(await snapshotRows(app))).toBe(JSON.stringify(before))
    await app.getByTestId('fixit-ask').getByRole('button', { name: 'Broccoli, boiled' }).click()
    await expect.poll(async () => (await snapshotRows(app))[2].grams).toBe('112.5')
    const after = await snapshotRows(app)
    expect(JSON.stringify([after[0], after[1], after[3]])).toBe(JSON.stringify([before[0], before[1], before[3]]))
  })

  test('a name that is not on the plate removes nothing and says so', async ({ app }) => {
    await toConfirm(app, 'bowl')
    const before = await snapshotRows(app)
    await app.getByTestId('fixit-toggle').click()
    await app.getByTestId('fixit-input').fill('no sauce')
    await app.getByTestId('fixit-submit').click()
    await expect(app.getByTestId('fixit-summary')).toContainText("couldn't find \"sauce\"")
    expect(JSON.stringify(await snapshotRows(app))).toBe(JSON.stringify(before))
  })

  test('a swap the food table cannot price ends as "Needs numbers" and blocks logging, never a silent 0', async ({ app }) => {
    await toConfirm(app, 'shake')
    await app.getByTestId('fixit-toggle').click()
    await app.getByTestId('fixit-input').fill('zorbleflax instead of banana')
    await app.getByTestId('fixit-submit').click()
    await expect(rows(app).nth(2).getByTestId('needs-numbers')).toBeVisible()
    await expect(app.getByRole('button', { name: 'Log this meal' })).toBeDisabled()
  })

  test('Undo puts every item back exactly', async ({ app }) => {
    await toConfirm(app, 'shake')
    const before = await snapshotRows(app)
    await app.getByTestId('fixit-toggle').click()
    await app.getByTestId('fixit-input').fill('no milk')
    await app.getByTestId('fixit-submit').click()
    await expect.poll(async () => (await snapshotRows(app)).length).toBe(3)
    await app.getByTestId('fixit-undo').click()
    expect(JSON.stringify(await snapshotRows(app))).toBe(JSON.stringify(before))
  })

  test('hard wording: not read on the phone, the cloud helper is offered, and nothing is sent until Allow once', async ({ app }) => {
    const service = await mockPlateService(app, scenarioResponse('shake'), { fix: 'fixture' })
    await homeToSheet(app)
    await pickPhoto(app, 'Allow once', '07-single-banana.jpg')
    await expect(app.getByRole('heading', { name: 'Confirm meal' })).toBeVisible({ timeout: 30_000 })
    const before = await snapshotRows(app)
    await app.getByTestId('fixit-toggle').click()
    await app.getByTestId('fixit-input').fill(FIXTURE.fixCloud.request)
    await app.getByTestId('fixit-submit').click()
    await expect(app.getByTestId('fixit-unhandled')).toBeVisible()
    expect(JSON.stringify(await snapshotRows(app))).toBe(JSON.stringify(before)) // nothing guessed
    expect(service.bodies.filter((b) => b.fix)).toHaveLength(0)
    await app.getByTestId('fixit-ask-ai').click()
    await expect(app.getByRole('dialog', { name: 'Ask the AI to fix this?' })).toBeVisible()
    expect(service.bodies.filter((b) => b.fix)).toHaveLength(0) // still nothing sent
    await app.getByRole('button', { name: 'Allow once' }).click()
    await expect.poll(async () => (await snapshotRows(app)).length).toBe(5)
    const after = await snapshotRows(app)
    expect(JSON.stringify(after.slice(0, 4))).toBe(JSON.stringify(before)) // existing rows untouched, one resolved row added
    expect(after[4].name).toMatch(/long black/i)
    const fixBody = service.bodies.find((b) => b.fix) as { fix: { text: string; items: Array<{ name: string; grams: number }> } }
    expect(Object.keys(fixBody)).toEqual(['fix'])
    expect(Object.keys(fixBody.fix).sort()).toEqual(['items', 'text'])
    expect(fixBody.fix.items.every((i) => Object.keys(i).sort().join() === 'grams,name')).toBe(true)
  })

  test('hard wording with Stay private: nothing is sent and nothing changes', async ({ app }) => {
    const service = await mockPlateService(app, scenarioResponse('shake'), { fix: 'fixture' })
    await homeToSheet(app)
    await pickPhoto(app, 'Allow once', '07-single-banana.jpg')
    await expect(app.getByRole('heading', { name: 'Confirm meal' })).toBeVisible({ timeout: 30_000 })
    const before = await snapshotRows(app)
    await app.getByTestId('fixit-toggle').click()
    await app.getByTestId('fixit-input').fill(FIXTURE.fixCloud.request)
    await app.getByTestId('fixit-submit').click()
    await app.getByTestId('fixit-ask-ai').click()
    await app.getByRole('button', { name: 'Stay private' }).click()
    await expect(app.getByText('Nothing was sent.')).toBeVisible()
    expect(service.bodies.filter((b) => b.fix)).toHaveLength(0)
    expect(JSON.stringify(await snapshotRows(app))).toBe(JSON.stringify(before))
  })

  test('hard wording against the OLD deployed function (no fix mode): says so, changes nothing', async ({ app }) => {
    await mockPlateService(app, scenarioResponse('shake'), { fix: 'old-function' })
    await homeToSheet(app)
    await pickPhoto(app, 'Allow once', '07-single-banana.jpg')
    await expect(app.getByRole('heading', { name: 'Confirm meal' })).toBeVisible({ timeout: 30_000 })
    const before = await snapshotRows(app)
    await app.getByTestId('fixit-toggle').click()
    await app.getByTestId('fixit-input').fill(FIXTURE.fixCloud.request)
    await app.getByTestId('fixit-submit').click()
    await app.getByTestId('fixit-ask-ai').click()
    await app.getByRole('button', { name: 'Allow once' }).click()
    await expect(app.getByText("The AI helper isn't available right now")).toBeVisible()
    expect(JSON.stringify(await snapshotRows(app))).toBe(JSON.stringify(before))
  })

  test('Fix it box layout at 390x844: opened, nothing overlaps, every target >= 44px', async ({ app }, info) => {
    await toConfirm(app, 'shake')
    await app.getByTestId('fixit-toggle').click()
    await app.getByRole('group', { name: 'Which item' }).getByRole('button').first().click()
    await app.getByTestId('fixit-input').fill('half')
    await app.getByTestId('fixit-toggle').scrollIntoViewIfNeeded()
    await expectLayoutClean(app, '[data-testid="fixit"]')
    await noHorizontalScroll(app)
    await shot(app, info, 'fixit_open')
    await app.getByTestId('fixit-submit').click()
    await expect(app.getByTestId('fixit-summary').locator('p').first()).toBeVisible()
    await shot(app, info, 'after_fix')
  })
})

// ---------------------------------------------------------------------------------------------
// Portion steps and the 1-tap chips
// ---------------------------------------------------------------------------------------------

test.describe('portion steps and quick chips', () => {
  test.beforeEach(async ({ app }) => {
    await app.setViewportSize({ width: 390, height: 844 })
  })

  test('per-item steps (½× 1× 1.5× 2× 3×) rescale only that item and the total follows', async ({ app }) => {
    await toConfirm(app, 'bowl')
    const before = await snapshotRows(app)
    const total0 = await totalKcal(app)
    expect(total0).toBe(before.reduce((s, r) => s + Number(r.kcal), 0))
    const rice = rows(app).nth(0)
    for (const [label, mult] of [['2×', 2], ['3×', 3], ['½×', 0.5], ['1.5×', 1.5], ['1×', 1]] as const) {
      await rice.getByTestId(`step-${label}`).click()
      await expect(rice.getByTestId(`step-${label}`)).toHaveAttribute('aria-pressed', 'true')
      const now = await snapshotRows(app)
      expect(Number(now[0].grams)).toBeCloseTo(250 * mult, 1)
      expect(Number(now[0].kcal)).toBeGreaterThanOrEqual(Math.round(Number(before[0].kcal) * mult) - 1)
      expect(Number(now[0].kcal)).toBeLessThanOrEqual(Math.round(Number(before[0].kcal) * mult) + 1)
      expect(JSON.stringify(now.slice(1))).toBe(JSON.stringify(before.slice(1)))
      expect(await totalKcal(app)).toBe(now.reduce((s, r) => s + Number(r.kcal), 0))
    }
    // back at 1x: exactly the original numbers, no drift
    expect(JSON.stringify(await snapshotRows(app))).toBe(JSON.stringify(before))
  })

  test('typed grams still work next to the steps and re-base cleanly', async ({ app }) => {
    await toConfirm(app, 'bowl')
    const chicken = rows(app).nth(1)
    await chicken.getByTestId('portion-input').fill('300')
    const now = await snapshotRows(app)
    expect(now[1].grams).toBe('300')
    expect(Number(now[1].kcal)).toBe(Math.round(Number((await snapshotRows(app))[1].kcal)))
    await chicken.getByTestId('step-2×').click()
    expect((await snapshotRows(app))[1].grams).toBe('300') // 2 x 150 (the portion first shown) = 300
  })

  test('a single-item result: the quick chips are one tap (Double)', async ({ app }) => {
    await installTapCounter(app)
    await mockPlateService(app, photoResponse('07-single-banana.jpg'))
    await homeToSheet(app)
    await photoToConfirm(app, '07-single-banana.jpg')
    await expect(app.getByTestId('fixit-input')).toBeVisible() // Fix it starts open when there is one item
    const before = (await snapshotRows(app))[0]
    await app.evaluate(() => { (window as unknown as { __taps: number }).__taps = 0 })
    await app.getByTestId('fixit-chip-double').click()
    expect(await readTaps(app)).toBe(1)
    const after = (await snapshotRows(app))[0]
    expect(after.grams).toBe(String(Number(before.grams) * 2))
    expect(Number(after.kcal)).toBe(Number(before.kcal) * 2 || Number(after.kcal))
  })

  test('with several items a chip with no item picked asks which one (nothing changes); picked = 2 taps total', async ({ app }) => {
    await toConfirm(app, 'bowl')
    const before = await snapshotRows(app)
    await app.getByTestId('fixit-toggle').click()
    await app.getByTestId('fixit-chip-half').click()
    await expect(app.getByTestId('fixit-ask')).toBeVisible()
    expect(JSON.stringify(await snapshotRows(app))).toBe(JSON.stringify(before))
    await app.getByTestId('fixit-ask').getByRole('button', { name: 'Chicken breast, grilled' }).click()
    await expect.poll(async () => (await snapshotRows(app))[1].grams).toBe('75')
    const after = await snapshotRows(app)
    expect(JSON.stringify([after[0], after[2], after[3]])).toBe(JSON.stringify([before[0], before[2], before[3]]))
  })

  test('the "+ Added fats" line appears on a photo result with none and adds one resolved, editable row', async ({ app }) => {
    await mockPlateService(app, photoResponse('03-meatloaf-plate.jpg')) // meatloaf: a split without an added-fat line
    await homeToSheet(app)
    await photoToConfirm(app, '03-meatloaf-plate.jpg')
    await app.getByTestId('add-fats').click()
    await expect(app.locator('[data-role="added-fat"]')).toHaveCount(1)
    const snap = await snapshotRows(app)
    expect(snap[1].name).toBe('Olive oil')
    expect(snap[1].grams).toBe('5')
    expect(Number(snap[1].kcal)).toBeGreaterThan(0)
    await app.locator('[data-role="added-fat"]').getByTestId('step-3×').click()
    expect((await snapshotRows(app))[1].grams).toBe('15')
  })
})

test('Phase 4 files carry no client-side AI key and the recorded fixtures are labelled simulated', async () => {
  const label = (JSON.parse(readFileSync('e2e/fixtures/meals/responses.json', 'utf8')) as { _LABEL: string })._LABEL
  expect(label).toMatch(/^SIMULATED/)
  for (const f of ['src/lib/photoAnalysis.ts', 'src/lib/fixIt.ts', 'src/components/CaptureSheet.tsx', 'src/components/FixItBox.tsx', 'src/App.tsx']) {
    const text = readFileSync(f, 'utf8')
    expect(text, f).not.toMatch(/generativelanguage\.googleapis\.com|AIza[0-9A-Za-z_-]{35}/)
  }
})
