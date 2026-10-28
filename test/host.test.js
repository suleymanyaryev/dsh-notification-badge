import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Config, apply, desktopNotify, name, resolveSoundPath } from '../index.js'

/* --- config contract ------------------------------------------------------ */

test('plugin name matches the npm package name', () => {
  assert.equal(name, 'dsh-notification-badge')
})

test('every option the browser half reads is volatile', () => {
  // The client bundle has no config of its own: it reads these fields out of
  // the host settings document, and @deepseek-ai/dsh-settings only serves
  // volatile fields. Dropping `.volatile()` here silently breaks every option
  // in the browser half, so pin the contract down.
  const clientFields = [
    'notifyOnIdle',
    'notifyOnApproval',
    'minTurnDurationMs',
    'browser',
    'browserOnlyWhenHidden',
    'title',
    'badge',
    'badgeDesktopOnly',
    'badgeMode',
    'badgeMaxCount',
    'badgeOnIdle',
    'badgeOnApproval',
    'badgeClearOnFocus',
  ]
  for (const field of clientFields) {
    assert.equal(Config.dict[field]?.meta?.volatile, true, `${field} must be volatile`)
  }
})

test('documented defaults are the schema defaults', () => {
  const defaults = Object.fromEntries(Object.entries(Config.dict).map(([key, schema]) => [key, schema.meta.default]))
  assert.deepEqual(defaults, {
    notifyOnIdle: true,
    notifyOnError: true,
    notifyOnApproval: true,
    minTurnDurationMs: 5000,
    desktop: true,
    browser: true,
    browserOnlyWhenHidden: true,
    webhookUrl: '',
    title: 'DeepSeek Harness',
    sound: 'Glass',
    windowsAppId: '',
    badge: true,
    badgeDesktopOnly: true,
    badgeMode: 'count',
    badgeMaxCount: 99,
    badgeOnIdle: true,
    badgeOnApproval: true,
    badgeClearOnFocus: true,
  })
})

test('the webhook URL is a secret so it never crosses the settings wire', () => {
  assert.equal(Config.dict.webhookUrl.meta.role, 'secret')
})

/* --- sound resolution ----------------------------------------------------- */

test('resolveSoundPath resolves system sound names to files', () => {
  assert.equal(resolveSoundPath(''), null)
  assert.equal(resolveSoundPath(undefined), null)
  // A bare name is looked up with every supported audio extension.
  const glass = resolveSoundPath('Glass')
  if (glass === null) {
    assert.notEqual(process.platform, 'darwin', 'macOS ships a Glass system sound')
  } else {
    assert.match(glass, /\/Sounds\/Glass\.(aif|aiff|caf|m4a|mp3|wav)$/)
    // An explicit file name resolves to the same file, not "Glass.aiff.aiff".
    assert.equal(resolveSoundPath('Glass.aiff'), glass)
  }
  // A relative file name that does not exist resolves to nothing.
  assert.equal(resolveSoundPath('dsh-notification-missing'), null)
  assert.equal(resolveSoundPath('dsh-notification-missing.wav'), null)
})

test('resolveSoundPath returns absolute files that exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-notification-sound-'))
  const file = join(dir, 'chime.wav')
  writeFileSync(file, '')
  assert.equal(resolveSoundPath(file), file)
  assert.equal(resolveSoundPath(join(dir, 'nope.wav')), null)
})

test('resolveSoundPath never resolves to a directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-notification-sound-'))
  const folder = join(dir, 'chime.wav')
  mkdirSync(folder)
  assert.equal(resolveSoundPath(dir), null)
  assert.equal(resolveSoundPath(folder), null)
})

test('resolveSoundPath re-checks a cached file before reusing it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-notification-sound-'))
  const file = join(dir, 'chime.wav')
  writeFileSync(file, '')
  assert.equal(resolveSoundPath(file), file)
  assert.equal(resolveSoundPath(file), file)
  rmSync(file)
  assert.equal(resolveSoundPath(file), null)
  // A miss is not cached: the file is found once it exists again.
  writeFileSync(file, '')
  assert.equal(resolveSoundPath(file), file)
})

