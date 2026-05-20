import { describe, expect, it } from 'vitest'
import { resolveHostTarget } from '../src/restore-host-write.js'
import path from 'node:path'

describe('resolveHostTarget', () => {
  it('returns the absolute path verbatim for a no-slash custom path', () => {
    const r = resolveHostTarget('/tmp/restored.json', false, 'package.json')
    expect(r.absoluteTarget).toBe('/tmp/restored.json')
  })

  it('appends the source basename when customPath ends with /', () => {
    // The "into this directory" intent — /tmp/ + file `package.json`
    // should land at /tmp/package.json, not overwrite /tmp as a file.
    const r = resolveHostTarget('/tmp/', false, 'package.json')
    expect(r.absoluteTarget).toBe('/tmp/package.json')
  })

  it('appends the source basename for directory sources too', () => {
    const r = resolveHostTarget('/media/usb/restored/', true, 'plugin-config-data/exports')
    expect(r.absoluteTarget).toBe('/media/usb/restored/exports')
  })

  it('resolves a relative customPath against process.cwd()', () => {
    // The plugin is the writer here; if the user types a relative
    // path it lands relative to wherever SignalK is running, which
    // matches "save it where I am" UX better than auto-prefixing.
    const r = resolveHostTarget('subdir/file.txt', false, 'package.json')
    expect(r.absoluteTarget).toBe(path.resolve('subdir/file.txt'))
  })

  it('preserves absolute "/" without losing absoluteness', () => {
    // Without the explicit guard, stripping the trailing slash would
    // leave "" and treat it as a relative path. The guard keeps it
    // absolute; the higher layer would still refuse to write to /
    // because of fs permissions but the path itself is correct.
    const r = resolveHostTarget('/', true, 'package.json')
    expect(path.isAbsolute(r.absoluteTarget)).toBe(true)
    expect(r.absoluteTarget).toBe('/package.json')
  })

  it('builds a sibling safety path next to the target', () => {
    const r = resolveHostTarget('/tmp/restored.json', false, 'package.json')
    expect(r.safetyPath).toMatch(/^\/tmp\/restored\.json\.partial-restore-backup-/)
  })
})
