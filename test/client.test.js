import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/**
 * Load the browser bundle the way the client module system does: execute it
 * with a `window.__ModuleLoader__` facade, keep the registered definition, and
 * instantiate the factory. `new Function` parameters stand in for the browser
 * globals, so no DOM is needed.
 */
function createHarness({ settings = null, settingsStatus = 'ready', desktop = false, permission = 'granted', visible = false, focused = false, status: initialStatus = {}, listPhase = 'ready' } = {}) {
  let definition
  const notifications = []
  function Notification(title, options) {
    notifications.push({ title, body: options.body, tag: options.tag })
  }
  Notification.permission = permission
  Notification.requestPermission = () => Promise.resolve(permission)

  const badgeCalls = []
  const navigator = {
    setAppBadge(value) {
      badgeCalls.push(value === undefined ? { kind: 'dot' } : { kind: 'set', value })
      return Promise.resolve()
    },
    clearAppBadge() {
      badgeCalls.push({ kind: 'clear' })
      return Promise.resolve()
    },
  }

  const documentListeners = new Map()
  const windowListeners = new Map()
  function listen(store, type, fn) {
    if (!store.has(type)) store.set(type, [])
    store.get(type).push(fn)
  }
  function unlisten(store, type, fn) {
    const list = store.get(type)
    if (list === undefined) return
    const index = list.indexOf(fn)
    if (index >= 0) list.splice(index, 1)
  }
  function emit(store, type) {
    for (const fn of [...(store.get(type) ?? [])]) fn()
  }

  const document = {
    visibilityState: visible ? 'visible' : 'hidden',
    hasFocus: () => focused,
    addEventListener: (type, fn) => listen(documentListeners, type, fn),
    removeEventListener: (type, fn) => unlisten(documentListeners, type, fn),
  }
  const window = {
    __ModuleLoader__: { load: (value) => { definition = value } },
    addEventListener: (type, fn) => listen(windowListeners, type, fn),
    removeEventListener: (type, fn) => unlisten(windowListeners, type, fn),
    focus: () => {},
  }

  const statusListeners = new Set()
  let statusMap = new Map(Object.entries(initialStatus).map(([id, row]) => [id, {
    running: row.running === true,
    pendingInteraction: row.pendingInteraction,
    completionUnread: row.completionUnread === true,
  }]))
  const status = {
    getSnapshot: () => statusMap,
    subscribe(fn) {
      statusListeners.add(fn)
      return () => statusListeners.delete(fn)
    },
  }

  let rowsById = {}
  let phase = listPhase
  const listListeners = new Set()
  const list = {
    getSnapshot: () => ({ ids: Object.keys(rowsById), byId: rowsById, phase }),
    subscribe(fn) {
      listListeners.add(fn)
      return () => listListeners.delete(fn)
    },
  }
  /** A ready list knows every session the status projection reports. */
  function learnRows() {
    if (phase !== 'ready') return
    for (const id of statusMap.keys()) if (rowsById[id] === undefined) rowsById[id] = { id }
  }
  learnRows()

  /** Merge rows into the status projection (a real store keeps every session). */
  function setStatus(entries, { replace = false } = {}) {
    const next = replace ? new Map() : new Map(statusMap)
    for (const [id, row] of Object.entries(entries)) {
      next.set(id, {
        running: row.running === true,
        pendingInteraction: row.pendingInteraction,
        completionUnread: row.completionUnread === true,
      })
    }
    statusMap = next
    learnRows()
    for (const fn of [...statusListeners]) fn()
  }

  function setRows(rows, { phase: next = 'ready' } = {}) {
    rowsById = rows
    phase = next
    for (const fn of [...listListeners]) fn()
  }

  const formNamespaces = []
  const warnings = []
  const consoleWarnings = []
  const fakeConsole = {
    warn: (...args) => consoleWarnings.push(args.join(' ')),
    error: () => {},
    log: () => {},
  }
  let formValues = settings === null ? null : { ...settings }
  const formListeners = new Set()
  const configForms = settings === null ? undefined : {
    get(namespace) {
      formNamespaces.push(namespace)
      return {
        getSnapshot: () => ({
          status: settingsStatus,
          value: formValues,
        }),
        subscribe(fn) {
          formListeners.add(fn)
          return () => formListeners.delete(fn)
        },
      }
    },
  }
  function updateSettings(patch) {
    formValues = { ...formValues, ...patch }
    for (const fn of [...formListeners]) fn()
  }

  const services = {
    sessions: { list },
    uiSession: { sessionStatus: status },
    configForms,
  }
  const disposers = []
  const childContext = {
    get: (name) => services[name],
    sessions: services.sessions,
    uiSession: services.uiSession,
    logger: { warn: (...args) => warnings.push(args.join(' ')) },
    // Nested optional waits resolve immediately in the harness: the services
    // this bundle asks for are either present in `services` or intentionally
    // absent (no configForms client).
    inject(names, callback) {
      if (names.every((name) => services[name] !== undefined)) callback(childContext)
    },
    effect(fn) {
      disposers.push(fn())
    },
  }
  const ctx = {
    get: (name) => services[name],
    logger: { warn: (...args) => warnings.push(args.join(' ')) },
    inject(_names, callback) {
      callback(childContext)
    },
  }

  const globals = desktop ? { dshDesktop: { protocolVersion: 1, deviceInfo: () => Promise.resolve({}) } } : {}
  const evaluate = new Function('window', 'document', 'navigator', 'Notification', 'globalThis', 'console', SOURCE)
  evaluate(window, document, navigator, Notification, globals, fakeConsole)

  const module = definition.factory(() => { throw new Error('the bundle requires no modules') })
  module.apply(ctx, undefined)

  // Starting from a clean slate is part of the contract: the badge means
  // "things you have not looked at since this page loaded", so the first render
  // clears whatever an earlier page left on the icon. That single clear is
  // infrastructure — asserted once — and removed here so every other test reads
  // as "what this plugin did afterwards". A session already waiting at load
  // time legitimately sets the badge during that same first render, so those
  // writes stay visible.
  const startupBadgeCalls = badgeCalls.splice(0, badgeCalls.length)
  const clearedOnStart = startupBadgeCalls.length > 0 && startupBadgeCalls[0].kind === 'clear'
  if (clearedOnStart) startupBadgeCalls.shift()
  badgeCalls.push(...startupBadgeCalls)

  return {
    definition,
    module,
    notifications,
    badgeCalls,
    startupBadgeCalls,
    clearedOnStart,
    formNamespaces,
    warnings,
    consoleWarnings,
    setStatus,
    setRows,
    updateSettings,
    setVisible(value) {
      document.visibilityState = value ? 'visible' : 'hidden'
      emit(documentListeners, 'visibilitychange')
    },
    setFocused(value) {
      document.hasFocus = () => value
    },
    focus() {
      emit(windowListeners, 'focus')
    },
    statusListenerCount: () => statusListeners.size,
    dispose() {
      for (const dispose of disposers) dispose()
    },
  }
}

