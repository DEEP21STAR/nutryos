import { test, expect } from './fixtures'
import { FIXTURES, fixturePath, lookupCode, mockOff, noCamera, okProduct, openBarcode, stubNativeDetector } from './support/barcode'

/**
 * Phase 3: barcode everywhere. Decode accuracy over the 10 generated photos (file-input path, both
 * engines' projects), the visible scan button, typed digits, unknown barcode -> label/manual (never
 * a silent 0), native-empty -> ponyfill fallback, and "no third-party fetch, WASM is self-hosted".
 * Open Food Facts and the edge function are mocked here; the real OFF is exercised by the live check.
 */

test.describe('scan button on the capture sheet', () => {
  test('visible and inside the 390x844 viewport', async ({ app }) => {
    await noCamera(app)
    await app.setViewportSize({ width: 390, height: 844 })
    const { openToday } = await import('./fixtures')
    await openToday(app)
    await app.locator('[data-tour="orb"] button').click({ force: true })
    const btn = app.getByRole('button', { name: 'Scan barcode', exact: true })
    await expect(btn).toBeVisible()
    await expect(btn).toBeInViewport({ ratio: 1 })
    expect(app.viewportSize()).toEqual({ width: 390, height: 844 })
  })
})

test.describe('file-input decode, 10 sample photos', () => {
  for (const f of FIXTURES) {
    test(`${f.file} (${f.format}, ${f.variant})`, async ({ app, context }) => {
      await noCamera(app)
      const code = lookupCode(f)
      const off = await mockOff(context, { [code]: okProduct(code) })
      await openBarcode(app)
      await app.getByTestId('barcode-photo-input').setInputFiles(fixturePath(f))
      // The decoded code reaches Open Food Facts and the confirm screen shows that exact product.
      await expect(app.getByRole('heading', { name: 'Confirm meal' })).toBeVisible({ timeout: 30_000 })
      expect(off.requested).toEqual([code])
      await expect(app.locator(`input[value="Product ${code}"]`)).toBeVisible()
    })
  }
})

test.describe('typed digits', () => {
  test('a valid number looks up and lands in Confirm meal', async ({ app, context }) => {
    await noCamera(app)
    const code = '9414942110252'
    const off = await mockOff(context, { [code]: okProduct(code) })
    await openBarcode(app)
    await app.getByPlaceholder('Barcode number').fill('94 14942 110252')
    await app.getByRole('button', { name: 'Look up' }).click()
    await expect(app.getByRole('heading', { name: 'Confirm meal' })).toBeVisible()
    expect(off.requested).toEqual([code])
  })

  test('a wrong check digit is rejected locally and sends nothing', async ({ app, context }) => {
    await noCamera(app)
    const off = await mockOff(context, {})
    await openBarcode(app)
    await app.getByPlaceholder('Barcode number').fill('9414942110253')
    await app.getByRole('button', { name: 'Look up' }).click()
    await expect(app.getByTestId('barcode-status')).toContainText('last digit')
    expect(off.requested).toEqual([])
  })
})

