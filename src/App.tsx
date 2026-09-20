import { lazy, Suspense, useEffect, useState } from 'react'
import { CameraCapture, InputOrbButton } from '@/components/CameraCapture'
import { MenuCapture } from '@/components/MenuCapture'
import { BarcodeCapture } from '@/components/BarcodeCapture'
import { ConfirmLog } from '@/components/ConfirmLog'
import { TodayRing } from '@/components/TodayRing'
import { HealthyScoreGauge } from '@/components/HealthyScoreGauge'
import { StreakBanner } from '@/components/StreakBanner'
import { WaterTracker } from '@/components/WaterTracker'
import { RecentMeals } from '@/components/RecentMeals'
import { WorkoutTracker } from '@/components/WorkoutTracker'
import { MealTimeline } from '@/components/MealTimeline'
import { TipsTicker } from '@/components/TipsTicker'
import { Achievements } from '@/components/Achievements'
import { TrendsHistory } from '@/components/TrendsHistory'
import { TabBar, type TabKey } from '@/components/TabBar'
import { WhetuFooter } from '@/components/WhetuFooter'
import { SplashScreen } from '@/components/SplashScreen'
import { OnboardingWizard } from '@/components/OnboardingWizard'
import { SettingsMenuButton } from '@/components/SettingsMenuButton'

// Code-split the heavy, not-always-visible screens — these five are the largest files in the
// app after App.tsx itself, and were previously all precached into the main bundle even though
// most sessions never open Settings, Together mode, or Progress photos. Named exports (not
// default), so each needs the .then() unwrap — React.lazy only accepts a `{ default }` shape.
const VoiceCapture = lazy(() => import('@/components/VoiceCapture').then((m) => ({ default: m.VoiceCapture })))
const TogetherMode = lazy(() => import('@/components/TogetherMode').then((m) => ({ default: m.TogetherMode })))
const ProgressPhotos = lazy(() => import('@/components/ProgressPhotos').then((m) => ({ default: m.ProgressPhotos })))
const SettingsPanel = lazy(() => import('@/components/SettingsPanel').then((m) => ({ default: m.SettingsPanel })))

/** Minimal, theme-matched placeholder while a lazy screen's chunk downloads. */
function ScreenFallback() {
  return (
    <div className="flex flex-1 items-center justify-center py-16">
      <div
        className="h-8 w-8 animate-spin rounded-full border-2 border-white/10"
        style={{ borderTopColor: 'var(--color-accent-health)' }}
      />
    </div>
  )
}
import { useRegisterSW } from 'virtual:pwa-register/react'
import { getStoredTheme, applyTheme, type Theme } from '@/lib/theme'
import { getStoredAccentColor, applyAccentColor, type AccentColor } from '@/lib/accentColor'
import { identifyFoodViaOllama } from '@/lib/ollamaVision'
import { identifyFoodViaGemini } from '@/lib/geminiVision'
import { identifyFoodOnDevice, isWebGPUAvailable, type OnDeviceProgress } from '@/lib/onDeviceVision'
import { resizeImage } from '@/lib/imageResize'
import { resolveIdentifiedItems } from '@/lib/resolveFoodItems'
import { fireConfetti } from '@/lib/confetti'
import { playScanSuccessPing } from '@/lib/chime'
import { hapticSuccess, hapticCelebrate } from '@/lib/haptics'
import { ensureAuthenticated } from '@/lib/auth'
import { insertMeal, listTodayMeals, subscribeToMeals } from '@/lib/mealsRepo'
import { fetchGoals, saveGoals } from '@/lib/goalsRepo'
import { fetchAvatarUrl, fetchDisplayName, saveDisplayName } from '@/lib/avatarRepo'
import { sumMacros, DEFAULT_GOALS, type FoodItem, type Goals, type Meal } from '@/lib/types'
import { uid } from '@/lib/utils'
import type { RealtimeChannel } from '@supabase/supabase-js'

type Stage = 'idle' | 'mode-select' | 'camera' | 'voice' | 'menu' | 'barcode' | 'identifying' | 'confirm' | 'logging'

