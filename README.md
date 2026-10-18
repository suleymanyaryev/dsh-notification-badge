# dsh-notification-badge

> Desktop, browser + webhook notifications **and an attention badge on the app icon** for
> [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) on **macOS · Linux · Windows**:
> know when your agent **finishes a turn**, **hits an error**, or is **waiting for your approval** —
> without watching the tab.

Long agent turns are the norm: you kick off a task, switch away, and come back to find the agent
finished five minutes ago — or worse, stuck on an approval prompt the whole time.
`dsh-notification-badge` listens to the harness's own lifecycle events, pings you the moment your
attention is needed, and keeps a count on the application icon while you are away.

## What it does

| Event | Trigger | Default |
|---|---|---|
| **Agent finished** | `agent/status` flips `running → idle`, and the turn ran ≥ `minTurnDurationMs` | on |
| **Agent error** | `agent/error` (a step or turn errored) | on |
| **Approval needed** | `approval/request` waterfall (observe-only; always delegates with `next()`) | on |
| **Waiting for you** | a session's `pendingInteraction` appears (browser half) | on |
| **App-icon badge** | either of the above while the window is not focused (desktop shell) | on |

Each event can go to:

- **Desktop notification** — zero dependencies: `osascript` (macOS), `notify-send` (Linux),
  PowerShell toast (Windows), optionally with a sound on macOS.
- **Browser notification** — the standard `Notification` API in the Web UI.
- **Webhook** — a JSON `POST` with a Slack-compatible `text` field, so a Slack incoming webhook
  works as-is. Other services need their own field: Discord, for example, ignores `text` and wants
  the same string as `content`, so point the webhook at a small relay (or a Slack-compatible
  bridge) when you need Discord messages.
- **App-icon badge** — the count of sessions that need you, on the macOS Dock tile, the Windows
  taskbar button, or the Linux launcher entry.

## Where each channel fires

| Channel | Runs on | Best for |
|---|---|---|
| Desktop (`desktop`) | the machine **running the `dsh` server** | `dsh web` on your own machine |
| Browser (`browser`) | the machine **viewing the Web UI** | a remote server, or any Web UI use |
| Badge (`badge`) | the machine **viewing the Web UI**, desktop shell only | seeing "3 things need you" at a glance |
| Webhook (`webhookUrl`) | wherever the URL points | phones, Slack, unattended runs |

Browser notifications ask for permission on your first click or keypress, and by default popups
appear **only while the window is hidden or unfocused** — a window you are looking at already has
your attention (set `browserOnlyWhenHidden: false` to change that).

The badge counts a session once, while the window is unfocused, and clears the moment you come
back — it means "things you have not looked at yet", not "unread messages". Sessions that stay
short (`minTurnDurationMs`) are ignored, and subagent sessions never notify or badge.

### Desktop and browser channels overlap on a local desktop

On the DeepSeek Harness **desktop app** the server and the page run on the same machine, so both
default-on channels fire for one event: a native `osascript`/`notify-send` notification from the
host **and** a page `Notification` (which Electron also renders natively). That is two popups per
turn. Keep one:

```yaml
# ~/.dsh/profiles/desktop/cordis.patch.yml
- id: notify-badge
  name: dsh-notification-badge
  config:
    desktop: false     # the page already notifies, and owns the app-icon badge
```

`desktop: true` is the right default for `dsh web` on a remote or headless machine, where the page
is somewhere else.

> **Do not run this together with `dsh-dock-badge`.** Both drive the same Badging API and each
> clears the icon when the page loads, so they overwrite each other's count. This plugin covers
> everything that one does (and reads pending interactions from `uiSession.sessionStatus`, which
> the session list does not expose), so keep only one of them enabled.

## Install

The package is a bundle: `dsh plugin add` writes the dependency and selects the bundle row.

```sh
# Web / headless profiles:
dsh plugin --profile web add dsh-notification-badge
```

The **desktop** profile is owned by the application: install it from **Settings → Plugins** in the
DeepSeek Harness app. `dsh plugin --profile desktop add …` also works, but only with the app fully
quit and the profile initialized once (`dsh` refuses to touch an uninitialized desktop profile).