/* --- desktop notifications ------------------------------------------------ */

test('desktopNotify survives an asynchronous spawn failure', () => {
  // spawn() reports a missing binary as an async 'error' event; without a
  // listener Node rethrows it and takes the whole dsh process down.
  const child = new EventEmitter()
  child.unref = () => {}
  const calls = []
  const spawn = (command, args, options) => {
    calls.push({ command, args, options })
    return child
  }

  desktopNotify('title', 'body', { spawn })
  const expected = process.platform === 'darwin' ? 'osascript'
    : process.platform === 'linux' ? 'notify-send'
      : process.platform === 'win32' ? 'powershell' : null
  if (expected === null) return
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, expected)
  assert.equal(calls[0].options.detached, true)
  assert.doesNotThrow(() => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })))
})

test('desktopNotify escapes the strings it hands to a shell', () => {
  if (process.platform !== 'darwin') return
  const child = new EventEmitter()
  child.unref = () => {}
  let script = ''
  desktopNotify('ti"tle', 'bo"dy', { spawn: (_c, args) => { script = args[1]; return child } })
  assert.ok(script.includes('\\"'), `expected escaped quotes in ${script}`)
})

test('desktopNotify plays a configured file through afplay on macOS', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-notification-play-'))
  const file = join(dir, 'ping.wav')
  writeFileSync(file, '')
  const commands = []
  const make = () => {
    const emitter = new EventEmitter()
    emitter.unref = () => {}
    return emitter
  }
  desktopNotify('t', 'b', { sound: file, spawn: (command, args) => { commands.push({ command, args }); return make() } })
  if (process.platform !== 'darwin') {
    assert.deepEqual(commands.map((call) => call.command), ['notify-send'])
    return
  }
  assert.deepEqual(commands.map((call) => call.command), ['afplay', 'osascript'])
})

test('desktopNotify skips afplay for a sound path that is a directory', () => {
  if (process.platform !== 'darwin') return
  const dir = mkdtempSync(join(tmpdir(), 'dsh-notification-play-'))
  const commands = []
  const make = () => {
    const emitter = new EventEmitter()
    emitter.unref = () => {}
    return emitter
  }
  desktopNotify('t', 'b', { sound: dir, spawn: (command, args) => { commands.push({ command, args }); return make() } })
  assert.deepEqual(commands.map((call) => call.command), ['osascript'])
  // A path is never handed to AppleScript's `sound name` lookup.
  assert.ok(!commands[0].args[1].includes('sound name'), commands[0].args[1])
})

test('desktopNotify plays a named system sound through afplay on macOS', () => {
  if (process.platform !== 'darwin') return
  const commands = []
  const make = () => {
    const emitter = new EventEmitter()
    emitter.unref = () => {}
    return emitter
  }
  desktopNotify('t', 'b', {
    sound: 'Glass',
    spawn: (command, args) => { commands.push({ command, args }); return make() },
  })
  assert.deepEqual(commands.map((call) => call.command), ['afplay', 'osascript'])
  assert.match(commands[0].args[0], /\/Sounds\/Glass\.(aif|aiff|caf|m4a|mp3|wav)$/)
  // The notification is silent: the resolved file already played.
  assert.ok(!commands[1].args[1].includes('sound name'), commands[1].args[1])
})

test('the default sound is a system name that resolves to a standard sound file', () => {
  // The default stays a name so a machine without the file still falls back to
  // AppleScript's own lookup instead of pointing at a path that may not exist.
  assert.equal(Config.dict.sound.meta.default, 'Glass')
  const path = resolveSoundPath(Config.dict.sound.meta.default)
  if (process.platform === 'darwin') {
    assert.ok(path, 'macOS ships a Glass system sound')
    assert.match(path, /\/Sounds\/Glass\.(aif|aiff|caf|m4a|mp3|wav)$/)
  }
})

/* --- Windows toasts ------------------------------------------------------- */

/** Capture the PowerShell script desktopNotify hands to powershell.exe. */
function windowsScript(options) {
  let script = ''
  const child = new EventEmitter()
  child.unref = () => {}
  desktopNotify('ti\'tle', 'bo\'dy', {
    platform: 'win32',
    ...options,
    spawn: (command, args) => { assert.equal(command, 'powershell'); script = args[3]; return child },
  })
  return script
}

