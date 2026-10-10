import { mkdirSync } from 'node:fs'
import { test, expect } from './fixtures'
import { typeAndSend } from './support/flows'
import type { Page } from '@playwright/test'

/**
 * Portion fix, against the production build, both engines: dragging the REAL slider (mouse down /
 * move / up on the range input) and typing grams rescale kcal + macros in proportion, and the meal
 * total follows. Banana comes from the curated table (120 g = 107 kcal), so the arithmetic is checked
 * against what the screen itself showed before the drag, not a hard-coded constant.
 */
const SHOTS = process.env.SHOTS_DIR
const engine = (name: string) => (name.startsWith('chromium') ? 'chromium' : 'firefox')

async function readItem(page: Page) {
  const kcal = Number(await page.getByLabel('Kcal', { exact: true }).first().inputValue())
  const protein = Number(await page.getByLabel('Protein', { exact: true }).first().inputValue())
  const carbs = Number(await page.getByLabel('Carbs', { exact: true }).first().inputValue())
  const grams = Number(await page.getByTestId('portion-input').first().inputValue())
  const totalText = (await page.getByText(/kcal · P/).first().textContent()) ?? ''
  const total = Number(/(\d+) kcal/.exec(totalText)?.[1])
  return { kcal, protein, carbs, grams, total }
}

async function dragSlider(page: Page, fraction: number) {
  const slider = page.getByRole('slider').first()
  await slider.scrollIntoViewIfNeeded()
  const box = (await slider.boundingBox())!
  const thumb = 12 // half of the 24px thumb
  const y = box.y + box.height / 2
  const from = await slider.evaluate((el) => Number((el as HTMLInputElement).value) / Number((el as HTMLInputElement).max))
  await page.mouse.move(box.x + thumb + (box.width - 2 * thumb) * from, y)
  await page.mouse.down()
  await page.mouse.move(box.x + thumb + (box.width - 2 * thumb) * ((from + fraction) / 2), y, { steps: 4 })
  await page.mouse.move(box.x + thumb + (box.width - 2 * thumb) * fraction, y, { steps: 4 })
  await page.mouse.up()
}

test('dragging the portion slider rescales kcal and macros and the meal total', async ({ app: page }, info) => {
  await typeAndSend(page, 'banana')
  const before = await readItem(page)
  expect(before.grams).toBe(120)
  expect(before.kcal).toBeGreaterThan(80)
  expect(before.total).toBe(before.kcal)

  await dragSlider(page, 0.75)
  const up = await readItem(page)
  expect(up.grams).toBeGreaterThan(400) // the thumb really moved
  expect(up.kcal).toBeGreaterThan(before.kcal * 3)
  expect(Math.abs(up.kcal - (before.kcal * up.grams) / before.grams)).toBeLessThanOrEqual(1)
  expect(Math.abs(up.carbs - (before.carbs * up.grams) / before.grams)).toBeLessThanOrEqual(0.2)
  expect(Math.abs(up.protein - (before.protein * up.grams) / before.grams)).toBeLessThanOrEqual(0.2)
  expect(up.total).toBe(up.kcal)

  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true })
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${SHOTS}/nutryos_p2_${engine(info.project.name)}_portion_dragged.png` })
  }

  await dragSlider(page, 0.1)
  const down = await readItem(page)
  expect(down.grams).toBeLessThan(120)
  expect(Math.abs(down.kcal - (before.kcal * down.grams) / before.grams)).toBeLessThanOrEqual(1)
  expect(down.total).toBe(down.kcal)
})

test('typing a portion rescales, and 120 g again restores the original numbers exactly', async ({ app: page }) => {
  await typeAndSend(page, 'banana')
  const before = await readItem(page)
  const input = page.getByTestId('portion-input').first()
  await input.fill('240')
  const doubled = await readItem(page)
  expect(doubled.kcal).toBe(Math.round(before.kcal * 2))
  expect(doubled.total).toBe(doubled.kcal)
  await input.fill('120')
  const back = await readItem(page)
  expect(back).toEqual(before)
})

test('a manual kcal edit survives and later portion changes scale from it', async ({ app: page }) => {
  await typeAndSend(page, 'banana')
  const kcal = page.getByLabel('Kcal', { exact: true }).first()
  await kcal.fill('200')
  await page.getByTestId('portion-input').first().fill('60')
  expect(Number(await kcal.inputValue())).toBe(100)
})