test.describe('unknown barcode never logs 0', () => {
  const UNKNOWN = '9419372640584' // made-up, valid checksum (computed), not in the mock

  test('unknown -> label prompt + manual numbers; empty/zero calories refused; real numbers save to My Foods; re-scan is instant', async ({ app, context }) => {
    await noCamera(app)
    const off = await mockOff(context, {})
    await openBarcode(app)
    await app.getByPlaceholder('Barcode number').fill(UNKNOWN)
    await app.getByRole('button', { name: 'Look up' }).click()

    const flow = app.getByTestId('barcode-label-flow')
    await expect(flow).toBeVisible()
    await expect(flow.getByText('Snap the nutrition label').first()).toBeVisible()
    await expect(flow.getByText('Enter numbers yourself')).toBeVisible()
    await expect(app.getByRole('heading', { name: 'Confirm meal' })).toHaveCount(0)

    // Silent zero refused: empty and "0" calories both blocked.
    await app.getByPlaceholder('e.g. Whey protein').fill('Test bar')
    await app.getByRole('button', { name: 'Use these numbers' }).click()
    await expect(app.getByTestId('label-form-error')).toContainText('calories')
    await app.getByLabel('Calories (kcal)').fill('0')
    await app.getByRole('button', { name: 'Use these numbers' }).click()
    await expect(app.getByTestId('label-form-error')).toBeVisible()
    await expect(app.getByRole('heading', { name: 'Confirm meal' })).toHaveCount(0)

    // Real numbers -> confirm screen with those numbers.
    await app.getByLabel('Calories (kcal)').fill('412')
    await app.getByLabel('Protein (g)').fill('20')
    await app.getByLabel('Fat (g)').fill('18')
    await app.getByLabel('Carbs (g)').fill('45')
    await app.getByRole('button', { name: 'Use these numbers' }).click()
    await expect(app.getByRole('heading', { name: 'Confirm meal' })).toBeVisible()
    await expect(app.getByText('412', { exact: false }).first()).toBeVisible()
    expect(off.requested).toEqual([UNKNOWN])

    // Saved to My Foods under the barcode.
    const saved = await app.evaluate(() => JSON.parse(localStorage.getItem('nutryos.myFoods.v1') ?? '[]'))
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ name: 'Test bar', barcode: UNKNOWN, per100g: { kcal: 412, proteinG: 20, fatG: 18, carbsG: 45 } })

    // Re-scan: resolves from My Foods with no new OFF request.
    await app.getByRole('button', { name: 'Cancel' }).first().click()
    await openBarcodeAgain(app)
    await app.getByPlaceholder('Barcode number').fill(UNKNOWN)
    await app.getByRole('button', { name: 'Look up' }).click()
    await expect(app.getByRole('heading', { name: 'Confirm meal' })).toBeVisible()
    await expect(app.locator('input[value="Test bar"]')).toBeVisible()
    expect(off.requested).toEqual([UNKNOWN]) // still only the first request
  })

  test('OFF knows the product but has no calories -> same label/manual path, never 0', async ({ app, context }) => {
    await noCamera(app)
    const code = '9414942110252'
    await mockOff(context, { [code]: { name: 'Mystery Spread', nutriments: {} } })
    await openBarcode(app)
    await app.getByPlaceholder('Barcode number').fill(code)
    await app.getByRole('button', { name: 'Look up' }).click()
    await expect(app.getByTestId('barcode-label-flow')).toContainText('has no calories')
    await expect(app.getByPlaceholder('e.g. Whey protein')).toHaveValue('Mystery Spread')
    await expect(app.getByRole('heading', { name: 'Confirm meal' })).toHaveCount(0)
  })

  test('label photo: consent first (private by default), nothing sent on Stay private', async ({ app, context }) => {
    await noCamera(app)
    await mockOff(context, {})
    const fnCalls: string[] = []
    await context.route(/\/functions\/v1\/identify-food/, async (route) => {
      fnCalls.push(route.request().postData() ?? '')
      await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ label: { name: 'Whey tub', serving_g: 30, per_100g: { kcal: 380, protein_g: 80, fat_g: 6, carbs_g: 5 }, per_serving: null } }) })
    })
    await openBarcode(app)
    await app.getByPlaceholder('Barcode number').fill('9419372640584')
    await app.getByRole('button', { name: 'Look up' }).click()

    // Stay private: the sheet appears, nothing leaves the phone, manual entry still there.
    await app.getByTestId('label-photo-input').setInputFiles(fixturePath(FIXTURES[0]))
    const sheet = app.getByRole('dialog', { name: 'Read the label with AI?' })
    await expect(sheet).toBeVisible()
    await expect(sheet).toContainText("Google's free AI")
    await sheet.getByRole('button', { name: 'Stay private' }).click()
    await expect(app.getByTestId('label-note')).toContainText('stays on your phone')
    expect(fnCalls).toEqual([])
    expect(await app.evaluate(() => localStorage.getItem('nutryos.cloudAiOptIn.v1'))).not.toBe('true')

    // Allow once: exactly one request, numbers prefilled for the user to check, opt-in flag unchanged.
    await app.getByTestId('label-photo-input').setInputFiles(fixturePath(FIXTURES[0]))
    await app.getByRole('dialog', { name: 'Read the label with AI?' }).getByRole('button', { name: 'Allow once' }).click()
    await expect(app.getByLabel('Calories (kcal)')).toHaveValue('380')
    await expect(app.getByTestId('label-note')).toContainText('Check these against the label')
    expect(fnCalls).toHaveLength(1)
    expect(JSON.parse(fnCalls[0])).toMatchObject({ label: { mimeType: 'image/jpeg' } })
    expect(await app.evaluate(() => localStorage.getItem('nutryos.cloudAiOptIn.v1'))).not.toBe('true')
  })

  test('edge function cannot read labels yet (400) -> clear message, manual path stays', async ({ app, context }) => {
    await noCamera(app)
    await mockOff(context, {})
    await context.route(/\/functions\/v1\/identify-food/, (route) =>
      route.fulfill({ status: 400, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ error: 'imageBase64 and mimeType are required' }) }),
    )
    await openBarcode(app)
    await app.getByPlaceholder('Barcode number').fill('9419372640584')
    await app.getByRole('button', { name: 'Look up' }).click()
    await app.getByTestId('label-photo-input').setInputFiles(fixturePath(FIXTURES[0]))
    await app.getByRole('dialog', { name: 'Read the label with AI?' }).getByRole('button', { name: 'Allow once' }).click()
    await expect(app.getByTestId('label-note')).toContainText('Enter the numbers yourself')
    await expect(app.getByRole('button', { name: 'Use these numbers' })).toBeVisible()
  })
})

