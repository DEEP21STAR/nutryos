import { test } from './fixtures'
import { FIXTURES, fixturePath, lookupCode, mockOff, noCamera, openBarcode } from './support/barcode'
import { expect } from '@playwright/test'

/** Screenshots for the Phase 3 design review: ~/PHOENIX/design_uplift/after/nutryos_p3_<engine>_*.png */
const OUT = `${process.env.HOME}/PHOENIX/design_uplift/after`

test('phase 3 screenshots at 390x844', async ({ app, context, browserName }) => {
  test.skip(!process.env.P3_SHOTS, 'set P3_SHOTS=1 to write screenshots')
  await app.setViewportSize({ width: 390, height: 844 })
  await noCamera(app)
  const f = FIXTURES[0]
  const code = lookupCode(f)
  await mockOff(context, { [code]: { name: 'Marmite Yeast Extract Spread', nutriments: { 'energy-kcal_100g': 560, proteins_100g: 17.4, fat_100g: 1, carbohydrates_100g: 16.8 } } })
  const { openToday } = await import('./fixtures')
  await openToday(app)
  await app.locator('[data-tour="orb"] button').click({ force: true })
  await expect(app.getByRole('button', { name: 'Scan barcode', exact: true })).toBeVisible()
  await app.screenshot({ path: `${OUT}/nutryos_p3_${browserName}_1_capture_sheet.png` })
  await app.getByRole('button', { name: 'Scan barcode', exact: true }).click()
  await expect(app.getByTestId('barcode-capture')).toBeVisible()
  await app.screenshot({ path: `${OUT}/nutryos_p3_${browserName}_2_scanning.png` })
  await app.getByTestId('barcode-photo-input').setInputFiles(fixturePath(f))
  await expect(app.getByRole('heading', { name: 'Confirm meal' })).toBeVisible({ timeout: 30_000 })
  await app.waitForTimeout(600)
  await app.screenshot({ path: `${OUT}/nutryos_p3_${browserName}_3_confirmlog.png` })
  await app.getByRole('button', { name: 'Cancel' }).first().click()
  await app.locator('[data-tour="orb"] button').click({ force: true })
  await app.getByRole('button', { name: 'Scan barcode', exact: true }).click()
  await app.getByPlaceholder('Barcode number').fill('9419372640584')
  await app.getByRole('button', { name: 'Look up' }).click()
  await expect(app.getByTestId('barcode-label-flow')).toBeVisible()
  await app.screenshot({ path: `${OUT}/nutryos_p3_${browserName}_4_unknown_label.png` })
})
