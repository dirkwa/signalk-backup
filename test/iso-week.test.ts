import { describe, it, expect } from 'vitest'
import {
  weekStartUtc,
  weekEndUtc,
  isoWeekOf,
  compareIsoWeek,
  weeksBetween,
  formatIsoWeek
} from '../src/database-export/iso-week.js'

describe('iso-week', () => {
  describe('isoWeekOf', () => {
    it('Thursday Jan 1 2026 is in W01 of 2026', () => {
      // 2026-01-01 = Thursday; Thursdays anchor the ISO year, so this IS week 1.
      expect(isoWeekOf(new Date('2026-01-01T12:00:00Z'))).toEqual({ year: 2026, week: 1 })
    })

    it('Monday Jan 4 2027 is in W01 of 2027 (week containing Jan 4 = W01)', () => {
      expect(isoWeekOf(new Date('2027-01-04T00:00:00Z'))).toEqual({ year: 2027, week: 1 })
    })

    it('Sat Jan 1 2028 belongs to W52 of 2027 (Thursday rule)', () => {
      // Thursday of that week is Dec 30 2027 → ISO year 2027.
      expect(isoWeekOf(new Date('2028-01-01T00:00:00Z'))).toEqual({ year: 2027, week: 52 })
    })

    it('Mon Dec 30 2024 is W01 of 2025 (week 1 reaches back into prev year)', () => {
      expect(isoWeekOf(new Date('2024-12-30T00:00:00Z'))).toEqual({ year: 2025, week: 1 })
    })

    it('uses UTC, not local time', () => {
      // Sun 2026-01-04 23:30 UTC is week 1 of 2026 (Sun is end of W01 in ISO).
      expect(isoWeekOf(new Date('2026-01-04T23:30:00Z'))).toEqual({ year: 2026, week: 1 })
    })
  })

  describe('weekStartUtc / weekEndUtc', () => {
    it('W01-2026 starts on Mon 2025-12-29 and ends on Mon 2026-01-05', () => {
      const w = { year: 2026, week: 1 }
      expect(weekStartUtc(w).toISOString()).toBe('2025-12-29T00:00:00.000Z')
      expect(weekEndUtc(w).toISOString()).toBe('2026-01-05T00:00:00.000Z')
    })

    it('W19-2026 starts on Mon 2026-05-04', () => {
      const w = { year: 2026, week: 19 }
      expect(weekStartUtc(w).toISOString()).toBe('2026-05-04T00:00:00.000Z')
      expect(weekEndUtc(w).toISOString()).toBe('2026-05-11T00:00:00.000Z')
    })

    it('round-trip: weekStartUtc → isoWeekOf returns same week', () => {
      const w = { year: 2026, week: 27 }
      expect(isoWeekOf(weekStartUtc(w))).toEqual(w)
    })
  })

  describe('compareIsoWeek', () => {
    it('orders by year then week', () => {
      expect(compareIsoWeek({ year: 2026, week: 5 }, { year: 2026, week: 3 })).toBeGreaterThan(0)
      expect(compareIsoWeek({ year: 2025, week: 50 }, { year: 2026, week: 1 })).toBeLessThan(0)
      expect(compareIsoWeek({ year: 2026, week: 5 }, { year: 2026, week: 5 })).toBe(0)
    })
  })

  describe('weeksBetween', () => {
    it('inclusive on both ends', () => {
      const weeks = weeksBetween({ year: 2026, week: 17 }, { year: 2026, week: 19 })
      expect(weeks).toEqual([
        { year: 2026, week: 17 },
        { year: 2026, week: 18 },
        { year: 2026, week: 19 }
      ])
    })

    it('spans year boundary', () => {
      const weeks = weeksBetween({ year: 2025, week: 52 }, { year: 2026, week: 2 })
      expect(weeks).toEqual([
        { year: 2025, week: 52 },
        { year: 2026, week: 1 },
        { year: 2026, week: 2 }
      ])
    })

    it('returns empty when from > to', () => {
      expect(weeksBetween({ year: 2026, week: 5 }, { year: 2026, week: 4 })).toEqual([])
    })

    it('single week when from === to', () => {
      expect(weeksBetween({ year: 2026, week: 7 }, { year: 2026, week: 7 })).toEqual([
        { year: 2026, week: 7 }
      ])
    })
  })

  describe('formatIsoWeek', () => {
    it('pads week to two digits', () => {
      expect(formatIsoWeek({ year: 2026, week: 5 })).toBe('2026-W05')
      expect(formatIsoWeek({ year: 2026, week: 42 })).toBe('2026-W42')
    })
  })
})
