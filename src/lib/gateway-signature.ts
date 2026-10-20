/**
 * Gateway callback signature. Pure module (node:crypto only).
 *
 *   1. take every field except x_signature
 *   2. sort keys ascending by character code
 *   3. each field becomes key immediately followed by value (no separator)
 *   4. join with "|"
 *   5. HMAC-SHA256 with the shared key, lowercase hexadecimal
 *   6. compare with timingSafeEqual
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

export const SIGNATURE_FIELD = 'x_signature'

export function canonicalString(fields: Record<string, string> | Iterable<[string, string]>): string {
  const entries = Symbol.iterator in Object(fields) ? [...(fields as Iterable<[string, string]>)] : Object.entries(fields as Record<string, string>)
  return entries
    .filter(([key]) => key !== SIGNATURE_FIELD)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) // UTF-16 code unit order = "character code" order
    .map(([key, value]) => `${key}${value}`)
    .join('|')
}

export function signFields(fields: Record<string, string> | Iterable<[string, string]>, key: string): string {
  return createHmac('sha256', key).update(canonicalString(fields), 'utf8').digest('hex')
}

/** Constant-time comparison of lowercase hex signatures. Anything that is not a 64-char hex string fails. */
export function verifySignature(fields: Record<string, string> | Iterable<[string, string]>, provided: string, key: string): boolean {
  const candidate = provided.toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(candidate)) return false
  const expected = Buffer.from(signFields(fields, key), 'hex')
  const given = Buffer.from(candidate, 'hex')
  return given.length === expected.length && timingSafeEqual(given, expected)
}