/* --- registration --------------------------------------------------------- */

test('the bundle registers the package name and leaves top-level inject empty', () => {
  const harness = createHarness()
  assert.equal(harness.definition.id, 'dsh-notification-badge')
  assert.equal(typeof harness.module.apply, 'function')
  // A pending top-level injection fails the Web boot audit; the services are
  // awaited in a child fiber instead.
  assert.deepEqual(harness.module.inject, [])
})

test('options come from the settings namespace of the profile entry id', () => {
  const harness = createHarness({ settings: { minTurnDurationMs: 0 } })
  assert.ok(harness.formNamespaces.length > 0)
  assert.deepEqual([...new Set(harness.formNamespaces)], ['notify-badge'])
})

test('the first render clears a badge left behind by an earlier page', () => {
  const harness = createHarness({ desktop: true })
  assert.equal(harness.clearedOnStart, true)
  assert.deepEqual(harness.badgeCalls, [])
})

/* --- browser notifications ------------------------------------------------ */

test('a finished turn notifies while the window is hidden', () => {
  const harness = createHarness({ settings: { minTurnDurationMs: 0 } })
  harness.setStatus({ s1: { running: true } })
  harness.setStatus({ s1: { running: false } })
  assert.equal(harness.notifications.length, 1)
  assert.match(harness.notifications[0].body, /^Agent finished/)
  assert.equal(harness.notifications[0].title, 'DeepSeek Harness')
})

test('the minimum turn duration gates quick turns', () => {
  const harness = createHarness()
  harness.setStatus({ s1: { running: true } })
  harness.setStatus({ s1: { running: false } })
  assert.deepEqual(harness.notifications, [])
})

test('a waiting approval notifies with the requesting tool', () => {
  const harness = createHarness({ settings: { minTurnDurationMs: 0 } })
  harness.setStatus({ s1: { running: true } })
  harness.setStatus({ s1: { running: true, pendingInteraction: { kind: 'approval', toolName: 'Bash' } } })
  assert.equal(harness.notifications.length, 1)
  assert.equal(harness.notifications[0].body, 'Waiting for approval — Bash')
})

