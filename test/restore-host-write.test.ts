import { describe, expect, it } from 'vitest'
import { resolveHostTarget, resolveZipEntryPath } from '../src/restore-host-write.js'
import path from 'node:path'

// Helper: build a POSIX-style absolute path and resolve it on the
// current platform, so tests work on both Linux (no-op) and Windows
// (where path.resolve('/tmp') yields something like 'D:\tmp').
const abs = (...parts: string[]): string => path.resolve('/' + parts.join('/'))

describe('resolveHostTarget', () => {
  it('returns the absolute path verbatim for a no-slash custom path', () => {
    const r = resolveHostTarget(abs('tmp', 'restored.json'), false, 'package.json')
    expect(r.absoluteTarget).toBe(abs('tmp', 'restored.json'))
  })

  it('appends the source basename when customPath ends with /', () => {
    // The "into this directory" intent — tmp/ + file `package.json`
    // should land at tmp/package.json, not overwrite tmp as a file.
    const r = resolveHostTarget(abs('tmp') + path.sep, false, 'package.json')
    expect(r.absoluteTarget).toBe(abs('tmp', 'package.json'))
  })

  it('appends the source basename for directory sources too', () => {
    const r = resolveHostTarget(
      abs('media', 'usb', 'restored') + path.sep,
      true,
      'plugin-config-data/exports'
    )
    expect(r.absoluteTarget).toBe(abs('media', 'usb', 'restored', 'exports'))
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
    // absolute; the higher layer would still refuse to write because
    // of fs permissions but the path itself is correct.
    const r = resolveHostTarget('/', true, 'package.json')
    expect(path.isAbsolute(r.absoluteTarget)).toBe(true)
    // Assert the join shape rather than path.resolve('/'). resolve()
    // pulls in the cwd's drive letter on Windows (D:\package.json
    // vs \package.json), whereas the runtime uses path.join which
    // doesn't — so a literal path.resolve check would diverge on the
    // CI runner depending on which drive the test runs from.
    expect(r.absoluteTarget).toBe(path.join(path.sep, 'package.json'))
  })

  it('builds a sibling safety path next to the target', () => {
    const r = resolveHostTarget(abs('tmp', 'restored.json'), false, 'package.json')
    expect(r.safetyPath.startsWith(abs('tmp', 'restored.json') + '.partial-restore-backup-')).toBe(
      true
    )
  })
})

describe('resolveZipEntryPath', () => {
  const target = abs('tmp', 'restore-target')

  it('accepts a plain entry under the target', () => {
    expect(resolveZipEntryPath('sub/a.txt', target)).toBe(
      abs('tmp', 'restore-target', 'sub', 'a.txt')
    )
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
    expect(resolveZipEntryPath('/etc/passwd', target)).toBe(
      abs('tmp', 'restore-target', 'etc', 'passwd')
    )
  })

  it('rejects empty entry paths', () => {
    expect(resolveZipEntryPath('', target)).toBeNull()
    expect(resolveZipEntryPath('//', target)).toBeNull()
  })

  it('strips Windows-style backslash separators', () => {
    // Defensive: a malicious ZIP could embed backslash separators.
    expect(resolveZipEntryPath('a\\b\\c.txt', target)).toBe(
      abs('tmp', 'restore-target', 'a', 'b', 'c.txt')
    )
    expect(resolveZipEntryPath('..\\..\\etc\\passwd', target)).toBeNull()
  })
})
