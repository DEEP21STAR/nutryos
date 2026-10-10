import { useEffect, useState } from 'react'
import { Images, Zap, Palette, Snowflake, Crown, ShieldCheck, Download, FlaskConical, CircleHelp } from 'lucide-react'
import { applyTheme, type Theme } from '@/lib/theme'
import { applyAccentColor, ACCENT_PRESETS, type AccentColor } from '@/lib/accentColor'
import { AvatarPicker } from '@/components/AvatarPicker'
import { isPremiumUnlocked, setPremiumUnlocked } from '@/lib/premium'
import { saveDisplayName } from '@/lib/avatarRepo'
import { isAnonymousAccount, isGoogleLinked, linkGoogleAccount } from '@/lib/accountLink'
import { downloadJson, exportUserData } from '@/lib/dataExport'
import { LegalPage } from '@/components/LegalPage'
import { getCloudAiOptIn, setCloudAiOptIn } from '@/lib/cloudAi'

const PREMIUM_FEATURES = [
  { Icon: Images, text: 'Full progress-photo history (free: most recent 10)' },
  { Icon: Snowflake, text: 'Bank up to 3 streak freezes (free: 1)' },
  { Icon: FlaskConical, text: 'Full micronutrient breakdown (free: 4 key nutrients)' },
  { Icon: Zap, text: 'Priority AI food recognition' },
  { Icon: Palette, text: 'Custom app themes as they ship' },
]

interface SettingsPanelProps {
  onClose: () => void
  theme: Theme
  onThemeChange: (theme: Theme) => void
  accentColor: AccentColor
  onAccentColorChange: (accent: AccentColor) => void
  needRefresh: boolean
  onUpdate: () => void
  onCheckForUpdates: () => Promise<boolean>
  userId: string | null
  avatarUrl: string | null
  onAvatarChange: (avatar: string) => void
  displayName: string | null
  onDisplayNameChange: (name: string) => void
  onOpenHelp: () => void
  onReplayTour: () => void
}

/**
 * Full-screen Settings — theme choice, build identity, and a real update check. The build
 * number/hash are injected at build time by vite.config.ts's `define` (real git commit count +
 * short hash), never hand-typed, so this can't silently go stale like a manually bumped version
 * string would.
 */
