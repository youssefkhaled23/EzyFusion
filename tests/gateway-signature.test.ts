import { describe, expect, it } from 'vitest'
import { canonicalString, signFields, verifySignature } from '../src/lib/gateway-signature'
import { malaysiaDate, parseGatewayPaidAt } from '../src/lib/malaysia'

const KEY = 'test_x_signature_key'
const VECTOR = {
  id: 'bill_8f3a2c',
  paid: 'true',
  paid_amount: '210050',
  paid_at: '2026-04-01 00:30:12 +0800',
  transaction_id: 'TX-000123',
  transaction_status: 'completed',
}
const CANONICAL = 'idbill_8f3a2c|paidtrue|paid_amount210050|paid_at2026-04-01 00:30:12 +0800|transaction_idTX-000123|transaction_statuscompleted'
const SIGNATURE = '06994fab2d674e7829144eaa2204631716d3c099b503d38945e92b6296531641'

describe('gateway signature: the official test vector', () => {
  it('builds the exact canonical string (keys sorted, key+value, joined with |)', () => {
    expect(canonicalString(VECTOR)).toBe(CANONICAL)
    expect(canonicalString(Object.entries(VECTOR).reverse())).toBe(CANONICAL) // input order does not matter
  })

  it('produces the exact expected HMAC-SHA256 signature', () => {
    expect(signFields(VECTOR, KEY)).toBe(SIGNATURE)
  })

  it('verifies the vector, case-insensitively, and ignores x_signature when canonicalizing', () => {
    expect(verifySignature({ ...VECTOR, x_signature: SIGNATURE }, SIGNATURE, KEY)).toBe(true)
    expect(verifySignature(VECTOR, SIGNATURE.toUpperCase(), KEY)).toBe(true)
    expect(canonicalString({ ...VECTOR, x_signature: 'whatever' })).toBe(CANONICAL)
  })

  it('rejects the wrong key, tampered values, missing/extra fields and malformed signatures', () => {
    expect(verifySignature(VECTOR, SIGNATURE, 'other_key')).toBe(false)
    expect(verifySignature({ ...VECTOR, paid_amount: '210051' }, SIGNATURE, KEY)).toBe(false)
    expect(verifySignature({ ...VECTOR, paid: 'false' }, SIGNATURE, KEY)).toBe(false)
    const { id: _id, ...withoutId } = VECTOR // eslint-disable-line @typescript-eslint/no-unused-vars
    expect(verifySignature(withoutId, SIGNATURE, KEY)).toBe(false)
    expect(verifySignature({ ...VECTOR, extra: 'x' }, SIGNATURE, KEY)).toBe(false)
    for (const bad of ['', 'abc', SIGNATURE.slice(0, 63), SIGNATURE + '0', 'z'.repeat(64), ` ${SIGNATURE}`, SIGNATURE.slice(0, 63) + 'g']) {
      expect(verifySignature(VECTOR, bad, KEY), JSON.stringify(bad)).toBe(false)
    }
  })

  it('additional gateway fields are part of the signature once signed', () => {
    const withExtra = { ...VECTOR, bank_ref: 'ABC 123', amount_currency: 'MYR' }
    const sig = signFields(withExtra, KEY)
    expect(sig).not.toBe(SIGNATURE)
    expect(verifySignature(withExtra, sig, KEY)).toBe(true)
    expect(canonicalString(withExtra)).toBe('amount_currencyMYR|bank_refABC 123|' + CANONICAL.replace(/^/, ''))
  })

  it('sorts by character code, not locale: uppercase before lowercase, underscore after digits and capitals', () => {
    expect(canonicalString({ b: '1', B: '2', a: '3', _z: '4', '1': '5' })).toBe('15|B2|_z4|a3|b1')
  })
})

describe('malaysiaDate and paid_at parsing', () => {
  it('is independent of the process timezone and uses UTC+8', () => {
    expect(malaysiaDate(new Date('2026-03-01T15:59:59.999Z'))).toBe('2026-03-01')
    expect(malaysiaDate(new Date('2026-03-01T16:00:00.000Z'))).toBe('2026-03-02')
    expect(malaysiaDate(new Date('2026-12-31T16:00:00Z'))).toBe('2027-01-01')
  })

  it('converts the gateway Malaysia timestamp to the exact UTC instant', () => {
    expect(parseGatewayPaidAt('2026-04-01 00:30:12 +0800')!.toISOString()).toBe('2026-03-31T16:30:12.000Z')
    expect(parseGatewayPaidAt('2026-01-01 07:59:59 +0800')!.toISOString()).toBe('2025-12-31T23:59:59.000Z')
    expect(parseGatewayPaidAt('2028-02-29 12:00:00 +0800')!.toISOString()).toBe('2028-02-29T04:00:00.000Z')
  })

  it('rejects anything that is not exactly that shape, or not a real time', () => {
    for (const bad of ['', '2026-04-01 00:30:12', '2026-04-01 00:30:12 +0000', '2026-04-01 00:30:12 +08:00', '2026-04-01T00:30:12+0800', '2026-04-01 00:30:12 +0900', '2026-04-01 00:30:12 Z', '2026-02-30 10:00:00 +0800', '2026-13-01 10:00:00 +0800', '2026-04-01 24:00:00 +0800', '2026-04-01 10:60:00 +0800', '2026-04-01 10:00:60 +0800', '2027-02-29 10:00:00 +0800', '0000-01-01 00:00:00 +0800', ' 2026-04-01 00:30:12 +0800', '2026-04-01 00:30:12 +0800 ']) {
      expect(parseGatewayPaidAt(bad), JSON.stringify(bad)).toBeNull()
    }
  })
})
