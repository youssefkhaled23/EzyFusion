/**
 * Deterministic Malaysia-time formatting for the UI. No Intl and no browser/process timezone: the same input gives the
 * same string on the server, in every browser and in every timezone, so there are no hydration mismatches.
 * Every instant is shown in Asia/Kuala_Lumpur (UTC+8, no DST).
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MYT_OFFSET_MS = 8 * 3_600_000

const pad = (n: number) => String(n).padStart(2, '0')

/** YYYY-MM-DD -> "5 Mar 2026" */
export function formatDateMy(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate)
  if (!m) return isoDate
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`
}

/** "2026-03" -> "Mar 2026" */
export function formatMonthMy(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month)
  return m ? `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}` : month
}

/** ISO instant -> Malaysia wall-clock "5 Mar 2026, 14:05 MYT" */
export function formatInstantMy(iso: string): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return iso
  const d = new Date(ms + MYT_OFFSET_MS) // read with the UTC getters: they now hold Malaysia wall-clock values
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} MYT`
}

/** Instant -> value for <input type="datetime-local"> in Malaysia time: "YYYY-MM-DDTHH:mm" */
export function toMalaysiaInputValue(date: Date): string {
  return new Date(date.getTime() + MYT_OFFSET_MS).toISOString().slice(0, 16)
}

/** <input type="datetime-local"> value (Malaysia wall-clock) -> explicit ISO instant with +08:00, or null if invalid. */
export function malaysiaInputToIso(value: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value)
  if (!m) return null
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '00'].map(Number)
  const check = new Date(Date.UTC(y, mo - 1, d, h, mi, s))
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || check.getUTCHours() !== h || check.getUTCMinutes() !== mi) return null
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}+08:00`
}

/** Integer sen -> "RM 1,234.56" (integer arithmetic only; negative values keep their sign). */
export function formatRM(amountSen: number): string {
  if (!Number.isSafeInteger(amountSen)) throw new RangeError('amountSen must be a safe integer')
  const negative = amountSen < 0
  const abs = Math.abs(amountSen)
  const ringgit = Math.floor(abs / 100)
  const sen = abs % 100
  const grouped = String(ringgit).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${negative ? '-' : ''}RM ${grouped}.${pad(sen)}`
}

/** Last `count` Malaysia calendar months ending with the month of `now`, as ["2025-11", ..., "2026-04"]. */
export function lastMalaysiaMonths(now: Date, count: number): string[] {
  const d = new Date(now.getTime() + MYT_OFFSET_MS)
  const end = d.getUTCFullYear() * 12 + d.getUTCMonth()
  return Array.from({ length: count }, (_, i) => {
    const index = end - (count - 1 - i)
    return `${String(Math.floor(index / 12)).padStart(4, '0')}-${pad((index % 12) + 1)}`
  })
}