/**
 * Core loop, now backed by the real, live Supabase project
 * (ddbybgmysfvsxhadudne) — camera capture -> Ollama vision ID -> Open Food
 * Facts macro lookup -> editable confirm -> real Supabase Storage upload +
 * table insert -> ring fills + timeline updates (via a real Postgres
 * realtime subscription, not local-only state). Trends/History/Profile
 * screens and the cinematic/intelligence layer are still deliberately not
 * built — this round only replaced the mock data layer with real calls.
 */
export default function App() {
  const [activeTab, setActiveTab] = useState<TabKey>('today')
  // On-device fallback progress (model download %, "running on-device", etc.) — shown on the
  // identifying overlay only while that path is actually in use, so the common Ollama-reachable
  // case never sees an unnecessary extra line.
  const [identifyingDetail, setIdentifyingDetail] = useState<string | null>(null)
  const [stage, setStage] = useState<Stage>('idle')
  // One place to react to "identification finished, food recognized" rather than duplicating a
  // sound/haptic call at every one of handleCapture's several setStage('confirm') exit points
  // (Ollama success, Gemini success, on-device success, on-device skipped) — this fires exactly
  // once per transition into 'confirm', regardless of which path got there.
  useEffect(() => {
    if (stage === 'confirm') {
      playScanSuccessPing()
      hapticSuccess()
    }
  }, [stage])
  const [capturedPhoto, setCapturedPhoto] = useState<{ blob: Blob; dataUrl: string } | null>(null)
  const [draftItems, setDraftItems] = useState<FoodItem[]>([])
  // Menu-mode entries carry these into ConfirmLog as pre-filled defaults (still fully editable
  // there — see ConfirmLog's own Eating Out toggle, which is available on every path, not just
  // menu-mode). Reset alongside draftItems/capturedPhoto in every path that leaves 'confirm'.
  const [draftIsEatingOut, setDraftIsEatingOut] = useState(false)
  const [draftRestaurantName, setDraftRestaurantName] = useState('')
  // Only meaningfully distinguishes 'voice' vs 'barcode' -- both are the no-photo cases
  // ConfirmLog needs to tell apart (see ConfirmLog.tsx's own logSource prop comment). Photo/menu
  // paths always carry a real photo, so this is never consulted for those.
  const [draftLogSource, setDraftLogSource] = useState<'voice' | 'barcode' | 'repeat'>('voice')
  const [meals, setMeals] = useState<Meal[]>([])
  const [caloriesBurned, setCaloriesBurned] = useState(0)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [authError, setAuthError] = useState<string | null>(null)
  const [showSplash, setShowSplash] = useState(true)
  // null = still loading (or genuinely not onboarded yet); DEFAULT_GOALS is only ever used as a
  // placeholder while this resolves, never persisted or shown as if it were the real target.
  const [goals, setGoals] = useState<Goals | null>(null)
  const [needsOnboarding, setNeedsOnboarding] = useState(false)
  const [theme, setTheme] = useState<Theme>('dark')
  const [accentColor, setAccentColor] = useState<AccentColor>('emerald')
  const [showSettings, setShowSettings] = useState(false)
  const [swRegistration, setSwRegistration] = useState<ServiceWorkerRegistration | undefined>(undefined)
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)
  const [displayName, setDisplayName] = useState<string | null>(null)

  const { needRefresh: [needRefresh], updateServiceWorker } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      setSwRegistration(registration)
    },
  })

  // Previously the only way a new build ever reached an already-installed PWA was Settings ->
  // "Check for Updates", tapped manually. Real gap found 2026-09-20: a shipped change (the splash
  // tagline chrome effect) was live on the server all along, but Deep's installed app kept
  // rendering yesterday's cached shell because nothing ever re-checked github.io's sw.js (served
  // with a 10-minute HTTP cache) after the initial install. Re-check on every foreground, not just
  // on cold load, so a backgrounded/reopened PWA self-heals instead of silently going stale.
  useEffect(() => {
    if (!swRegistration) return
    const checkForUpdate = () => swRegistration.update()
    const id = setInterval(checkForUpdate, 5 * 60 * 1000)
    const onVisible = () => {
      if (document.visibilityState === 'visible') checkForUpdate()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [swRegistration])

  // Apply a found update automatically rather than waiting for a manual Settings tap — but not
  // mid-capture, where a reload would drop an in-progress photo/voice/meal action. Re-evaluates
  // every time `stage` changes, so it applies the moment the user lands back on a safe stage.
  useEffect(() => {
    if (!needRefresh) return
    const UNSAFE_STAGES: Stage[] = ['camera', 'voice', 'identifying', 'logging']
    if (!UNSAFE_STAGES.includes(stage)) {
      updateServiceWorker(true)
    }
  }, [needRefresh, stage, updateServiceWorker])

  // Theme is a user preference, not app data — apply the stored choice once on mount, same
  // pattern as any other localStorage-backed setting (independent of the Supabase auth bootstrap
  // below, since it has to work identically for a brand-new user who hasn't onboarded yet).
  useEffect(() => {
    const stored = getStoredTheme()
    applyTheme(stored)
    setTheme(stored)
    setAccentColor(getStoredAccentColor())
    applyAccentColor(getStoredAccentColor())
  }, [])

  // PWA shortcut deep link ("Log a meal" on the home-screen icon's long-press menu, see
  // vite.config.ts's manifest.shortcuts) — only fires once goals have actually resolved (an
  // onboarded user), not mid-splash/onboarding, and strips the param so a later reload doesn't
  // keep reopening the camera.
  useEffect(() => {
    if (!goals) return
    const params = new URLSearchParams(window.location.search)
    if (params.get('action') === 'log-meal') {
      setStage('camera')
      params.delete('action')
      const next = `${window.location.pathname}${params.toString() ? `?${params}` : ''}`
      window.history.replaceState({}, '', next)
    }
  }, [goals])

  async function handleCheckForUpdates(): Promise<boolean> {
    if (!swRegistration) return false
    const before = swRegistration.waiting
    await swRegistration.update()
    // A genuinely new SW starts installing asynchronously after update() resolves; give it a
    // moment rather than reading swRegistration.waiting synchronously, which would always be
    // whatever was already there (or nothing) before the update check had a chance to run.
    await new Promise((r) => setTimeout(r, 1000))
    return swRegistration.waiting !== before && swRegistration.waiting != null
  }

  // Bootstrap: real Supabase anonymous auth + real meals load + real
  // realtime subscription for cross-device sync. No mock data anywhere in
  // this path.
  useEffect(() => {
    let channel: RealtimeChannel | null = null
    let cancelled = false

    async function runBootstrap() {
      const user = await ensureAuthenticated()
      if (cancelled) return
      setUserId(user.id)

      const today = await listTodayMeals(user.id)
      if (cancelled) return
      setMeals(today)

      channel = subscribeToMeals(user.id, (meal) => {
        setMeals((prev) => (prev.some((m) => m.id === meal.id) ? prev : [...prev, meal]))
      })

      // The `goals` table has existed since the very first migration, but nothing ever read
      // or wrote it until the onboarding wizard — every screen used DEFAULT_GOALS regardless
      // of who was using the app. A missing row means this user genuinely hasn't onboarded yet.
      const savedGoals = await fetchGoals(user.id)
      if (cancelled) return
      if (savedGoals) {
        setGoals(savedGoals)
      } else {
        setNeedsOnboarding(true)
      }

      const savedAvatar = await fetchAvatarUrl(user.id)
      if (cancelled) return
      setAvatarUrl(savedAvatar)

      const savedName = await fetchDisplayName(user.id)
      if (cancelled) return
      setDisplayName(savedName)
    }

    // A single transient failure here (a brief network blip, or a genuinely-observed Supabase
    // auth clock-skew edge case — "JWT issued at future" on a freshly-minted anonymous token)
    // used to abort the entire bootstrap permanently: needsOnboarding stayed false, goals stayed
    // null, and the user was stranded on a default-goals dashboard with just an error banner and
    // no way back short of knowing to manually reload. One retry after a short delay recovers
    // from exactly this kind of blip without needing the user to do anything.
    async function bootstrap() {
      setAuthError(null)
      try {
        await runBootstrap()
      } catch {
        if (cancelled) return
        await new Promise((r) => setTimeout(r, 1000))
        if (cancelled) return
        try {
          await runBootstrap()
        } catch (err) {
          if (!cancelled) setAuthError(err instanceof Error ? err.message : 'Supabase sign-in failed.')
        }
      }
    }
    bootstrap()

    return () => {
      cancelled = true
      channel?.unsubscribe()
    }
  }, [])

  const totals = sumMacros(meals.flatMap((m) => m.items))

  async function handleCapture(blob: Blob) {
    const dataUrl = await blobToDataUrl(blob)
    setCapturedPhoto({ blob, dataUrl })
    setDraftIsEatingOut(false)
    setDraftRestaurantName('')
    setStage('identifying')
    setStatusMessage(null)
    setIdentifyingDetail(null)

    // Resize before sending to the vision model — confirmed live during
    // core-loop testing that this cuts inference time ~5.7x on this
    // hardware, and an unresized photo has previously blown the model's
    // context window entirely. Shared by both the Ollama and on-device paths.
    const resizedForVision = await resizeImage(blob, 640)

    // Three real vision paths, tried in order — each with a genuinely different failure mode,
    // so none of them can substitute for the others:
    //   1. Ollama (home/Tailscale) — best quality, needs the laptop on and reachable.
    //   2. Gemini via the identify-food Edge Function — the shared-family path (2026-09-17):
    //      one Gemini key held server-side, invisible to every device, needs only internet
    //      (wifi or mobile data), no per-device capability required.
    //   3. On-device WebGPU — free forever, fully offline once cached, but real hardware/browser
    //      support varies (confirmed absent on Deep's own phone) — last resort, not first.
    const failures: string[] = []

    try {
      const { items, endpointUsed } = await identifyFoodViaOllama(resizedForVision)
      setStatusMessage(`Identified via ${endpointUsed}`)
      setDraftItems(await resolveIdentifiedItems(items))
      setStage('confirm')
      return
    } catch (ollamaErr) {
      failures.push(`Ollama: ${ollamaErr instanceof Error ? ollamaErr.message : 'failed'}`)
    }

    try {
      setIdentifyingDetail('Trying shared vision service…')
      const items = await identifyFoodViaGemini(resizedForVision)
      setStatusMessage('Identified via shared vision service')
      setDraftItems(await resolveIdentifiedItems(items))
      setStage('confirm')
      return
    } catch (geminiErr) {
      failures.push(`Shared vision service: ${geminiErr instanceof Error ? geminiErr.message : 'failed'}`)
    }

    if (!isWebGPUAvailable()) {
      // Distinct from a plain failure — explicitly says the on-device attempt was never made,
      // not that it was tried and failed, so this doesn't get misread as a bug in that path.
      setStatusMessage(`${failures.join(' | ')} | On-device: skipped — this browser has no WebGPU.`)
      setDraftItems([])
      setStage('confirm')
      return
    }

    try {
      setIdentifyingDetail('Starting on-device model (first time: one download, then instant)…')
      const items = await identifyFoodOnDevice(resizedForVision, (p: OnDeviceProgress) => {
        if (p.status === 'progress' && typeof p.progress === 'number') {
          setIdentifyingDetail(`Downloading on-device model… ${Math.round(p.progress)}%`)
        } else if (p.status === 'ready' || p.status === 'done') {
          setIdentifyingDetail('Running on-device…')
        }
      })
      setStatusMessage('Identified on-device (offline)')
      setDraftItems(await resolveIdentifiedItems(items))
      setStage('confirm')
    } catch (onDeviceErr) {
      failures.push(`On-device: ${onDeviceErr instanceof Error ? onDeviceErr.message : 'failed'}`)
      setStatusMessage(failures.join(' | '))
      setDraftItems([])
      setStage('confirm') // still let the user log manually — manual-entry fallback
    } finally {
      setIdentifyingDetail(null)
    }
  }

  /**
   * Voice path's final step, run once VoiceCapture has a resolved item list
   * (either straight from the AI's first pass, or after it asked one or more
   * clarifying follow-up questions). No photo exists for a voice-logged meal
   * — capturedPhoto stays null, which ConfirmLog and the logging overlay
   * both render around rather than require.
   */
  function handleVoiceResolved(items: FoodItem[]) {
    setCapturedPhoto(null)
    setDraftItems(items)
    setDraftIsEatingOut(false)
    setDraftRestaurantName('')
    setDraftLogSource('voice')
    setStage('confirm')
  }

  /** Same shape as handleVoiceResolved -- a barcode scan resolves straight to a real FoodItem
   * with no AI/identifying step involved (see BarcodeCapture.tsx), so it goes straight to confirm
   * the same way. */
  function handleBarcodeResolved(items: FoodItem[]) {
    setCapturedPhoto(null)
    setDraftItems(items)
    setDraftIsEatingOut(false)
    setDraftRestaurantName('')
    setDraftLogSource('barcode')
    setStage('confirm')
  }

  /** RecentMeals.tsx's long-press path -- re-log a past meal but land on the confirm screen
   * first so portion/items can actually be adjusted, rather than blindly repeating whatever was
   * logged last time. */
  function handleRepeatForEdit(items: FoodItem[]) {
    setCapturedPhoto(null)
    setDraftItems(items.map((it) => ({ ...it, id: uid() })))
    setDraftIsEatingOut(false)
    setDraftRestaurantName('')
    setDraftLogSource('repeat')
    setStage('confirm')
  }

  /** RecentMeals.tsx's tap path -- genuinely one-tap re-log, no confirm screen, matching the
   * explicit "effortless" priority for a meal someone's already logged (and edited/confirmed)
   * before. Same real insert + state-update + celebration as handleConfirm, just skipping the
   * confirm screen this one time since there's nothing new to confirm. */
  async function handleQuickLog(items: FoodItem[]) {
    if (!userId) {
      setStatusMessage('Not signed in to Supabase yet — cannot log this meal.')
      return
    }
    try {
      const savedMeal = await insertMeal(userId, null, items.map((it) => ({ ...it, id: uid() })))
      setMeals((prev) => (prev.some((m) => m.id === savedMeal.id) ? prev : [...prev, savedMeal]))
      fireConfetti()
      hapticCelebrate()
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : 'Failed to save meal to Supabase.')
    }
  }

  /**
   * Menu path's final step (Phase 3, Restaurant/Takeaway Mode), run once MenuCapture has
   * resolved the user's confirmed dish selection through Open Food Facts. `meta.photo` is
   * whichever photo MenuCapture decided to keep — the plate photo if the user added one,
   * otherwise the menu photo itself (see MenuCapture.tsx's own header comment for why this app
   * keeps exactly one photo per meal rather than two). Eating Out defaults to ON here since the
   * whole point of this entry point is a restaurant/takeaway meal — still just a default, fully
   * togglable in ConfirmLog like every other path.
   */
  function handleMenuResolved(
    items: FoodItem[],
    meta: { restaurantName: string; photo: { blob: Blob; dataUrl: string } | null },
  ) {
    setCapturedPhoto(meta.photo)
    setDraftItems(items)
    setDraftIsEatingOut(true)
    setDraftRestaurantName(meta.restaurantName)
    setStage('confirm')
  }

  async function handleConfirm(draft: Meal) {
    if (!userId) {
      setStatusMessage('Not signed in to Supabase yet — cannot log this meal.')
      return
    }
    setStage('logging')
    try {
      const savedMeal = await insertMeal(userId, capturedPhoto?.blob ?? null, draft.items, {
        isEatingOut: draft.isEatingOut,
        restaurantName: draft.restaurantName,
      })
      setMeals((prev) => (prev.some((m) => m.id === savedMeal.id) ? prev : [...prev, savedMeal]))
      setStatusMessage(null)
      fireConfetti()
      hapticCelebrate()
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : 'Failed to save meal to Supabase.')
    } finally {
      setStage('idle')
      setCapturedPhoto(null)
      setDraftItems([])
      setDraftIsEatingOut(false)
      setDraftRestaurantName('')
    }
  }

  async function handleOnboardingComplete(newGoals: Goals, name: string) {
    setGoals(newGoals)
    setNeedsOnboarding(false)
    if (name) setDisplayName(name)
    if (userId) {
      try {
        await saveGoals(userId, newGoals)
      } catch (err) {
        // Real goals are already in state and the app is usable either way — a failed write just
        // means this device's answers won't persist across reloads/devices yet, not a blocker.
        setStatusMessage(err instanceof Error ? err.message : 'Could not save your goals to Supabase.')
      }
      if (name) {
        try {
          await saveDisplayName(userId, name)
        } catch (err) {
          setStatusMessage(err instanceof Error ? err.message : 'Could not save your name to Supabase.')
        }
      }
    }
  }

  // The splash renders as an overlay ALONGSIDE whichever real screen is underneath (onboarding
  // or the main app), not as an early return replacing it — the iris-wipe reveal animation
  // needs the real content already mounted and painted behind it to actually reveal, rather
  // than just cutting to a blank moment before the real screen mounts. Deliberately NOT
  // extracted into a nested component function (a real, easy-to-miss anti-pattern) — that would
  // redefine a new component type on every App render, remounting the whole tree (and every
  // child's own internal state, e.g. mid-capture UI) any time meals/goals/etc. change.
  return (
    <>
      {showSplash && <SplashScreen onDone={() => setShowSplash(false)} />}
      {needsOnboarding ? (
        <OnboardingWizard onComplete={handleOnboardingComplete} />
      ) : (
        <div className="relative z-10 mx-auto flex min-h-screen max-w-md flex-col overflow-x-hidden pb-40 text-text-primary">
      {/* Ambient background glow — subtle, static, sits behind everything. Starfield canvas
          (index.html) now shows through here — Phase 1's "no particles" scope was revised. */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-x-0 top-0 h-80 opacity-30"
        style={{ background: 'radial-gradient(60% 60% at 50% 0%, var(--glow-ai), transparent 70%)' }}
      />

      <header className="relative p-4 text-center">
        <SettingsMenuButton onClick={() => setShowSettings(true)} />
        <h1 className="text-title">
          {activeTab === 'today' ? 'Today' : activeTab === 'progress' ? 'Progress' : 'Together'}
        </h1>
        {authError && (
          <p className="mt-1 text-caption text-accent-danger">
            {authError}{' '}
            <button onClick={() => window.location.reload()} className="underline">
              Retry
            </button>
          </p>
        )}
        {statusMessage && <p className="mt-1 text-caption text-text-tertiary">{statusMessage}</p>}
      </header>

      {showSettings && (
        <Suspense fallback={<ScreenFallback />}>
        <SettingsPanel
          onClose={() => setShowSettings(false)}
          theme={theme}
          onThemeChange={setTheme}
          accentColor={accentColor}
          onAccentColorChange={setAccentColor}
          needRefresh={needRefresh}
          onUpdate={() => updateServiceWorker(true)}
          onCheckForUpdates={handleCheckForUpdates}
          userId={userId}
          avatarUrl={avatarUrl}
          onAvatarChange={setAvatarUrl}
          displayName={displayName}
          onDisplayNameChange={setDisplayName}
        />
        </Suspense>
      )}

      {/* Tabbed layout (2026-09-17) — was one continuous scroll through every section
          regardless of what the user actually came here to do. Each tab below is exactly the
          same components/props as before, just gated by activeTab instead of always-rendered,
          so none of them had to change their own data-fetching logic. */}
      {activeTab === 'today' && (
        <>
          <TodayRing totals={totals} goals={goals ?? DEFAULT_GOALS} caloriesBurned={caloriesBurned} />
          <RecentMeals
            userId={userId}
            todaysMealCount={meals.length}
            onQuickLog={handleQuickLog}
            onRepeatForEdit={handleRepeatForEdit}
          />
          {/* Phase 5, Healthy Score — added alongside TodayRing, not replacing any part of it
              (see HealthyScoreGauge.tsx's own header comment for why). */}
          <HealthyScoreGauge totals={totals} goals={goals ?? DEFAULT_GOALS} todaysMeals={meals} />
          <StreakBanner userId={userId} todaysMealCount={meals.length} displayName={displayName} />
          <WorkoutTracker userId={userId} onBurnedChange={setCaloriesBurned} displayName={displayName} />
          <WaterTracker />
          <MealTimeline meals={meals} onAddMeal={() => setStage('mode-select')} />
          <TipsTicker meals={meals} goals={goals ?? DEFAULT_GOALS} />
        </>
      )}

      {activeTab === 'progress' && (
        <>
          {/* Phase 4 — achievements computed from real meal history, see the component's own
              header comment for what's real vs. demo. */}
          <Achievements meals={meals} goals={goals ?? DEFAULT_GOALS} displayName={displayName} />
          {/* Phase 5, Trends & History — real weekly calorie bar chart + weight trend (or its
              honest empty state). */}
          <TrendsHistory userId={userId} goals={goals ?? DEFAULT_GOALS} displayName={displayName} />
          {/* Progress photos — private timeline + before/after compare + share, its own
              top-level section matching Achievements/TrendsHistory's pattern. */}
          {userId && (
            <Suspense fallback={<ScreenFallback />}>
              <ProgressPhotos userId={userId} onOpenSettings={() => setShowSettings(true)} />
            </Suspense>
          )}
        </>
      )}

      {activeTab === 'together' && (
        <Suspense fallback={<ScreenFallback />}>
          <TogetherMode meals={meals} goals={goals ?? DEFAULT_GOALS} avatarUrl={avatarUrl} userId={userId} />
        </Suspense>
      )}

      {/* mt-auto pins this to the bottom of the flex column regardless of how tall each tab's
          own content is — without it, a short tab (e.g. Today with no meals logged) leaves the
          footer stranded mid-page with a big dead gap before the fixed camera/tab-bar clearance
          below (real bug, caught from a live screenshot: looked like the footer "wasn't at the
          bottom" even though it was technically the last DOM child). */}
      <WhetuFooter className="mt-auto" name={displayName} />

      <InputOrbButton onClick={() => setStage('mode-select')} />
      <TabBar active={activeTab} onChange={setActiveTab} />

      {stage === 'mode-select' && (
        <InputModeSheet
          onPhoto={() => setStage('camera')}
          onVoice={() => setStage('voice')}
          onMenu={() => setStage('menu')}
          onBarcode={() => setStage('barcode')}
          onCancel={() => setStage('idle')}
        />
      )}

      {stage === 'camera' && <CameraCapture onCapture={handleCapture} onCancel={() => setStage('idle')} />}

      {stage === 'voice' && (
        <Suspense fallback={<ScreenFallback />}>
          <VoiceCapture onResolved={handleVoiceResolved} onCancel={() => setStage('idle')} />
        </Suspense>
      )}

      {stage === 'menu' && (
        <MenuCapture onResolved={handleMenuResolved} onCancel={() => setStage('idle')} />
      )}

      {stage === 'barcode' && (
        <BarcodeCapture onResolved={handleBarcodeResolved} onCancel={() => setStage('idle')} />
      )}

      {stage === 'identifying' && capturedPhoto && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-bg-primary/95">
          <div className="glass-card relative overflow-hidden p-2">
            <img src={capturedPhoto.dataUrl} alt="" className="h-40 w-40 rounded-md object-cover opacity-80" />
            <div className="identify-scanline" aria-hidden />
          </div>
          <p className="text-body text-accent-ai motion-safe:animate-pulse">Identifying food…</p>
          {identifyingDetail && <p className="text-caption text-text-tertiary">{identifyingDetail}</p>}
        </div>
      )}

      {stage === 'confirm' && (
        <ConfirmLog
          photoDataUrl={capturedPhoto?.dataUrl ?? null}
          initialItems={draftItems}
          pastMeals={meals}
          initialIsEatingOut={draftIsEatingOut}
          initialRestaurantName={draftRestaurantName}
          logSource={draftLogSource}
          todaysTotals={totals}
          goals={goals ?? DEFAULT_GOALS}
          identificationNote={statusMessage}
          onConfirm={handleConfirm}
          onCancel={() => {
            setStage('idle')
            setCapturedPhoto(null)
            setDraftItems([])
            setDraftIsEatingOut(false)
            setDraftRestaurantName('')
          }}
        />
      )}

      {stage === 'logging' && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-bg-primary/95">
          <div className="glass-card p-2">
            {capturedPhoto ? (
              <img src={capturedPhoto.dataUrl} alt="" className="h-40 w-40 rounded-md object-cover opacity-80" />
            ) : (
              <div className="grid h-40 w-40 place-items-center rounded-md text-4xl" aria-hidden>
                🎙️
              </div>
            )}
          </div>
          <p className="text-body text-accent-health motion-safe:animate-pulse">Saving to Supabase…</p>
        </div>
      )}
        </div>
        )}
    </>
  )
}

