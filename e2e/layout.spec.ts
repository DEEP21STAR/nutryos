import { test, expect, openToday } from './fixtures'
import type { Page } from '@playwright/test'

const VIEWPORTS = [
  { width: 360, height: 740 },
  { width: 412, height: 915 },
  { width: 390, height: 844 },
]

type Box = { x: number; y: number; width: number; height: number }
const intersects = (a: Box, b: Box) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y

async function scrollToBottom(page: Page) {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  await page.waitForTimeout(500)
}

/** The last content card on Today: the last <section>/card-like block above the footer. */
async function lastCardBox(page: Page): Promise<Box> {
  const box = await page.evaluate(() => {
    const main = document.querySelector('div.relative.z-10') as HTMLElement
    const footer = main.querySelector('footer')
    const kids = Array.from(main.children).filter((el) => {
      const r = (el as HTMLElement).getBoundingClientRect()
      return r.height > 20 && el !== footer && !(el as HTMLElement).matches('[aria-hidden], nav, [data-tour="orb"], header') && !el.contains(footer)
    })
    const last = kids[kids.length - 1] as HTMLElement
    const r = last.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })
  return box
}

for (const vp of VIEWPORTS) {
  test(`Today bottom: last card clears FAB and tab bar at ${vp.width}x${vp.height}`, async ({ app: page }) => {
    await page.setViewportSize(vp)
    await openToday(page)
    await scrollToBottom(page)

    const card = await lastCardBox(page)
    const fab = (await page.locator('[data-tour="orb"]').boundingBox())!
    const tab = (await page.locator('[data-tour="tabbar"]').boundingBox())!
    expect(fab && tab && card.height > 0).toBeTruthy()
    expect(intersects(card, fab), `last card ${JSON.stringify(card)} vs FAB ${JSON.stringify(fab)}`).toBe(false)
    expect(intersects(card, tab), `last card ${JSON.stringify(card)} vs tab bar ${JSON.stringify(tab)}`).toBe(false)

    // Every interactive control in the last-but-one and last cards ('Set cost', 'Log a workout', ...)
    // must also be clear of the FAB/tab bar once scrolled to the bottom.
    const controls = await page.evaluate(() => {
      const out: Array<{ label: string; x: number; y: number; width: number; height: number }> = []
      const main = document.querySelector('div.relative.z-10') as HTMLElement
      for (const el of Array.from(main.querySelectorAll('button, a, input, select, textarea')) as HTMLElement[]) {
        if (el.closest('nav') || el.closest('[data-tour="orb"]')) continue
        const r = el.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) continue
        out.push({ label: (el.innerText || el.getAttribute('aria-label') || el.tagName).slice(0, 30), x: r.x, y: r.y, width: r.width, height: r.height })
      }
      return out
    })
    for (const c of controls) {
      expect(intersects(c, fab), `control "${c.label}" under FAB`).toBe(false)
      expect(intersects(c, tab), `control "${c.label}" under tab bar`).toBe(false)
    }
  })
}

test('Today top (first fold): FAB does not cover any control or text', async ({ app: page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openToday(page)
  const fab = (await page.locator('[data-tour="orb"]').boundingBox())!
  const tab = (await page.locator('[data-tour="tabbar"]').boundingBox())!
  // FAB is docked inside the tab bar, not floating over page content.
  expect(fab.y).toBeGreaterThanOrEqual(tab.y - 1)
  expect(fab.y + fab.height).toBeLessThanOrEqual(tab.y + tab.height + 1)
  // Page content that is visible (not under the opaque tab bar) never intersects the FAB.
  const covered = await page.evaluate((f) => {
    const hits: string[] = []
    const main = document.querySelector('div.relative.z-10') as HTMLElement
    const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT)
    let n: Node | null
    while ((n = walker.nextNode())) {
      if (!n.textContent?.trim()) continue
      const el = n.parentElement as HTMLElement
      if (el.closest('[data-tour="tabbar"]')) continue
      const range = document.createRange()
      range.selectNodeContents(n)
      for (const r of Array.from(range.getClientRects())) {
        const visibleBottom = Math.min(r.y + r.height, f.tabTop)
        if (r.width && visibleBottom > r.y && r.x < f.x + f.width && r.x + r.width > f.x && r.y < f.y + f.height && visibleBottom > f.y) hits.push(n.textContent.trim().slice(0, 30))
      }
    }
    return hits
  }, { ...fab, tabTop: tab.y })
  expect(covered, 'visible text under the FAB in the first fold').toEqual([])
})

test('tab bar is opaque enough: background alpha >= 0.9 and blurred backdrop', async ({ app: page }) => {
  await openToday(page)
  const info = await page.evaluate(() => {
    const el = document.querySelector('[data-tour="tabbar"]') as HTMLElement
    const cs = getComputedStyle(el)
    const m = cs.backgroundColor.match(/[\d.]+/g)!.map(Number)
    const filter = cs.backdropFilter || (cs as any).webkitBackdropFilter || ''
    return { bg: cs.backgroundColor, alpha: m.length === 4 ? m[3] : 1, filter }
  })
  expect(info.alpha, info.bg).toBeGreaterThanOrEqual(0.9)
  expect(info.filter).toContain('blur')
})