The package ships plain ESM JavaScript — no build step, so a git or registry install needs no
`allowBuilds` entry. The Web UI picks the client bundle up on the next load.

<details>
<summary>Manual installation</summary>

Add the dependency to `~/.dsh/profiles/<profile>/package.json` and list it as a bundle:

```json
"dsh": { "profile": { "bundles": ["…", "dsh-notification-badge"] } }
```

</details>

## Configuration

Override the row in your profile's `cordis.patch.yml`:

```yaml
- id: notify-badge
  name: dsh-notification-badge
  config:
    minTurnDurationMs: 10000        # only notify for turns ≥ 10s
    webhookUrl: 'https://hooks.slack.com/services/XXX/YYY/ZZZ'
    notifyOnApproval: true
    desktop: true
    browser: true
    badge: true
    badgeMode: count                # count | dot
    title: 'DSH'
```

| Field | Type | Default | Meaning |
|---|---|---|---|
| `notifyOnIdle` | boolean | `true` | Notify when a turn finishes |
| `notifyOnError` | boolean | `true` | Notify on `agent/error` |
| `notifyOnApproval` | boolean | `true` | Notify when a tool call awaits approval |
| `minTurnDurationMs` | number | `5000` | Skip notifications for quick turns |
| `desktop` | boolean | `true` | Native desktop notification on the server host |
| `browser` | boolean | `true` | Browser `Notification` popups in the Web UI |
| `browserOnlyWhenHidden` | boolean | `true` | Suppress popups while you are looking at the window |
| `webhookUrl` | string | `''` | Optional POST target (Slack-compatible payload) |
| `title` | string | `'DeepSeek Harness'` | Title for desktop and browser notifications |
| `sound` | string | `'Glass'` | macOS: a system sound name (looked up in `~/Library/Sounds`, `/Library/Sounds`, `/System/Library/Sounds`) or an audio file path (absolute, or relative to `~/Library/Sounds`); `''` is silent |
| `windowsAppId` | string | `''` | Windows: AppUserModelID the toast is attributed to; empty uses the posting process's registered identity |
| `badge` | boolean | `true` | Put the attention count on the application icon |
| `badgeDesktopOnly` | boolean | `true` | Only badge in the desktop shell (a browser tab has no app icon) |
| `badgeMode` | `count` \| `dot` | `count` | Number of sessions, or an unnumbered dot |
| `badgeMaxCount` | number | `99` | Highest number rendered |
| `badgeOnIdle` | boolean | `true` | Count a finished turn |
| `badgeOnApproval` | boolean | `true` | Count a session waiting on you (including one already waiting at load) |
| `badgeClearOnFocus` | boolean | `true` | Clear the badge when the window is focused or visible again |

Every field is declared `.volatile()`, so the values are **live**: the `dsh-settings` document
serves them, and a change applies without a reload. `webhookUrl` is `role('secret')`, so its value
is stripped before settings cross the wire to the browser.

### Webhook payload

```json
{
  "text": "Agent finished — done in 2m 14s",
  "summary": "Agent finished",
  "body": "done in 2m 14s",
  "level": "info",
  "ts": "2026-08-21T12:34:56.000Z"
}
```

## The app-icon badge

The Dock tile belongs to the Electron **browser process**, so a host-side plugin can never touch it.
The renderer does not need to: **Electron implements the standard Badging API in the browser
process**, so `navigator.setAppBadge(n)` from the page reaches the same code path as
`app.setBadgeCount()` — no shell patch, no IPC channel, no preload hook. The API is
`[SecureContext]`, and the desktop shell serves the UI from `dsh-app://` (registered `secure: true`).

Three sharp edges, all handled:

- **Never call `setAppBadge(0)`.** Chromium treats a numeric zero as a protocol violation and
  Electron answers with `ReportBadMessage`, which terminates the renderer. Clearing always goes
  through `clearAppBadge()`.
- **Counts above 99 saturate** to a localized `99+`, so `badgeMaxCount` above 99 changes nothing.
- **The call rejects** with `NotAllowedError` when the document may not badge; the plugin swallows
  that and retries on the next change.