/**
 * Tapping the orb now offers three genuinely distinct entry points instead of
 * jumping straight to the camera — Photo (existing CameraCapture, itself
 * still offering live camera + gallery/files), Voice (VoiceCapture), and
 * Eating Out (MenuCapture, Phase 3 — menu-photo OCR + optional plate photo).
 * Styled with the same glass button language as CameraCapture's
 * UploadOptions rather than inventing a new sheet pattern.
 */
function InputModeSheet({
  onPhoto,
  onVoice,
  onMenu,
  onBarcode,
  onCancel,
}: {
  onPhoto: () => void
  onVoice: () => void
  onMenu: () => void
  onBarcode: () => void
  onCancel: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-end bg-black/60 p-6 pb-10">
      <div className="glass-card flex w-full max-w-xs flex-col gap-2 p-4">
        <p className="mb-1 text-center text-caption uppercase tracking-wide text-text-tertiary">Log a meal</p>
        <button
          onClick={onPhoto}
          className="glass flex items-center justify-center gap-2 rounded-full px-6 py-3 text-subtitle font-semibold text-accent-health shadow-[0_0_24px_4px_var(--glow-health)] transition active:scale-95"
        >
          <span aria-hidden>📷</span> Photo
        </button>
        <button
          onClick={onVoice}
          className="glass flex items-center justify-center gap-2 rounded-full px-6 py-3 text-subtitle font-semibold text-accent-ai shadow-[0_0_24px_4px_var(--glow-ai)] transition active:scale-95"
        >
          <span aria-hidden>🎙️</span> Voice
        </button>
        <button
          onClick={onMenu}
          className="glass flex items-center justify-center gap-2 rounded-full px-6 py-3 text-subtitle font-semibold text-accent-energy shadow-[0_0_24px_4px_var(--glow-energy)] transition active:scale-95"
        >
          <span aria-hidden>🍽️</span> Eating Out
        </button>
        <button
          onClick={onBarcode}
          className="glass flex items-center justify-center gap-2 rounded-full px-6 py-3 text-subtitle font-semibold text-text-primary shadow-[0_0_24px_4px_rgb(255_255_255/0.15)] transition active:scale-95"
        >
          <span aria-hidden>📦</span> Barcode
        </button>
        <button onClick={onCancel} className="mt-1 text-caption text-text-tertiary underline">
          Cancel
        </button>
      </div>
    </div>
  )
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}
