import { describe, expect, it } from 'vitest'
import { whatNextLine } from '@/lib/stats'
import type { Goals, MacroTotals } from '@/lib/types'

const goals: Goals = { calorieGoal: 2000, proteinGoalG: 100, fatGoalG: 60, carbsGoalG: 200 }
const t = (calories: number): MacroTotals => ({ calories, proteinG: 0, fatG: 0, carbsG: 0 })

describe('whatNextLine', () => {
  it('prompts breakfast when nothing is logged', () => {
    expect(whatNextLine(t(0), goals)).toBe('Nothing logged yet: start with breakfast')
  })
  it('says a snack fits when calories remain', () => {
    expect(whatNextLine(t(1740), goals)).toBe('You have 260 kcal left: a snack fits')
  })
  it('reports being over', () => {
    expect(whatNextLine(t(2120), goals)).toBe("You're 120 kcal over today")
  })
  it('counts workout burn toward the budget', () => {
    expect(whatNextLine(t(2120), goals, 300)).toBe('You have 180 kcal left: a snack fits')
  })
  it('returns null without goals', () => {
    expect(whatNextLine(t(500), null)).toBeNull()
  })
})