test('a Windows toast never uses the notification title as the app id', () => {
  const script = windowsScript({})
  // The title is toast CONTENT; an AppUserModelID must be a registered app id.
  assert.ok(script.includes("CreateTextNode('ti''tle')"), script)
  assert.ok(script.includes('CreateToastNotifier()'), script)
})

test('a configured windowsAppId is the toast app id', () => {
  const script = windowsScript({ windowsAppId: 'com.deepseek.dsh' })
  assert.ok(script.includes("CreateToastNotifier('com.deepseek.dsh')"), script)
})

/* --- event wiring --------------------------------------------------------- */

/** Run the host half against a fake context and capture what it sends. */
function createHostHarness(overrides = {}) {
  const values = {
    notifyOnIdle: true,
    notifyOnError: true,
    notifyOnApproval: true,
    minTurnDurationMs: 0,
    desktop: false,
    browser: true,
    browserOnlyWhenHidden: true,
    webhookUrl: 'https://hook.test/dsh',
    title: 'DeepSeek Harness',
    sound: '',
    ...overrides,
  }
  // Volatile config fields are live references on the host half.
  const config = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { get: () => value }]))

  const listeners = new Map()
  const posts = []
  const warnings = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (url, init) => {
    posts.push({ url, payload: JSON.parse(init.body) })
    return Promise.resolve({ ok: true })
  }

  const agents = new Map()
  const ctx = {
    on(event, listener) {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
    logger: () => ({ warn: (...args) => warnings.push(args) }),
  }
  apply(ctx, config)

  return {
    values,
    posts,
    warnings,
    /** The runtime hands the SAME agent object to every event of one agent. */
    agent(id) {
      if (!agents.has(id)) agents.set(id, { id })
      return agents.get(id)
    },
    emit(event, payload, next) {
      const listener = listeners.get(event)
      assert.ok(listener, `no listener for ${event}`)
      return listener(payload, next)
    },
    restore() {
      globalThis.fetch = originalFetch
    },
  }
}

test('a finished turn posts once, with its duration', async () => {
  const harness = createHostHarness()
  try {
    harness.emit('agent/status', { agent: harness.agent('s1'), status: 'running' })
    harness.emit('agent/status', { agent: harness.agent('s1'), status: 'idle' })
    assert.equal(harness.posts.length, 1)
    assert.equal(harness.posts[0].payload.summary, 'Agent finished')
    assert.match(harness.posts[0].payload.body, /^done in /)
  } finally {
    harness.restore()
  }
})

test('a short turn stays quiet', () => {
  const harness = createHostHarness({ minTurnDurationMs: 60_000 })
  try {
    harness.emit('agent/status', { agent: harness.agent('s1'), status: 'running' })
    harness.emit('agent/status', { agent: harness.agent('s1'), status: 'idle' })
    assert.deepEqual(harness.posts, [])
  } finally {
    harness.restore()
  }
})

test('a failed turn announces the error once, not the idle flip after it', () => {
  const harness = createHostHarness()
  try {
    harness.emit('agent/status', { agent: harness.agent('s1'), status: 'running' })
    harness.emit('agent/error', { agent: harness.agent('s1'), turn: 2, step: 3, error: new Error('boom') })
    // The harness emits running -> idle right after agent/error.
    harness.emit('agent/status', { agent: harness.agent('s1'), status: 'idle' })
    assert.equal(harness.posts.length, 1)
    assert.equal(harness.posts[0].payload.summary, 'Agent error')
    assert.match(harness.posts[0].payload.body, /turn 2, step 3: boom/)
  } finally {
    harness.restore()
  }
})

test('an errored turn is never announced as a finish, even with error notifications off', () => {
  // The idle flip follows agent/error unconditionally, so the failure has to be
  // recorded before the notifyOnError gate — otherwise a failed turn is posted
  // as "Agent finished".
  const harness = createHostHarness({ notifyOnError: false })
  try {
    harness.emit('agent/status', { agent: harness.agent('s1'), status: 'running' })
    harness.emit('agent/error', { agent: harness.agent('s1'), turn: 1, step: 1, error: new Error('boom') })
    harness.emit('agent/status', { agent: harness.agent('s1'), status: 'idle' })
    assert.deepEqual(harness.posts, [])
  } finally {
    harness.restore()
  }
})

