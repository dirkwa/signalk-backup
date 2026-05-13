/**
 * ISO-week math. ISO 8601 weeks start on Monday; week 1 of a year is the
 * one containing the year's first Thursday. We need UTC throughout so the
 * shard boundary is stable regardless of where the boat (or the server)
 * is geographically.
 *
 * No external deps — vanilla Date arithmetic. The shard filenames depend
 * on this matching exactly across processes, so we keep it tiny and
 * heavily unit-tested.
 */

export interface IsoWeek {
  /** ISO-year (NOT calendar year — week 1 can fall in the previous year's December). */
  year: number
  /** 1..53 */
  week: number
}

/**
 * UTC midnight of the Monday that starts the given ISO week.
 */
export function weekStartUtc(iw: IsoWeek): Date {
  // Jan 4 is always in week 1 (per ISO definition).
  const jan4 = new Date(Date.UTC(iw.year, 0, 4))
  // Monday-of-week-1 = jan4 - ((dayOfWeek+6) % 7) days
  const jan4Dow = jan4.getUTCDay() // 0=Sun..6=Sat
  const mondayOffset = (jan4Dow + 6) % 7
  const week1Monday = new Date(jan4)
  week1Monday.setUTCDate(jan4.getUTCDate() - mondayOffset)
  // Step forward (week-1) weeks.
  const start = new Date(week1Monday)
  start.setUTCDate(week1Monday.getUTCDate() + (iw.week - 1) * 7)
  return start
}

/**
 * UTC midnight of the Monday AFTER the given ISO week — i.e. the
 * start of week+1, used as the half-open `to` boundary.
 */
export function weekEndUtc(iw: IsoWeek): Date {
  const start = weekStartUtc(iw)
  const end = new Date(start)
  end.setUTCDate(start.getUTCDate() + 7)
  return end
}

/**
 * Which ISO week contains the given instant?
 */
export function isoWeekOf(date: Date): IsoWeek {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  // Move to the Thursday of the same week — ISO weeks belong to whatever
  // year *that* Thursday falls in. Sunday=7 in ISO; the offset that lands
  // on Thursday is (4 - isoDow).
  const isoDow = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + (4 - isoDow))
  const year = d.getUTCFullYear()
  const yearStart = new Date(Date.UTC(year, 0, 1))
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
  return { year, week }
}

/**
 * Compare two IsoWeeks. <0 if a is earlier, 0 if same, >0 if a is later.
 */
export function compareIsoWeek(a: IsoWeek, b: IsoWeek): number {
  if (a.year !== b.year) return a.year - b.year
  return a.week - b.week
}

/**
 * Enumerate every ISO week from `from` through `to`, inclusive.
 * Returns weeks in chronological order.
 */
export function weeksBetween(from: IsoWeek, to: IsoWeek): IsoWeek[] {
  if (compareIsoWeek(from, to) > 0) return []
  const out: IsoWeek[] = []
  // Walk by adding 7 days to a Monday — handles year boundaries naturally.
  let cursor = weekStartUtc(from)
  const stop = weekStartUtc(to)
  while (cursor.getTime() <= stop.getTime()) {
    out.push(isoWeekOf(cursor))
    cursor = new Date(cursor.getTime() + 7 * 86_400_000)
  }
  return out
}

/**
 * Stable filename label, e.g. "2026-W05" (week zero-padded to two digits).
 */
export function formatIsoWeek(iw: IsoWeek): string {
  return `${iw.year}-W${String(iw.week).padStart(2, '0')}`
}