export function SettingsPanel({
  onClose,
  theme,
  onThemeChange,
  accentColor,
  onAccentColorChange,
  needRefresh,
  onUpdate,
  onCheckForUpdates,
  userId,
  avatarUrl,
  onAvatarChange,
  displayName,
  onDisplayNameChange,
  onOpenHelp,
  onReplayTour,
}: SettingsPanelProps) {
  const [checkState, setCheckState] = useState<'idle' | 'checking' | 'up-to-date'>('idle')
  const [nameInput, setNameInput] = useState(displayName ?? '')
  const [savingName, setSavingName] = useState(false)
  const [googleLinked, setGoogleLinked] = useState<boolean | null>(null)
  const [linkingGoogle, setLinkingGoogle] = useState(false)
  const [linkError, setLinkError] = useState<string | null>(null)
  const [exportingData, setExportingData] = useState(false)
  const [cloudAi, setCloudAi] = useState(getCloudAiOptIn)

  useEffect(() => {
    isGoogleLinked().then(setGoogleLinked)
  }, [])

  async function handleLinkGoogle() {
    setLinkingGoogle(true)
    setLinkError(null)
    try {
      const stillAnonymous = await isAnonymousAccount()
      if (!stillAnonymous) {
        setGoogleLinked(true)
        return
      }
      await linkGoogleAccount() // redirects the browser away on success
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : 'Could not start the Google link.')
      setLinkingGoogle(false)
    }
  }

  async function handleExportData() {
    if (!userId) return
    setExportingData(true)
    try {
      const data = await exportUserData(userId, displayName)
      downloadJson(data, `nutryos-data-${new Date().toISOString().slice(0, 10)}.json`)
      flashToast('Data downloaded')
    } catch (err) {
      flashToast(err instanceof Error ? err.message : 'Export failed')
    } finally {
      setExportingData(false)
    }
  }
  // Every setting here applies instantly (no explicit Save action) — that's correct behavior,
  // but tapping something and seeing nothing happen looks exactly like it silently failed. This
  // toast is the fix: real, if quiet, confirmation instead of just trusting the selected-border
  // state to be noticed. Real user report (2026-09-18): "when you go back, it doesn't change
  // anything" — the change WAS saved (verified against the live site), the feedback just wasn't
  // visible enough to register as "this worked."
  const [toast, setToast] = useState<string | null>(null)
  function flashToast(text: string) {
    setToast(text)
    setTimeout(() => setToast(null), 1600)
  }

  const [premium, setPremium] = useState(isPremiumUnlocked)
  const [showLegal, setShowLegal] = useState(false)

  async function handleCheck() {
    setCheckState('checking')
    const found = await onCheckForUpdates()
    setCheckState(found ? 'idle' : 'up-to-date')
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col overflow-y-auto bg-bg-primary text-text-primary">
      <div className="glass sticky top-0 z-10 flex items-center justify-between px-4 pt-[calc(env(safe-area-inset-top,0px)+12px)] pb-3">
        <button onClick={onClose} className="text-caption text-text-tertiary">
          Close
        </button>
        <h2 className="text-caption uppercase tracking-wide text-text-secondary">Settings</h2>
        <div className="w-12" />
      </div>

      <div className="mx-4 mt-6 flex flex-col gap-4">
        {userId && (
          <section className="glass-card flex flex-col gap-3 p-4">
            <h3 className="text-body font-semibold">Profile</h3>
            <AvatarPicker
              userId={userId}
              avatarUrl={avatarUrl}
              onChange={(avatar) => {
                onAvatarChange(avatar)
                flashToast('Profile picture saved')
              }}
            />
            <div className="flex flex-col gap-1.5">
              <label className="text-caption text-text-tertiary">
                Your name — shown in the footer's "Built with care for…" line
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  placeholder="Your name"
                  maxLength={40}
                  className="flex-1 rounded-xl border border-white/10 bg-bg-secondary px-3 py-2 text-body text-text-primary outline-none focus:border-accent-health"
                />
                <button
                  onClick={async () => {
                    setSavingName(true)
                    try {
                      await saveDisplayName(userId, nameInput)
                      onDisplayNameChange(nameInput)
                      flashToast('Name saved')
                    } catch (err) {
                      flashToast(err instanceof Error ? err.message : 'Failed to save name')
                    } finally {
                      setSavingName(false)
                    }
                  }}
                  disabled={savingName}
                  className="rounded-xl bg-accent-health px-4 py-2 text-caption font-semibold text-bg-primary disabled:opacity-50"
                >
                  {savingName ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          </section>
        )}

        <section className="glass-card flex flex-col gap-3 p-4">
          <h3 className="flex items-center gap-1.5 text-body font-semibold">
            <CircleHelp size={16} className="text-accent-ai" /> Help
          </h3>
          <button
            onClick={onOpenHelp}
            className="rounded-xl border border-accent-ai/40 bg-accent-ai/10 py-3 text-body font-semibold text-accent-ai"
          >
            How NUTRYOS works
          </button>
          <button
            onClick={onReplayTour}
            className="rounded-xl border border-white/10 bg-bg-secondary py-3 text-body text-text-secondary"
          >
            Replay the quick tour
          </button>
        </section>

        <section className="glass-card flex flex-col gap-3 p-4">
          <h3 className="text-body font-semibold">Appearance</h3>
          <div className="grid grid-cols-2 gap-3">
            {(['dark', 'light'] as const).map((opt) => (
              <button
                key={opt}
                onClick={() => {
                  applyTheme(opt)
                  onThemeChange(opt)
                  flashToast(`${opt === 'light' ? 'Light' : 'Dark'} theme saved`)
                }}
                className={`rounded-xl border px-4 py-3 text-body capitalize transition-colors ${
                  theme === opt
                    ? 'border-accent-health bg-accent-health/10 text-text-primary'
                    : 'border-white/10 bg-bg-secondary text-text-secondary'
                }`}
              >
                {opt}
              </button>
            ))}
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-caption text-text-tertiary">Accent color</span>
            <div className="flex gap-3">
              {(Object.keys(ACCENT_PRESETS) as AccentColor[]).map((key) => {
                const preset = ACCENT_PRESETS[key]
                return (
                  <button
                    key={key}
                    onClick={() => {
                      applyAccentColor(key)
                      onAccentColorChange(key)
                      flashToast(`${preset.label} accent saved`)
                    }}
                    aria-label={preset.label}
                    className="grid h-10 w-10 place-items-center rounded-full transition-transform active:scale-90"
                    style={{
                      background: preset.hex,
                      boxShadow: accentColor === key ? `0 0 0 3px var(--color-bg-secondary), 0 0 0 5px ${preset.hex}, 0 0 14px 2px ${preset.glow}` : 'none',
                    }}
                  />
                )
              })}
            </div>
          </div>
        </section>

        <section
          className="glass-card relative flex flex-col gap-3 overflow-hidden p-4"
          style={{ boxShadow: premium ? '0 0 24px -4px var(--glow-energy)' : undefined, borderColor: 'rgb(255 184 0 / 0.25)' }}
        >
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{ background: 'radial-gradient(120% 60% at 100% 0%, rgb(255 184 0 / 0.08), transparent 60%)' }}
          />
          <div className="relative flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Crown size={16} className="text-accent-energy" />
              <h3 className="text-body font-semibold">Premium</h3>
            </div>
            {premium && (
              <span className="rounded-full bg-accent-energy/15 px-2 py-0.5 text-caption font-semibold text-accent-energy">
                Unlocked
              </span>
            )}
          </div>
          <ul className="relative flex flex-col gap-2 text-caption text-text-secondary">
            {PREMIUM_FEATURES.map(({ Icon, text }) => (
              <li key={text} className="flex items-center gap-2">
                <Icon size={14} className="shrink-0 text-accent-energy" />
                {text}
              </li>
            ))}
          </ul>
          {premium ? (
            <button
              onClick={() => {
                setPremiumUnlocked(false)
                setPremium(false)
                flashToast('Premium turned off')
              }}
              className="rounded-xl border border-white/10 bg-bg-secondary py-3 text-body text-text-secondary"
            >
              Turn off Premium
            </button>
          ) : (
            <>
              <p className="text-caption text-text-tertiary">
                NUTRYOS stays free — Premium is donation-supported. Buying a coffee genuinely
                helps cover the AI vision costs and hosting, but it's still an honor system below —
                no purchase required to unlock.
              </p>
              <a
                href="https://buymeacoffee.com/nutryos"
                target="_blank"
                rel="noopener noreferrer"
                className="donation-pulse rounded-xl border bg-accent-energy/10 py-3 text-center text-body font-semibold text-accent-energy"
              >
                Buy me a coffee (Donation Link)
              </a>
              <button
                onClick={() => {
                  setPremiumUnlocked(true)
                  setPremium(true)
                  flashToast('Premium unlocked — thank you')
                }}
                className="rounded-xl bg-accent-energy py-3 text-body font-semibold text-bg-primary"
              >
                Unlock Premium
              </button>
            </>
          )}
        </section>

        <section className="glass-card flex flex-col gap-3 p-4">
          <h3 className="text-body font-semibold">Privacy</h3>
          <label className="flex items-center justify-between gap-3">
            <span className="text-body text-text-secondary">Cloud AI estimates</span>
            <input
              type="checkbox"
              role="switch"
              checked={cloudAi}
              onChange={(e) => {
                setCloudAiOptIn(e.target.checked)
                setCloudAi(e.target.checked)
                flashToast(e.target.checked ? 'Cloud AI estimates on' : 'Cloud AI estimates off')
              }}
              className="h-5 w-5 accent-accent-ai"
            />
          </label>
          <p className="text-caption text-text-tertiary">
            Off by default. When a food isn't in your foods, the NZ/AU food table or Open Food Facts, NUTRYOS can ask
            Google's free AI to estimate it. Only the food name and portion are sent, and Google may use them to improve
            their products. When this is off you'll be asked each time.
          </p>
        </section>

        <section className="glass-card flex flex-col gap-3 p-4">
          <h3 className="flex items-center gap-1.5 text-body font-semibold">
            <ShieldCheck size={16} className="text-accent-health" /> Account & Backup
          </h3>
          <p className="text-caption text-text-tertiary">
            NUTRYOS signs you in anonymously so there's nothing to set up — but that means clearing
            your browser data or switching devices loses access to everything below. Google backup
            fixes that without changing anything about your account.
          </p>

          {googleLinked ? (
            <p className="flex items-center gap-1.5 text-caption text-accent-health">
              <ShieldCheck size={14} /> Backed up via Google — recoverable on any device
            </p>
          ) : (
            <button
              onClick={handleLinkGoogle}
              disabled={linkingGoogle || googleLinked === null}
              className="rounded-xl border border-accent-health/40 bg-accent-health/10 py-3 text-body font-semibold text-accent-health disabled:opacity-50"
            >
              {linkingGoogle ? 'Opening Google…' : 'Back up with Google'}
            </button>
          )}
          {linkError && <p className="text-caption text-accent-danger">{linkError}</p>}

          <button
            onClick={handleExportData}
            disabled={exportingData}
            className="flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-bg-secondary py-3 text-body text-text-secondary disabled:opacity-50"
          >
            <Download size={16} /> {exportingData ? 'Preparing…' : 'Download your data'}
          </button>
        </section>

        <section className="glass-card flex flex-col gap-3 p-4">
          <h3 className="text-body font-semibold">About</h3>
          <div className="flex items-center justify-between">
            <span className="text-caption text-text-tertiary">Build</span>
            <span className="text-caption text-text-secondary">
              #{__BUILD_NUMBER__} · {__COMMIT_HASH__}
            </span>
          </div>

          {needRefresh ? (
            <button onClick={onUpdate} className="rounded-xl bg-accent-health py-3 text-body font-semibold text-bg-primary">
              Update available — tap to reload
            </button>
          ) : (
            <button
              onClick={handleCheck}
              disabled={checkState === 'checking'}
              className="rounded-xl border border-white/10 bg-bg-secondary py-3 text-body text-text-secondary disabled:opacity-60"
            >
              {checkState === 'checking'
                ? 'Checking…'
                : checkState === 'up-to-date'
                  ? "You're up to date"
                  : 'Check for updates'}
            </button>
          )}

          <a
            href="mailto:hello@whetudigital.co.nz"
            className="rounded-xl border border-white/10 bg-bg-secondary py-3 text-center text-body text-text-secondary"
          >
            Contact / feedback
          </a>
        </section>

        <section className="glass-card flex flex-col gap-3 p-4">
          <h3 className="text-body font-semibold">Legal</h3>
          <button
            onClick={() => setShowLegal(true)}
            className="rounded-xl border border-white/10 bg-bg-secondary py-3 text-body text-text-secondary"
          >
            Privacy Policy &amp; Terms of Use
          </button>
        </section>
      </div>

      {showLegal && <LegalPage onClose={() => setShowLegal(false)} />}

      {toast && (
        <div className="pointer-events-none fixed inset-x-0 bottom-8 z-20 flex justify-center px-4">
          <span className="rounded-full bg-accent-health px-4 py-2 text-caption font-semibold text-bg-primary shadow-lg">
            ✓ {toast}
          </span>
        </div>
      )}
    </div>
  )
}