test('a successful turn after an errored one still notifies', () => {
  const harness = createHostHarness({ notifyOnError: false })
  try {
    harness.emit('agent/status', { agent: harness.agent('s1'), status: 'running' })
    harness.emit('agent/error', { agent: harness.agent('s1'), turn: 1, step: 1, error: new Error('boom') })
    harness.emit('agent/status', { agent: harness.agent('s1'), status: 'idle' })
    harness.emit('agent/status', { agent: harness.agent('s1'), status: 'running' })
    harness.emit('agent/status', { agent: harness.agent('s1'), status: 'idle' })
    assert.equal(harness.posts.length, 1)
    assert.equal(harness.posts[0].payload.summary, 'Agent finished')
  } finally {
    harness.restore()
  }
})

test('subagent sessions never notify', () => {
  const harness = createHostHarness()
  try {
    harness.emit('session/created', { id: 'sub1', header: { origin: 'subagent' } })
    harness.emit('agent/status', { agent: harness.agent('sub1'), status: 'running' })
    harness.emit('agent/status', { agent: harness.agent('sub1'), status: 'idle' })
    assert.deepEqual(harness.posts, [])

    // A disposed subagent stops being filtered, and ordinary sessions are
    // unaffected either way.
    harness.emit('session/disposed', { id: 'sub1' })
    harness.emit('agent/status', { agent: harness.agent('s2'), status: 'running' })
    harness.emit('agent/status', { agent: harness.agent('s2'), status: 'idle' })
    assert.equal(harness.posts.length, 1)
  } finally {
    harness.restore()
  }
})

test('approval/request is observed and always delegates', () => {
  const harness = createHostHarness()
  try {
    let delegated = 0
    const outcome = harness.emit('approval/request', {
      toolName: 'Bash',
      reason: 'runs a command',
      displayReason: { en: 'Run a command' },
    }, () => {
      delegated += 1
      return Promise.resolve('allowed-once')
    })
    assert.equal(delegated, 1)
    return Promise.resolve(outcome).then(() => {
      assert.equal(harness.posts.length, 1)
      // The localized presentation text wins over the logged reason.
      assert.equal(harness.posts[0].payload.body, 'Bash — Run a command')
      assert.equal(harness.posts[0].payload.level, 'warn')
    })
  } finally {
    harness.restore()
  }
})

test('a failing webhook is logged, never thrown', async () => {
  const harness = createHostHarness()
  try {
    globalThis.fetch = () => Promise.reject(new Error('connect ECONNREFUSED'))
    harness.emit('agent/status', { agent: harness.agent('s1'), status: 'running' })
    harness.emit('agent/status', { agent: harness.agent('s1'), status: 'idle' })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(harness.warnings.length, 1)
    assert.match(String(harness.warnings[0][0]), /webhook POST failed/)
  } finally {
    harness.restore()
  }
})

test('only an unresolved bare name falls back to a sound name', () => {
  if (process.platform !== 'darwin') return
  const scripts = []
  const make = () => {
    const emitter = new EventEmitter()
    emitter.unref = () => {}
    return emitter
  }
  const spawn = (command, args) => {
    if (command === 'osascript') scripts.push(args[1])
    return make()
  }
  desktopNotify('t', 'b', { sound: '/nowhere/missing.wav', spawn })
  desktopNotify('t', 'b', { sound: 'Glass', spawn })
  desktopNotify('t', 'b', { sound: 'dsh-notification-missing', spawn })
  assert.ok(!scripts[0].includes('sound name'), scripts[0])
  // Glass resolves to a system file, so afplay owns it and the notification is
  // silent -- Script Editor's own sound setting must not be able to mute it.
  assert.ok(!scripts[1].includes('sound name'), scripts[1])
  assert.ok(scripts[2].includes('sound name "dsh-notification-missing"'), scripts[2])
})
