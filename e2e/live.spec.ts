import { test, expect } from '@playwright/test'

/**
 * LIVE tests: real network, real Supabase edge function. Run with `npm run gate:live`.
 * No mocks here. If the function needs a signed-in user JWT that this test cannot obtain without
 * creating a real account, the test is SKIPPED with the reason - it never fakes success.
 */
const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? 'https://ddbybgmysfvsxhadudne.supabase.co'
// The publishable key is public by design (embedded in the shipped bundle); read from env if set.
const PUBLISHABLE_KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY

test('identify-food edge function answers a text parse with the publishable key', async ({ request }) => {
  test.skip(!PUBLISHABLE_KEY, 'VITE_SUPABASE_PUBLISHABLE_KEY not set in the environment; cannot call the function.')
  const res = await request.post(`${SUPABASE_URL}/functions/v1/identify-food`, {
    headers: { apikey: PUBLISHABLE_KEY!, Authorization: `Bearer ${PUBLISHABLE_KEY}`, 'content-type': 'application/json' },
    data: { conversation: [{ role: 'user', content: '2 Weet-Bix with milk' }] },
    timeout: 45_000,
  })
  if (res.status() === 401 || res.status() === 403) {
    test.skip(true, `Edge function requires a signed-in user JWT (HTTP ${res.status()}); a login/anonymous sign-up would create a real account, so this live test is skipped, not faked.`)
  }
  expect(res.status(), await res.text()).toBe(200)
  const body = await res.json()
  expect(['items', 'clarify']).toContain(body.type)
})
