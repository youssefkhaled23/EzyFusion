/** Malaysia (Asia/Kuala_Lumpur, UTC+8, no DST) calendar helpers. Pure and independent of the process timezone. */
const MS_PER_HOUR = 3_600_000
const MALAYSIA_OFFSET_MS = 8 * MS_PER_HOUR

/** Today's calendar date in Malaysia as YYYY-MM-DD. */
export function malaysiaDate(now: Date): string {
  const ms = now.getTime()
  if (!Number.isFinite(ms)) throw new Error('invalid Date')
  return new Date(ms + MALAYSIA_OFFSET_MS).toISOString().slice(0, 10)
}

const GATEWAY_PAID_AT = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) \+0800$/

/**
 * Gateway timestamp "YYYY-MM-DD HH:mm:ss +0800" -> the real UTC instant, or null when it is not exactly that shape,
 * is not a real calendar/clock time, or carries any offset other than +0800.
 */
export function parseGatewayPaidAt(value: string): Date | null {
  const m = GATEWAY_PAID_AT.exec(value)
  if (!m) return null
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number)
  const utc = Date.UTC(y, mo - 1, d, h, mi, s)
  const check = new Date(utc)
  // Date.UTC silently rolls impossible values over (Feb 30, hour 24, minute 61): reject any roll-over.
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || check.getUTCHours() !== h || check.getUTCMinutes() !== mi || check.getUTCSeconds() !== s) return null
  if (y < 1) return null
  return new Date(utc - MALAYSIA_OFFSET_MS)
}