A browser tab gets no badge by default (`badgeDesktopOnly: true`): Chrome and Edge only badge
*installed* PWAs, so outside the desktop shell the call is inert at best.

If nothing appears in the Dock, check **System Settings → Notifications → DeepSeek Harness →
"Badge application icon"** — an app that was never granted notification permission has its badge
ignored by the system. To test the plumbing directly, from the app window's console:

```js
navigator.setAppBadge(7);   // badge shows "7"
navigator.clearAppBadge();  // badge disappears
```

## Design notes

- **Everything registered through `ctx` is an effect.** Cordis registers each listener through the
  plugin fiber, so they are removed automatically on unload/hot-reload; there is no manual cleanup
  path.
- **`approval/request` is a waterfall.** This plugin only observes it, so its listener always calls
  `next()` — returning without it would claim the decision (and resolve as `unavailable`), swallowing
  the real answerers.
- **The browser half reads its options from the settings document.** The client module system creates
  every browser plugin entry with `{ name: id }` and no config, so `apply` on the client receives no
  row config; the host half declares the options `.volatile()` and the client reads them back through
  `ctx.configForms.get('notify-badge')` — the same path official client plugins use. The entry id in
  `cordis.patch.yml` is that namespace, so if you rename the row, update `ENTRY_ID` in `client.js`.
- **Session status comes from `uiSession.sessionStatus`.** `sessions.list` rows carry `running` but
  not `pendingInteraction`; the status projection is the client's own view of
  `{ running, pendingInteraction, completionUnread }`, and a `pendingInteraction` is an object whose
  `kind` is `approval`, `question`, or `plan-review`.
- **A failed turn is never announced as a finish.** The loop emits `agent/error` and then flips the
  status to idle. The error is recorded before the `notifyOnError` gate, so the idle flip stays quiet
  whether error notifications are on (the error was already announced) or off (nothing is posted at
  all) — a failed turn is never reported as "Agent finished".
- **Subagents are filtered.** Sessions the harness marks `origin: "subagent"` never notify or badge.
  The host half learns that from `session/created`; the browser half can only read `origin` from the
  session list, so a session the list has not delivered yet stays untracked until it can be
  classified (and is adopted then, so an already-waiting session still badges).
- **An unserved settings namespace is reported.** If the profile row id and `ENTRY_ID` disagree, the
  client logs one warning instead of silently running on defaults.
- **Never break the loop.** Desktop spawns are detached and fire-and-forget; webhook failures are
  logged and swallowed. A notifier must never surface an error into the agent's turn.
- **The host half is the anchor.** A client bundle is only served while its package's host entry is
  active, so `index.js` is required even on a machine where only the browser half does anything.

## Compatibility

Verified against DeepSeek Harness **0.2.1-rc.2**, and `engines.dsh` declares `^0.2.1-rc.2`. The
installer refuses `dsh plugin add` for a package whose range does not match the running harness
(unless that exact `package@version` is version-exempted with `dsh plugin allow-version`); a bundle
that is already listed in a profile is only warned about, so the declared range is an install gate
rather than a load gate. `client.js` is hand-written in the shape the client module system expects,
so no build step and no source map are needed.

## Local development

From a checkout of this package:

```sh
npm install      # @deepseek-ai/schemastery, for the Config schema
npm test         # syntax check + host and browser-half tests
```

To run it inside a harness source checkout, point a patch file at this directory and start the Web UI:

```yaml
# dev.patch.yml (keep it out of version control)
- insert:
    - id: notify-badge
      name: dsh-notification-badge
      config:
        minTurnDurationMs: 0
```

```sh
pnpm dsh web --patch ./path/to/dev.patch.yml
```

Edits to `index.js` hot-reload without a restart; a rebuilt `client.js` is picked up on the next
page load.

## License

MIT. The notification half is derived from [`dsh-notification`](https://github.com/nishit130/dsh-notification)
by Nishit Patel, and the icon badge from `dsh-dock-badge`; both were MIT-licensed, and the original
copyright notice is retained in [LICENSE](LICENSE).
