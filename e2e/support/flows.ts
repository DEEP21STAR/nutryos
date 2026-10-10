import { expect, type Page } from '@playwright/test'
import { openToday } from '../fixtures'

/** Today -> orb -> "Type it" (the visible text entry in the capture sheet). */
export async function openTypeIt(page: Page): Promise<void> {
  await openToday(page)
  // The orb pulses forever (GSAP), so it never counts as "stable" for Playwright's actionability check.
  await page.locator('[data-tour="orb"] button').click({ force: true })
  await page.getByRole('button', { name: 'Type it', exact: true }).click()
}

/** Type text, tap Send, wait for the confirm screen. */
export async function typeAndSend(page: Page, text: string): Promise<void> {
  await openTypeIt(page)
  await page.getByRole('textbox').fill(text)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Confirm meal' })).toBeVisible({ timeout: 20_000 })
}

export async function openVoice(page: Page): Promise<void> {
  const voice = page.getByRole('button', { name: 'Voice', exact: true })
  // The orb pulses forever, and on a very slow CPU the first tap can land before the app is ready: retry it.
  for (let attempt = 0; attempt < 6 && !(await voice.isVisible()); attempt++) {
    await page.locator('[data-tour="orb"] button').click({ force: true })
    await voice.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {})
  }
  await voice.click({ force: true })
}
