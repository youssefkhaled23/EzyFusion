import { HttpError } from './errors'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value)

/** bigint (database money) -> JSON number, failing loudly instead of silently losing precision. */
export function toSafeNumber(value: bigint | number | null | undefined, label = 'amount'): number {
  const n = typeof value === 'bigint' ? value : BigInt(value ?? 0)
  if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError(`${label} exceeds the safe integer range`)
  }
  return Number(n)
}

/** Date column (UTC midnight Date from Prisma) -> YYYY-MM-DD */
export const dateOnly = (d: Date): string => d.toISOString().slice(0, 10)
/** YYYY-MM-DD -> Date at UTC midnight (what Prisma expects for @db.Date) */
export const toDateColumn = (s: string): Date => new Date(`${s}T00:00:00Z`)

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/

/** Strict ISO 8601 instant WITH an explicit offset (so the Malaysia/UTC ambiguity cannot arise). */
export function parseInstant(value: unknown, field: string): Date {
  if (typeof value !== 'string' || !INSTANT.test(value)) throw new HttpError(400, `${field} must be an ISO 8601 timestamp with a timezone offset`)
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) throw new HttpError(400, `${field} is not a valid timestamp`)
  return d
}

export function positiveSafeInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new HttpError(400, `${field} must be a positive integer number of sen`)
  return value
}

export function nonNegativeSafeInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new HttpError(400, `${field} must be a non-negative integer number of sen`)
  return value
}

export function reasonText(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length < 5 || value.length > 500) throw new HttpError(400, 'reason must be 5 to 500 characters')
  return value.trim()
}
