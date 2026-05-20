import { describe, expect, it } from 'vitest'
import { resolveHostTarget, resolveZipEntryPath } from '../src/restore-host-write.js'
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

describe('resolveZipEntryPath', () => {
  const target = '/tmp/restore-target'

  it('accepts a plain entry under the target', () => {
    expect(resolveZipEntryPath('sub/a.txt', target)).toBe('/tmp/restore-target/sub/a.txt')
  })

  it('rejects entries with ".." segments anywhere (the classic path-traversal vector)', () => {
    expect(resolveZipEntryPath('../etc/passwd', target)).toBeNull()
    expect(resolveZipEntryPath('sub/../../etc/passwd', target)).toBeNull()
    // Even a "safe" rewrite still rejects — the shape of the entry
    // is suspicious enough to refuse outright. A legitimate snapshot
    // never produces these names.
    expect(resolveZipEntryPath('sub/../etc', target)).toBeNull()
  })

  it('accepts an entry whose name starts with "/" (the leading slash is dropped during split)', () => {
    // /etc/passwd splits to ['etc', 'passwd'] (the leading empty
    // segment from the slash is filtered) and lands under target —
    // a legitimate inside-target write.
    expect(resolveZipEntryPath('/etc/passwd', target)).toBe('/tmp/restore-target/etc/passwd')
  })

  it('rejects empty entry paths', () => {
    expect(resolveZipEntryPath('', target)).toBeNull()
    expect(resolveZipEntryPath('//', target)).toBeNull()
  })

  it('strips Windows-style backslash separators', () => {
    // Defensive: a malicious ZIP could embed backslash separators.
    expect(resolveZipEntryPath('a\\b\\c.txt', target)).toBe('/tmp/restore-target/a/b/c.txt')
    expect(resolveZipEntryPath('..\\..\\etc\\passwd', target)).toBeNull()
  })
})
