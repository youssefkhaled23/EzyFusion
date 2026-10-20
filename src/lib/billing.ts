/**
 * Billing rules. Pure module: no framework, database or I/O imports, and no dependence on the process
 * timezone. All money is integer sen. Calendar dates are YYYY-MM-DD strings handled as integer day numbers.
 */

export type InvoiceKind = 'deposit' | 'rent'

export interface ScheduledInvoice {
  kind: InvoiceKind
  periodIndex: number | null
  periodStart: string | null
  periodEnd: string | null
  dueDate: string
  amountSen: number
}

export type InvoiceStatus = 'paid' | 'partially_paid' | 'unpaid' | 'overdue'

// ---- calendar arithmetic (proleptic Gregorian, no Date objects) ---------------------------------------------------

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const MS_PER_DAY = 86_400_000
const MALAYSIA_OFFSET_MS = 8 * 3_600_000 // Asia/Kuala_Lumpur is UTC+8 all year (no DST)

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
const daysInMonth = (y: number, m: number) => [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]

interface Ymd {
  y: number
  m: number
  d: number
}

/** Parses a strict YYYY-MM-DD calendar date; throws on any other shape or a non-existent date. */
function parseDate(value: unknown, label: string): Ymd {
  const match = typeof value === 'string' ? DATE_RE.exec(value) : null
  if (!match) throw new Error(`${label} must be a YYYY-MM-DD date, got ${JSON.stringify(value)}`)
  const y = Number(match[1])
  const m = Number(match[2])
  const d = Number(match[3])
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) {
    throw new Error(`${label} is not a real calendar date: ${value}`)
  }
  return { y, m, d }
}

/** Days since 1970-01-01 for a civil date (Hinnant's days_from_civil). Works for any proleptic Gregorian date. */
function toDayNumber(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y
  const era = Math.floor(yy / 400)
  const yoe = yy - era * 400
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  return era * 146_097 + doe - 719_468
}

function fromDayNumber(days: number): Ymd {
  const z = days + 719_468
  const era = Math.floor(z / 146_097)
  const doe = z - era * 146_097
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365)
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1
  const m = mp < 10 ? mp + 3 : mp - 9
  return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d }
}

const pad = (n: number, width: number) => String(n).padStart(width, '0')
const formatDayNumber = (days: number) => {
  const { y, m, d } = fromDayNumber(days)
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`
}

/**
 * Anchor k = ORIGINAL start date + k calendar months, clamped to the last day of a shorter month.
 * Always derived from the start date, never from the previous anchor (so Jan 31 -> Feb 28 -> Mar 31).
 */
function anchorDayNumber(start: Ymd, k: number): number {
  const monthIndex = start.y * 12 + (start.m - 1) + k
  const y = Math.floor(monthIndex / 12)
  const m = (monthIndex % 12) + 1
  return toDayNumber(y, m, Math.min(start.d, daysInMonth(y, m)))
}

/** round-half-up(amount * used / full) in exact integer arithmetic. BigInt avoids overflow of the product. */
function prorate(amountSen: number, usedDays: number, fullDays: number): number {
  const numerator = BigInt(amountSen) * BigInt(usedDays)
  const denominator = BigInt(fullDays)
  return Number((2n * numerator + denominator) / (2n * denominator))
}

// ---- generateSchedule ---------------------------------------------------------------------------------------------------

export function generateSchedule(lease: {
  startDate: string
  endDate: string
  monthlyRentSen: number
  depositSen: number
}): ScheduledInvoice[] {
  if (lease === null || typeof lease !== 'object') throw new Error('lease is required')
  const start = parseDate(lease.startDate, 'startDate')
  const end = parseDate(lease.endDate, 'endDate')
  const startDay = toDayNumber(start.y, start.m, start.d)
  const endDay = toDayNumber(end.y, end.m, end.d)
  if (endDay < startDay) throw new Error('endDate must not be before startDate')
  if (!Number.isSafeInteger(lease.monthlyRentSen) || lease.monthlyRentSen <= 0) {
    throw new Error('monthlyRentSen must be a positive integer number of sen')
  }
  if (!Number.isSafeInteger(lease.depositSen) || lease.depositSen < 0) {
    throw new Error('depositSen must be a non-negative integer number of sen')
  }

  const invoices: ScheduledInvoice[] = []
  if (lease.depositSen > 0) {
    invoices.push({
      kind: 'deposit',
      periodIndex: null,
      periodStart: null,
      periodEnd: null,
      dueDate: lease.startDate,
      amountSen: lease.depositSen,
    })
  }

  for (let k = 0; ; k++) {
    const anchor = anchorDayNumber(start, k)
    if (anchor > endDay) break
    const nextAnchor = anchorDayNumber(start, k + 1)
    const naturalEnd = nextAnchor - 1 // inclusive: the day before the next anchor
    const finalPeriod = naturalEnd >= endDay
    const periodEnd = finalPeriod ? endDay : naturalEnd
    const fullDays = nextAnchor - anchor
    const usedDays = periodEnd - anchor + 1
    invoices.push({
      kind: 'rent',
      periodIndex: k,
      periodStart: formatDayNumber(anchor),
      periodEnd: formatDayNumber(periodEnd),
      dueDate: formatDayNumber(anchor),
      amountSen: usedDays === fullDays ? lease.monthlyRentSen : prorate(lease.monthlyRentSen, usedDays, fullDays),
    })
    if (finalPeriod) break
  }
  return invoices
}

// ---- invoiceStatus ---------------------------------------------------------------------------------------------------------

/** Malaysia (UTC+8) calendar date of an instant, as a day number. Independent of the process timezone. */
function malaysiaDayNumber(now: Date): number {
  const ms = now.getTime()
  if (!Number.isFinite(ms)) throw new Error('now must be a valid Date')
  return Math.floor((ms + MALAYSIA_OFFSET_MS) / MS_PER_DAY)
}

export function invoiceStatus(
  invoice: { dueDate: string; amountSen: number; paidSen: number },
  now: Date,
): InvoiceStatus {
  const due = parseDate(invoice.dueDate, 'dueDate')
  if (!Number.isSafeInteger(invoice.amountSen) || !Number.isSafeInteger(invoice.paidSen)) {
    throw new Error('amountSen and paidSen must be integer numbers of sen')
  }
  const today = malaysiaDayNumber(now)

  if (invoice.paidSen >= invoice.amountSen) return 'paid'
  if (today > toDayNumber(due.y, due.m, due.d)) return 'overdue'
  if (invoice.paidSen > 0) return 'partially_paid'
  return 'unpaid'
}

// ---- parseRinggitToSen --------------------------------------------------------------------------------------------------------

// Digits with optional comma thousands groups (leading group 1-3 digits, every later group exactly 3),
// then an optional decimal part of one or two digits. No sign, exponent, symbol or other characters.
const RINGGIT_RE = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/

export function parseRinggitToSen(input: string): number {
  if (typeof input !== 'string') throw new Error('amount must be a string')
  const match = RINGGIT_RE.exec(input.trim())
  if (!match) throw new Error(`invalid ringgit amount: ${JSON.stringify(input)}`)
  const whole = match[1].replace(/,/g, '')
  const fraction = (match[2] ?? '').padEnd(2, '0')
  const sen = BigInt(whole) * 100n + BigInt(fraction)
  if (sen > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('amount is too large to represent exactly in sen')
  return Number(sen)
}