test('questions and plan reviews are described in words', () => {
  const harness = createHarness({ settings: { minTurnDurationMs: 0 } })
  harness.setStatus({ s1: { running: true }, s2: { running: true } })
  harness.setStatus({
    s1: { running: true, pendingInteraction: { kind: 'question' } },
    s2: { running: true, pendingInteraction: { kind: 'plan-review' } },
  })
  assert.deepEqual(harness.notifications.map((n) => n.body).sort(), ['Waiting for plan review', 'Waiting for your answer'])
})

test('a visible window you are looking at stays quiet', () => {
  const harness = createHarness({ settings: { minTurnDurationMs: 0 }, visible: true, focused: true })
  harness.setStatus({ s1: { running: true } })
  harness.setStatus({ s1: { running: false } })
  assert.deepEqual(harness.notifications, [])
})

test('subagent sessions never notify', () => {
  const harness = createHarness({ settings: { minTurnDurationMs: 0 } })
  harness.setRows({ s9: { id: 's9', origin: 'subagent' } })
  harness.setStatus({ s9: { running: true } })
  harness.setStatus({ s9: { running: false } })
  assert.deepEqual(harness.notifications, [])
})

test('a session the list cannot classify yet is neither notified nor badged', () => {
  // While the list is still loading, `origin` is unknown: acting on the session
  // would ping you for a subagent turn, so it stays untracked until the list
  // names it. Its later turns notify normally.
  const harness = createHarness({ settings: { minTurnDurationMs: 0 }, desktop: true, listPhase: 'pending' })
  harness.setStatus({ s1: { running: true } })
  harness.setStatus({ s1: { running: false } })
  assert.deepEqual(harness.notifications, [])
  assert.deepEqual(harness.badgeCalls, [])

  harness.setRows({ s1: { id: 's1' } })
  harness.setStatus({ s1: { running: true } })
  harness.setStatus({ s1: { running: false } })
  assert.equal(harness.notifications.length, 1)
})

test('a session already waiting when the list loads is adopted, a subagent is not', () => {
  const harness = createHarness({ settings: { minTurnDurationMs: 0 }, desktop: true, listPhase: 'pending' })
  harness.setStatus({
    s1: { running: true, pendingInteraction: { kind: 'approval', toolName: 'Bash' } },
    s9: { running: true, pendingInteraction: { kind: 'approval' } },
  })
  assert.deepEqual(harness.badgeCalls, [])
  harness.setRows({ s1: { id: 's1' }, s9: { id: 's9', origin: 'subagent' } })
  assert.deepEqual(harness.badgeCalls, [{ kind: 'set', value: 1 }])
})

test('browser: false disables popups but not the badge', () => {
  const harness = createHarness({ settings: { minTurnDurationMs: 0, browser: false }, desktop: true })
  harness.setStatus({ s1: { running: true } })
  harness.setStatus({ s1: { running: false } })
  assert.deepEqual(harness.notifications, [])
  assert.deepEqual(harness.badgeCalls, [{ kind: 'set', value: 1 }])
})

/* --- app-icon badge ------------------------------------------------------- */

test('the badge counts sessions needing attention and clears on focus', () => {
  const harness = createHarness({ settings: { minTurnDurationMs: 0 }, desktop: true })
  harness.setStatus({ s1: { running: true } })
  harness.setStatus({ s1: { running: false } })
  assert.deepEqual(harness.badgeCalls, [{ kind: 'set', value: 1 }])
  harness.focus()
  assert.deepEqual(harness.badgeCalls, [{ kind: 'set', value: 1 }, { kind: 'clear' }])
})

test('the badge never calls setAppBadge(0)', () => {
  const harness = createHarness({ settings: { minTurnDurationMs: 0 }, desktop: true })
  harness.setStatus({ s1: { running: true } })
  harness.setStatus({ s1: { running: false } })
  harness.focus()
  for (const call of harness.badgeCalls) {
    assert.notEqual(call.value, 0)
  }
})

test('a plain browser tab gets no badge by default', () => {
  const harness = createHarness({ settings: { minTurnDurationMs: 0 } })
  harness.setStatus({ s1: { running: true } })
  harness.setStatus({ s1: { running: false } })
  assert.deepEqual(harness.badgeCalls, [])
})

test('a waiting approval counts once, and only once', () => {
  const harness = createHarness({ settings: { minTurnDurationMs: 0 }, desktop: true })
  harness.setStatus({ s1: { running: true } })
  harness.setStatus({ s1: { running: true, pendingInteraction: { kind: 'approval', toolName: 'Bash' } } })
  harness.setStatus({ s1: { running: true, pendingInteraction: { kind: 'approval', toolName: 'Bash' } } })
  assert.deepEqual(harness.badgeCalls, [{ kind: 'set', value: 1 }])
})

