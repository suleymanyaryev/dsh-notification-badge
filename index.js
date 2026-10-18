import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, isAbsolute, join } from 'node:path'
import { spawn as nodeSpawn } from 'node:child_process'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dsh-notification-badge'

/* --- configuration --------------------------------------------------------
 * Every field is `.volatile()`, which makes it a live reference in `apply`
 * (`config.title.get()`) instead of a plain value, and — more importantly —
 * publishes it in the host settings document.
 *
 * That is the only supported way for the browser half to see these options:
 * the client module system creates a browser plugin entry with `{ name: id }`
 * and no config (see `create()` in @deepseek-ai/dsh-client-modules), so cordis
 * hands `apply` on the client no row config at all. Official client plugins
 * read their live options through `ctx.configForms.get(<profile entry id>)`,
 * and the settings service serves exactly the volatile fields of active
 * entries (`describe()` in @deepseek-ai/dsh-settings). client.js therefore
 * reads the same document under the entry id this bundle inserts: `notify-badge`.
 *
 * `webhookUrl` additionally carries `role('secret')`, so its value is stripped
 * before settings cross the wire to the browser.
 * ------------------------------------------------------------------------ */
export const Config = Schema.object({
  notifyOnIdle: Schema.boolean().default(true)
    .description('Notify when an agent finishes a turn (status flips to idle).')
    .volatile(),
  notifyOnError: Schema.boolean().default(true)
    .description('Notify when a step or turn errors (agent/error).')
    .volatile(),
  notifyOnApproval: Schema.boolean().default(true)
    .description('Notify when a tool call is waiting for user approval.')
    .volatile(),
  minTurnDurationMs: Schema.number().default(5000)
    .description('Only notify for turns that ran at least this long, to skip quick replies.')
    .volatile(),
  desktop: Schema.boolean().default(true)
    .description('Show a native desktop notification on the machine running the dsh server (macOS/Linux/Windows).')
    .volatile(),
  browser: Schema.boolean().default(true)
    .description('Show browser Notification popups in the Web UI — fires on the machine viewing the page, so it works with a remote server.')
    .volatile(),
  browserOnlyWhenHidden: Schema.boolean().default(true)
    .description('Only show browser notifications while the window is hidden or unfocused; a window you are looking at already has your attention.')
    .volatile(),
  webhookUrl: Schema.string().default('')
    .description('Optional URL to POST a JSON payload to (Slack-compatible "text" field included).')
    .role('secret')
    .volatile(),
  title: Schema.string().default('DeepSeek Harness')
    .description('Title used for desktop and browser notifications.')
    .volatile(),
  sound: Schema.string().default('Glass')
    .description('macOS: sound played alongside each desktop notification — a system sound name such as "Glass" '
      + '(looked up in ~/Library/Sounds, /Library/Sounds and /System/Library/Sounds), or an audio file path '
      + '(absolute, or relative to ~/Library/Sounds). Empty string keeps notifications silent.')
    .volatile(),
  windowsAppId: Schema.string().default('')
    .description('Windows: the AppUserModelID the toast is attributed to. Empty uses the registered identity of '
      + 'the PowerShell process that posts it; set this to the application\'s own app id (for example '
      + '"com.deepseek.dsh") when toasts must appear under the application.')
    .volatile(),

  /* --- app-icon badge (browser half only) -------------------------------- */
  badge: Schema.boolean().default(true)
    .description('Put an attention count on the application icon (macOS Dock / Windows taskbar / Linux launcher) while you are away.')
    .volatile(),
  badgeDesktopOnly: Schema.boolean().default(true)
    .description('Only badge inside the desktop shell. A plain browser tab has no app icon of its own, '
      + 'and the Badging API there is inert at best — or would badge the browser.')
    .volatile(),
  badgeMode: Schema.union(['count', 'dot']).default('count')
    .description('"count" renders the number of sessions needing attention (saturating at badgeMaxCount); '
      + '"dot" renders an unnumbered dot.')
    .volatile(),
  badgeMaxCount: Schema.number().default(99)
    .description('Highest number rendered; larger counts keep showing this value.')
    .volatile(),
  badgeOnIdle: Schema.boolean().default(true)
    .description('Count a session when its turn finishes while the window is not focused.')
    .volatile(),
  badgeOnApproval: Schema.boolean().default(true)
    .description('Count a session that started waiting for input or approval.')
    .volatile(),
  badgeClearOnFocus: Schema.boolean().default(true)
    .description('Clear the badge as soon as the window is focused or becomes visible again.')
    .volatile(),
})

