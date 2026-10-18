import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const read = (name) => readFileSync(new URL(name, root), 'utf8')
const pkg = JSON.parse(read('package.json'))
const patch = read('cordis.patch.yml')
const client = read('client.js')

/* --- the identity tuple --------------------------------------------------- */

test('the package name, the patch row and the browser bundle agree', () => {
  // The browser module system looks a bundle up by the package name of the
  // Loader row that owns it, and the settings document is keyed by the row id.
  // A mismatch fails the whole page boot ("loaded without registering"), so
  // pin all four names down here.
  const row = patch.match(/-\s*insert:\s*\n\s*-\s*id:\s*(\S+)\s*\n\s*name:\s*(\S+)/)
  assert.ok(row, `no insert row found in cordis.patch.yml:\n${patch}`)
  const [, entryId, rowName] = row
  assert.equal(rowName, pkg.name, 'the patch row must name the package')
  assert.ok(client.includes(`id: "${pkg.name}"`), 'the bundle must register the package name')
  assert.ok(client.includes(`ENTRY_ID = "${entryId}"`), 'the bundle must read its settings namespace')
  assert.ok(read('index.js').includes(`name = '${pkg.name}'`), 'the host half must export the package name')
})

test('exactly one bundle registration exists', () => {
  assert.equal(client.match(/__ModuleLoader__\.load\(/g)?.length, 1)
})

/* --- manifest ------------------------------------------------------------- */

test('the manifest declares the bundle patch and a web client half', () => {
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  // `dsh.client.inject` names other package rows that must arrive first; the
  // services this bundle needs are awaited inside apply instead.
  assert.equal(pkg.dsh.client.inject, undefined)
  assert.equal(pkg.dsh.manifestVersion, 1)
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/)
})

test('engines.dsh is a prerelease-aware range, not a bare caret', () => {
  // @deepseek-ai/dsh-app-boot evaluates this range with prereleases included.
  // The installer refuses `dsh plugin add` for an unmet range (unless the exact
  // package@version is version-exempted); an already-listed bundle is only
  // warned about, so this is an install gate, not a load gate.
  assert.match(pkg.engines.dsh, /^\^0\.\d+\.\d+-rc\.\d+$/)
})

test('schemastery is a runtime dependency of the shipped version line', () => {
  assert.match(pkg.dependencies['@deepseek-ai/schemastery'], /^~3\.18\./)
  assert.equal(pkg.peerDependencies, undefined)
})

/* --- published payload ---------------------------------------------------- */

test('every export resolves to a file that ships', () => {
  const shipped = (relative) => {
    const path = new URL(relative, root)
    assert.ok(existsSync(path), `${relative} does not exist`)
    // A `files` entry with a glob is checked by npm pack; assert the literal
    // ones are listed so the tarball stays complete.
    const listed = relative.replace(/^\.\//, '')
    // npm always packs package.json, README and LICENSE, whether or not `files`
    // names them; everything else must be listed, literally or by a glob.
    const alwaysPacked = ['package.json', 'README.md', 'LICENSE']
    const covered = pkg.files.some((entry) => {
      if (!entry.includes('*')) return entry === listed
      const pattern = new RegExp(`^${entry.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`)
      return pattern.test(listed)
    })
    if (!alwaysPacked.includes(listed)) {
      assert.ok(covered, `${listed} is missing from files`)
    }
    return path
  }
  for (const target of Object.values(pkg.exports)) {
    if (target.includes('*')) continue
    shipped(target)
  }
  shipped('index.js')
  shipped('client.js')
  shipped('cordis.patch.yml')
  shipped('icon.svg')
  shipped('locale/en.json')
})

test('the display metadata a plugin row reads is present', () => {
  const locale = JSON.parse(read('locale/en.json'))
  assert.equal(typeof locale.meta.title, 'string')
  assert.ok(locale.meta.title.length > 0)
  assert.equal(typeof locale.meta.description, 'string')
  assert.ok(locale.meta.description.length > 0)
  assert.ok(pkg.keywords.includes('dsh-plugin'))
})

test('the icon is a small original SVG', () => {
  const path = fileURLToPath(new URL('icon.svg', root))
  assert.ok(statSync(path).size < 256 * 1024)
  assert.match(read('icon.svg'), /^<svg[\s>]/)
})
