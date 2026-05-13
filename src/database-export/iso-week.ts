// UTC ISO-week math — shard filenames depend on this matching exactly across processes.

export interface IsoWeek {
  year: number
  week: number
}

export function weekStartUtc(iw: IsoWeek): Date {
  // Jan 4 is always in ISO week 1 — anchor backwards from the Monday of that week.
  const jan4 = new Date(Date.UTC(iw.year, 0, 4))
  const mondayOffset = (jan4.getUTCDay() + 6) % 7
  const week1Monday = new Date(jan4)
  week1Monday.setUTCDate(jan4.getUTCDate() - mondayOffset)
  const start = new Date(week1Monday)
  start.setUTCDate(week1Monday.getUTCDate() + (iw.week - 1) * 7)
  return start
}

export function weekEndUtc(iw: IsoWeek): Date {
  const start = weekStartUtc(iw)
  const end = new Date(start)
  end.setUTCDate(start.getUTCDate() + 7)
  return end
}

export function isoWeekOf(date: Date): IsoWeek {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  // ISO weeks belong to the year of their Thursday — shift to the Thursday of this week first.
  const isoDow = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + (4 - isoDow))
  const year = d.getUTCFullYear()
  const yearStart = new Date(Date.UTC(year, 0, 1))
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
  return { year, week }
}

export function compareIsoWeek(a: IsoWeek, b: IsoWeek): number {
  if (a.year !== b.year) return a.year - b.year
  return a.week - b.week
}

export function weeksBetween(from: IsoWeek, to: IsoWeek): IsoWeek[] {
  if (compareIsoWeek(from, to) > 0) return []
  const out: IsoWeek[] = []
  let cursor = weekStartUtc(from)
  const stop = weekStartUtc(to)
  while (cursor.getTime() <= stop.getTime()) {
    out.push(isoWeekOf(cursor))
    cursor = new Date(cursor.getTime() + 7 * 86_400_000)
  }
  return out
}

export function formatIsoWeek(iw: IsoWeek): string {
  return `${iw.year}-W${String(iw.week).padStart(2, '0')}`
}
