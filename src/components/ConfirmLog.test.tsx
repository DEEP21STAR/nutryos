import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfirmLog } from '@/components/ConfirmLog'
import { DEFAULT_GOALS, type FoodItem } from '@/lib/types'

const banana: FoodItem = { id: 'b', name: 'Banana', estimatedGrams: 120, calories: 114, proteinG: 1.7, fatG: 0.4, carbsG: 24, source: 'curated', confidence: 'high', sourceRef: 'AFCD F000262' }
const unknown: FoodItem = { id: 'z', name: 'zorbleflax', estimatedGrams: 100, calories: 0, proteinG: 0, fatG: 0, carbsG: 0, source: 'unresolved' }

describe('ConfirmLog: never a silent 0', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function render(items: FoodItem[], onConfirm = vi.fn()) {
    act(() => {
      root.render(
        <ConfirmLog photoDataUrl={null} initialItems={items} todaysTotals={{ calories: 0, proteinG: 0, fatG: 0, carbsG: 0 }} goals={DEFAULT_GOALS} onConfirm={onConfirm} onCancel={() => {}} />,
      )
    })
    return onConfirm
  }
  const logButton = () => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Log this meal') as HTMLButtonElement
  const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement

  it('shows source badges and enables logging when every item has numbers', () => {
    render([banana])
    const badges = [...container.querySelectorAll('[data-testid="source-badge"]')].map((b) => b.textContent)
    expect(badges).toEqual(['NZ/AU food table · high'])
    expect(container.textContent).toContain('AFCD F000262')
    expect(logButton().disabled).toBe(false)
  })

  it('shows "Needs numbers" and disables logging for an unresolved 0-kcal item', () => {
    render([banana, unknown])
    expect(container.querySelector('[data-testid="needs-numbers"]')).not.toBeNull()
    expect(container.querySelector('[data-source="needs-numbers"]')?.textContent).toBe('Needs numbers')
    expect(logButton().disabled).toBe(true)
    expect(container.textContent).toContain('1 item needs numbers')
  })

  it('"Log with 0 for this item" asks first, then enables logging and logs a confirmed zero', () => {
    const onConfirm = render([banana, unknown])
    act(() => button('Log with 0 for this item').click())
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull()
    expect(logButton().disabled).toBe(true) // still disabled until the dialog is confirmed
    act(() => button('Log with 0').click())
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
    expect(logButton().disabled).toBe(false)
    act(() => logButton().click())
    const meal = onConfirm.mock.calls[0][0]
    expect(meal.items.find((i: FoodItem) => i.name === 'zorbleflax')).toMatchObject({ calories: 0, zeroConfirmed: true, source: 'user' })
  })

  it('"Estimate with AI" without opt-in opens the consent sheet and sends nothing on "Stay private"', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    render([unknown])
    act(() => button('Estimate with AI').click())
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain('Allow once')
    expect(dialog?.textContent).toContain('Always')
    expect(dialog?.textContent).toContain('Stay private')
    act(() => button('Stay private').click())
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(logButton().disabled).toBe(true)
    fetchSpy.mockRestore()
  })
})
