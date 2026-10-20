import { orgIdsWithRole } from './access'
import { toSafeNumber } from './convert'
import type { Db } from './db'
import { HttpError } from './errors'

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/
const MYT_OFFSET_MS = 8 * 3_600_000 // Asia/Kuala_Lumpur, UTC+8, no DST
const MAX_MONTHS = 120

const parseMonth = (value: unknown, field: string) => {
  const m = typeof value === 'string' ? MONTH.exec(value) : null
  if (!m) throw new HttpError(400, `${field} must be YYYY-MM`)
  return { year: Number(m[1]), month: Number(m[2]) }
}
/** Instant of 00:00 Malaysia time on the first day of the given month. */
const mytMonthStart = (year: number, month: number) => new Date(Date.UTC(year, month - 1, 1) - MYT_OFFSET_MS)

export async function collectionsReport(db: Db, userId: string, from: unknown, to: unknown): Promise<{ month: string; collectedSen: number }[]> {
  const orgIds = await orgIdsWithRole(db, userId, ['manager', 'staff'])
  if (orgIds.length === 0) throw new HttpError(403, 'only staff and managers can view reports')

  const start = parseMonth(from, 'from')
  const end = parseMonth(to, 'to')
  const months = (end.year - start.year) * 12 + (end.month - start.month) + 1
  if (months < 1) throw new HttpError(400, 'from must not be after to')
  if (months > MAX_MONTHS) throw new HttpError(400, `range is limited to ${MAX_MONTHS} months`)

  const lower = mytMonthStart(start.year, start.month)
  const upper = mytMonthStart(end.year, end.month + 1) // Date.UTC rolls month 13 into January
  const rows = await db.$queryRaw<{ month: string; total: bigint }[]>`
    select to_char(received_at at time zone 'Asia/Kuala_Lumpur', 'YYYY-MM') as month, sum(amount_sen)::bigint as total
    from public.payments
    where org_id = any(${orgIds}::uuid[]) and status = 'approved' and received_at >= ${lower} and received_at < ${upper}
    group by 1`
  const byMonth = new Map(rows.map((r) => [r.month, toSafeNumber(r.total, 'collectedSen')]))

  return Array.from({ length: months }, (_, i) => {
    const index = start.year * 12 + (start.month - 1) + i
    const month = `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`
    return { month, collectedSen: byMonth.get(month) ?? 0 }
  })
}
