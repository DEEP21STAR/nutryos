import type { BrowserContext, Route } from '@playwright/test'

/**
 * UI-FLOW-TEST ONLY. Stands in for Supabase (auth + PostgREST + functions) so layout/splash/boot
 * tests run offline with no real accounts. It never runs in live.spec.ts. All data here is
 * synthetic (a fixed fake user id, empty tables, one synthetic goals row).
 */
const FAKE_USER_ID = '00000000-0000-4000-8000-000000000001'

function b64url(o: unknown): string {
  return Buffer.from(JSON.stringify(o)).toString('base64url')
}

function fakeJwt(): string {
  const now = Math.floor(Date.now() / 1000)
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: FAKE_USER_ID, role: 'authenticated', aud: 'authenticated', iat: now - 5, exp: now + 3600, is_anonymous: true })}.fake-signature`
}

function session() {
  const now = Math.floor(Date.now() / 1000)
  return {
    access_token: fakeJwt(),
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: now + 3600,
    refresh_token: 'fake-refresh',
    user: { id: FAKE_USER_ID, aud: 'authenticated', role: 'authenticated', is_anonymous: true, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() },
  }
}

const GOALS_ROW = { user_id: FAKE_USER_ID, calorie_goal: 2200, protein_goal_g: 140, fat_goal_g: 70, carbs_goal_g: 250 }

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) })
}

export const LOCAL_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//

export async function mockBackend(context: BrowserContext): Promise<void> {
  // Anything not local is refused, so UI tests can never reach a third party (fonts, Ollama, etc.).
  await context.route((url) => !LOCAL_ORIGIN.test(url.href) && !url.href.startsWith('data:') && !url.href.startsWith('blob:'), (route) => route.abort())

  await context.route(/\.supabase\.co\//, async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } })
    if (url.pathname.startsWith('/auth/v1/')) {
      if (url.pathname.endsWith('/user')) return json(route, session().user)
      return json(route, session())
    }
    if (url.pathname.startsWith('/rest/v1/')) {
      const table = url.pathname.split('/').pop()
      const wantsObject = (req.headers()['accept'] ?? '').includes('vnd.pgrst.object')
      if (req.method() !== 'GET') return json(route, wantsObject ? {} : [], 201)
      if (table === 'goals') return json(route, wantsObject ? GOALS_ROW : [GOALS_ROW])
      return wantsObject ? json(route, { code: 'PGRST116', message: 'no rows' }, 406) : json(route, [])
    }
    if (url.pathname.startsWith('/functions/v1/')) return json(route, { error: 'mocked: UI tests do not call the edge function' }, 503)
    return json(route, {})
  })
}

/** Realtime websockets are closed immediately (the app tolerates that). */
export async function blockRealtime(page: import('@playwright/test').Page): Promise<void> {
  await page.routeWebSocket(/supabase\.co/, (ws) => ws.close())
}
