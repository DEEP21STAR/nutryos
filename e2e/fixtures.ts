import { test as base, expect } from '@playwright/test'
import { installFakeMic } from './support/fakeMic'
import { blockRealtime, mockBackend } from './support/mockSupabase'

const TOUR_SEEN_KEY = 'nutryos:tour-seen:v1'
const INTRO_SEEN_KEY = 'nutrios.introSeen.v1'

type Fixtures = {
  /** Page with mocked backend, fake mic, tour dismissed. Splash plays normally. */
  app: import('@playwright/test').Page
}

export const test = base.extend<Fixtures>({
  app: async ({ page, context }, use) => {
    await mockBackend(context)
    await blockRealtime(page)
    await installFakeMic(page)
    await page.addInitScript(
      ([tour, intro]) => {
        try {
          localStorage.setItem(tour, '1')
          localStorage.setItem(intro, '1')
        } catch {
          /* storage blocked */
        }
      },
      [TOUR_SEEN_KEY, INTRO_SEEN_KEY],
    )
    await use(page)
  },
})

export { expect }

/** Skips the splash and waits for the Today screen. */
export async function openToday(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('./')
  await page.getByRole('button', { name: 'Skip' }).click()
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible()
  await expect(page.locator('[data-tour="tabbar"]')).toBeVisible()
  await page.waitForTimeout(700) // let entrance animations settle
}