test.describe('native detector present but useless -> ponyfill (decide by results)', () => {
  test('native returns [] for the photo -> ponyfill decodes it', async ({ app, context }) => {
    await noCamera(app)
    await stubNativeDetector(app, [])
    const f = FIXTURES[0]
    await mockOff(context, { [lookupCode(f)]: okProduct(lookupCode(f)) })
    await openBarcode(app)
    await app.getByTestId('barcode-photo-input').setInputFiles(fixturePath(f))
    await expect(app.getByRole('heading', { name: 'Confirm meal' })).toBeVisible({ timeout: 30_000 })
    expect(await app.evaluate(() => (window as unknown as { __nativeCalls: number }).__nativeCalls)).toBeGreaterThan(0)
    await app.getByRole('button', { name: 'Cancel' }).first().click()
  })

  test('native returns [] on the live camera too -> ponyfill decodes the frame', async ({ app, context, browserName }) => {
    test.skip(browserName !== 'chromium', 'canvas camera stub below is exercised in Chromium')
    await stubNativeDetector(app, [])
    const f = FIXTURES[0]
    await mockOff(context, { [lookupCode(f)]: okProduct(lookupCode(f)) })
    // Camera = a canvas stream drawn from the fixture image.
    const { readFileSync } = await import('node:fs')
    const b64 = readFileSync(fixturePath(f)).toString('base64')
    await app.addInitScript((data: string) => {
      navigator.mediaDevices.getUserMedia = async () => {
        const img = new Image()
        img.src = `data:image/png;base64,${data}`
        await img.decode()
        const c = document.createElement('canvas')
        c.width = img.width
        c.height = img.height
        const ctx = c.getContext('2d')!
        const draw = () => {
          ctx.drawImage(img, 0, 0)
          requestAnimationFrame(draw)
        }
        draw()
        return c.captureStream(15)
      }
    }, b64)
    await openBarcode(app)
    await expect(app.getByRole('heading', { name: 'Confirm meal' })).toBeVisible({ timeout: 30_000 })
    expect(await app.evaluate(() => (window as unknown as { __nativeCalls: number }).__nativeCalls)).toBeGreaterThanOrEqual(3)
  })

  test('native that works wins and the WASM is never fetched', async ({ app, context }) => {
    await noCamera(app)
    const f = FIXTURES[0]
    await stubNativeDetector(app, [f.code])
    await mockOff(context, { [f.code]: okProduct(f.code) })
    const wasm: string[] = []
    app.on('request', (r) => r.url().endsWith('.wasm') && wasm.push(r.url()))
    await openBarcode(app)
    await app.getByTestId('barcode-photo-input').setInputFiles(fixturePath(f))
    await expect(app.getByRole('heading', { name: 'Confirm meal' })).toBeVisible({ timeout: 30_000 })
    expect(wasm).toEqual([])
  })
})

test.describe('bundle: self-hosted WASM, lazy, no CDN', () => {
  test('first paint loads no scanner code; a scan fetches the WASM from our own origin and nothing from a CDN', async ({ app, context }) => {
    await noCamera(app)
    const urls: string[] = []
    app.on('request', (r) => urls.push(r.url()))
    const f = FIXTURES[0]
    await mockOff(context, { [lookupCode(f)]: okProduct(lookupCode(f)) })
    const { openToday } = await import('./fixtures')
    await openToday(app)
    expect(urls.filter((u) => /\.wasm|barcodePonyfill|zxing/i.test(u))).toEqual([]) // lazy: not on the Today screen
    await app.locator('[data-tour="orb"] button').click({ force: true })
    await app.getByRole('button', { name: 'Scan barcode', exact: true }).click()
    expect(urls.filter((u) => /\.wasm|barcodePonyfill|zxing/i.test(u))).toEqual([]) // still lazy on the scan screen
    await app.getByTestId('barcode-photo-input').setInputFiles(fixturePath(f))
    await expect(app.getByRole('heading', { name: 'Confirm meal' })).toBeVisible({ timeout: 30_000 })
    const wasm = urls.filter((u) => u.endsWith('.wasm') || u.includes('.wasm?'))
    expect(wasm.length).toBeGreaterThan(0)
    expect(wasm.every((u) => /^https?:\/\/(127\.0\.0\.1|localhost)/.test(u))).toBe(true)
    expect(urls.filter((u) => /unpkg|jsdelivr|cdnjs|cdn\./i.test(u))).toEqual([])
  })
})

async function openBarcodeAgain(page: import('@playwright/test').Page) {
  await page.locator('[data-tour="orb"] button').click({ force: true })
  await page.getByRole('button', { name: 'Scan barcode', exact: true }).click()
  await expect(page.getByTestId('barcode-capture')).toBeVisible()
}