/* --- notification sounds --------------------------------------------------
 * A configured *file* plays through afplay, which reproduces the exact file
 * and needs no name lookup. A bare *name* (e.g. "Glass") is handed to
 * AppleScript's own `sound name`, which searches ~/Library/Sounds,
 * /Library/Sounds and /System/Library/Sounds.
 * ------------------------------------------------------------------------ */

const SOUND_DIRS = [join(homedir(), 'Library', 'Sounds'), '/Library/Sounds', '/System/Library/Sounds']
const AUDIO_EXTENSIONS = new Set(['.aif', '.aiff', '.caf', '.m4a', '.mp3', '.wav'])

function expandHome(sound) {
  return sound.startsWith('~/') ? join(homedir(), sound.slice(2)) : sound
}

/**
 * Whether a configured sound denotes a file (a path, or an audio extension to
 * look up in the sound directories) rather than a system sound name.
 */
function looksLikeFile(sound) {
  const expanded = expandHome(sound)
  return isAbsolute(expanded) || expanded.includes('/')
    || AUDIO_EXTENSIONS.has(extname(expanded).toLowerCase())
}

/** Resolve a configured sound to an existing audio file; null means "not a file". */
export function resolveSoundPath(sound) {
  if (!sound) return null
  if (!looksLikeFile(sound)) return null
  const expanded = expandHome(sound)
  const candidates = isAbsolute(expanded) ? [expanded] : SOUND_DIRS.map((dir) => join(dir, expanded))
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

/** Play an audio file detached; returns whether a file was found. Never throws. */
function playSound(spawn, sound) {
  const path = resolveSoundPath(sound)
  if (!path) return false
  try {
    spawn('afplay', [path], { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
    return true
  } catch {
    return false
  }
}

/**
 * Fire a native desktop notification without any dependency:
 * osascript on macOS, notify-send on Linux, a PowerShell toast on Windows.
 *
 * Failures are swallowed — a notifier must never break the agent loop.
 * spawn() failures (missing binary, EACCES, …) are delivered ASYNCHRONOUSLY
 * as an `'error'` event on the returned ChildProcess, so a try/catch around
 * the synchronous spawn() call cannot catch them. Without an `'error'`
 * listener, Node rethrows the event and kills the whole dsh process — which
 * is exactly what happens on headless Linux with no `notify-send` installed.
 * We attach a no-op `'error'` listener on every platform branch to make sure
 * a missing or failing notifier binary can never take the host down.
 *
 * `deps.spawn` is injectable so the regression test can simulate an async
 * ENOENT without mutating `node:child_process` (a frozen built-in namespace),
 * and `deps.platform` so the Windows branch is testable off Windows. `deps.sound`
 * is the macOS sound: a file plays via afplay, a bare name is passed to
 * AppleScript as `sound name`.
 */
export function desktopNotify(title, body, { spawn = nodeSpawn, sound = '', windowsAppId = '', platform = process.platform } = {}) {
  try {
    if (platform === 'darwin') {
      const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      const played = playSound(spawn, sound)
      // `sound name` is a *name* looked up in the system sound directories, so
      // a configured path that did not resolve must not be handed to it.
      const soundClause = sound && !played && !looksLikeFile(sound) ? ` sound name "${esc(sound)}"` : ''
      spawn('osascript', ['-e', `display notification "${esc(body)}" with title "${esc(title)}"${soundClause}`],
        { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
    } else if (platform === 'linux') {
      spawn('notify-send', [title, body], { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
    } else if (platform === 'win32') {
      const esc = (s) => String(s).replace(/'/g, "''")
      // CreateToastNotifier() takes an optional AppUserModelID, NOT the toast
      // text: an unregistered id (such as the notification title) makes Windows
      // drop the toast silently. With no id the notifier uses the registered
      // identity of the calling process, which is why the title is never passed
      // here; `windowsAppId` lets a deployment attribute toasts to its own app.
      const appId = windowsAppId ? `'${esc(windowsAppId)}'` : ''
      const ps = [
        "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;",
        "$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);",
        `$t.GetElementsByTagName('text').Item(0).AppendChild($t.CreateTextNode('${esc(title)}')) | Out-Null;`,
        `$t.GetElementsByTagName('text').Item(1).AppendChild($t.CreateTextNode('${esc(body)}')) | Out-Null;`,
        `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${appId}).Show([Windows.UI.Notifications.ToastNotification]::new($t));`,
      ].join(' ')
      spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
        { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
    }
  } catch {}
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

export function apply(ctx, config) {
  // Live turn state per agent: when the current turn started and whether its
  // failure was already announced. A WeakMap keeps disposed agents collectable
  // even if `agent/disposed` never arrives.
  const turns = new WeakMap()

  // Sessions the harness marks as subagents. They are internal: their turns
  // would otherwise ping you for every delegated step. `session/created` and
  // `session/disposed` deliver the documented Session, whose header carries
  // `origin`; `agent/status` only carries the agent's session id.
  const subagents = new Set()
  ctx.on('session/created', (session) => {
    if (session?.header?.origin === 'subagent') subagents.add(session.id)
  })
  ctx.on('session/disposed', (session) => {
    subagents.delete(session.id)
  })

  function notify(summary, body, level) {
    const text = body ? `${summary} — ${body}` : summary
    if (config.desktop.get()) {
      desktopNotify(config.title.get(), text, {
        sound: config.sound.get(),
        windowsAppId: config.windowsAppId.get(),
      })
    }
    const webhookUrl = config.webhookUrl.get()
    if (webhookUrl) {
      fetch(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, summary, body, level, ts: new Date().toISOString() }),
        signal: AbortSignal.timeout(10_000),
      }).catch((error) => {
        // Never let a webhook failure surface into the agent loop — but a
        // silently dead webhook is undiagnosable, so log it once per failure.
        ctx.logger(name).warn('webhook POST failed: %s', error?.message ?? error)
      })
    }
  }

  // Turn finished: agent/status flips running -> idle (emit mode).
  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'running') {
      turns.set(agent, { startedAt: Date.now(), errored: false })
      return
    }
    const turn = turns.get(agent)
    turns.delete(agent)
    if (!turn || subagents.has(agent.id) || !config.notifyOnIdle.get()) return
    // A failed turn is never announced as a finish: `agent/error` fires first
    // and the idle flip after it stays quiet, whether or not error
    // notifications are enabled (the error handler marks the turn either way).
    if (turn.errored) return
    const elapsed = Date.now() - turn.startedAt
    if (elapsed < config.minTurnDurationMs.get()) return
    notify('Agent finished', `done in ${formatDuration(elapsed)}`, 'info')
  })

  // A step or turn errored (emit mode).
  ctx.on('agent/error', ({ agent, error, turn, step }) => {
    // Remember the failure FIRST, whatever the notification settings say: the
    // loop emits agent/error and only then flips the status to idle, and a turn
    // that failed must never be announced as "Agent finished" below.
    const current = turns.get(agent)
    if (current) current.errored = true
    if (!config.notifyOnError.get()) return
    if (subagents.has(agent.id)) return
    const detail = String(error?.message ?? error ?? 'unknown error').slice(0, 200)
    notify('Agent error', `turn ${turn}, step ${step}: ${detail}`, 'error')
  })

  // A tool call awaits approval. approval/request is a WATERFALL: this
  // listener only observes, so it must delegate with next() — returning
  // without it would claim the decision and swallow real answerers (a
  // non-vocabulary return resolves to "unavailable").
  ctx.on('approval/request', (req, next) => {
    if (config.notifyOnApproval.get()) {
      // displayReason is the localized presentation text the asker supplied;
      // reason is the logged one.
      const reason = req.displayReason?.en ?? req.reason
      const detail = reason ? `${req.toolName} — ${reason}` : req.toolName
      notify('Approval needed', detail, 'warn')
    }
    return next()
  })

  // Drop timing state for agents that leave the registry.
  ctx.on('agent/disposed', ({ agent }) => {
    turns.delete(agent)
  })

  // The badge lives entirely in the browser half: only a document can reach
  // the Badging API, and Electron forwards those calls from the renderer to
  // the browser process that owns the Dock tile / taskbar button. Nothing in
  // this process can touch the icon, so there is no host-side badge code.
  //
  // The browser half of a client package is only served while this host entry
  // is active, so this file is the anchor the badge rides on — it is never
  // optional, even where it has no behaviour of its own.

  // All listeners above are effects on ctx: cordis registers them through the
  // plugin fiber, so they are removed automatically when this plugin unloads
  // or hot-reloads. No manual cleanup needed.
}