test('dot mode renders an unnumbered badge', () => {
  const harness = createHarness({ settings: { minTurnDurationMs: 0, badgeMode: 'dot' }, desktop: true })
  harness.setStatus({ s1: { running: true } })
  harness.setStatus({ s1: { running: false } })
  assert.deepEqual(harness.badgeCalls, [{ kind: 'dot' }])
})

test('badgeMaxCount saturates the rendered count', () => {
  const harness = createHarness({ settings: { minTurnDurationMs: 0, badgeMaxCount: 2 }, desktop: true })
  harness.setStatus({ s1: { running: true }, s2: { running: true }, s3: { running: true } })
  harness.setStatus({ s1: { running: false } })
  harness.setStatus({ s2: { running: false } })
  harness.setStatus({ s3: { running: false } })
  assert.deepEqual(harness.badgeCalls, [{ kind: 'set', value: 1 }, { kind: 'set', value: 2 }])
})

test('badge: false leaves the icon alone', () => {
  const harness = createHarness({ settings: { minTurnDurationMs: 0, badge: false }, desktop: true })
  harness.setStatus({ s1: { running: true } })
  harness.setStatus({ s1: { running: false } })
  assert.deepEqual(harness.badgeCalls, [])
})

test('a session already waiting when the UI loads counts, unless you are looking', () => {
  const waiting = { s1: { running: true, pendingInteraction: { kind: 'question' } } }
  const asleep = createHarness({ settings: { minTurnDurationMs: 0 }, desktop: true, status: waiting })
  assert.deepEqual(asleep.badgeCalls, [{ kind: 'set', value: 1 }])

  const watching = createHarness({ settings: { minTurnDurationMs: 0 }, desktop: true, status: waiting, visible: true, focused: true })
  assert.deepEqual(watching.badgeCalls, [])
})

test('sessions that disappear stop wanting attention', () => {
  const harness = createHarness({ settings: { minTurnDurationMs: 0 }, desktop: true })
  harness.setStatus({ s1: { running: true }, s2: { running: true } })
  harness.setStatus({ s1: { running: false }, s2: { running: false } })
  assert.deepEqual(harness.badgeCalls, [{ kind: 'set', value: 2 }])
  harness.setStatus({}, { replace: true })
  assert.deepEqual(harness.badgeCalls, [{ kind: 'set', value: 2 }, { kind: 'clear' }])
})

/* --- live options, capability and cleanup --------------------------------- */

test('a live settings edit re-renders the badge', () => {
  const harness = createHarness({ settings: { minTurnDurationMs: 0, badgeMode: 'count' }, desktop: true })
  harness.setStatus({ s1: { running: true } })
  harness.setStatus({ s1: { running: false } })
  assert.deepEqual(harness.badgeCalls, [{ kind: 'set', value: 1 }])
  harness.updateSettings({ badgeMode: 'dot' })
  assert.deepEqual(harness.badgeCalls, [{ kind: 'set', value: 1 }, { kind: 'dot' }])
})

test('without the settings client the schema defaults still work', () => {
  const harness = createHarness({ desktop: true })
  assert.deepEqual(harness.formNamespaces, [])
  harness.setStatus({ s1: { running: true } })
  harness.setStatus({ s1: { running: false } })
  // Default minTurnDurationMs is 5000, so a 0 ms turn stays quiet.
  assert.deepEqual(harness.notifications, [])
  assert.deepEqual(harness.badgeCalls, [])
})

test('an unserved settings namespace is reported once instead of silently defaulting', () => {
  // A profile row id that does not match ENTRY_ID makes every option fall back
  // to its default; that must not be invisible.
  const harness = createHarness({ settings: {}, settingsStatus: 'unavailable', desktop: true })
  assert.equal(harness.consoleWarnings.length, 1)
  assert.match(harness.consoleWarnings[0], /notify-badge/)
  // The framework logger is the canonical channel even though the Web
  // composition registers no exporter for it.
  assert.equal(harness.warnings.length, 1)
  harness.setStatus({ s1: { running: true } })
  harness.setStatus({ s1: { running: false } })
  assert.equal(harness.consoleWarnings.length, 1)
  assert.equal(harness.warnings.length, 1)
})

test('disposal unsubscribes and clears the badge', () => {
  const harness = createHarness({ settings: { minTurnDurationMs: 0 }, desktop: true })
  harness.setStatus({ s1: { running: true } })
  harness.setStatus({ s1: { running: false } })
  assert.equal(harness.statusListenerCount(), 1)
  harness.dispose()
  assert.equal(harness.statusListenerCount(), 0)
  assert.deepEqual(harness.badgeCalls, [{ kind: 'set', value: 1 }, { kind: 'clear' }])
})
