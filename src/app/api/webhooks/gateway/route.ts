import type { NextRequest } from 'next/server'
import { SIGNATURE_FIELD, verifySignature } from '@/lib/gateway-signature'
import { applyGatewayCallback } from '@/server/domain/gateway'
import { HttpError } from '@/server/domain/errors'
import { getPrisma } from '@/server/db'
import { handle, json } from '@/server/http/respond'

const MAX_BODY_CHARS = 64 * 1024
const REQUIRED = ['id', 'paid', 'paid_amount', 'paid_at', 'transaction_id', 'transaction_status'] as const

/**
 * Payment gateway callback. Not user-authenticated: the HMAC signature is the authentication. Order of checks:
 * signature (401) -> required fields (400) -> bill (404) -> amount (422) -> state transition (200).
 * Nothing about the payload, the secret or the expected signature is ever logged.
 */
export function POST(request: NextRequest) {
  return handle(async () => {
    const key = process.env.GATEWAY_X_SIGNATURE_KEY
    if (!key) {
      console.error('GATEWAY_X_SIGNATURE_KEY is not configured')
      throw new Error('webhook is not configured')
    }
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/x-www-form-urlencoded')) throw new HttpError(400, 'expected application/x-www-form-urlencoded')
    const raw = await request.text()
    if (raw.length > MAX_BODY_CHARS) throw new HttpError(400, 'body too large')

    const fields = new Map<string, string>()
    for (const [name, value] of new URLSearchParams(raw)) {
      if (fields.has(name)) throw new HttpError(401, 'invalid signature') // duplicate names make the canonical string ambiguous
      fields.set(name, value)
    }
    const signature = fields.get(SIGNATURE_FIELD)
    if (signature === undefined || !verifySignature(fields, signature, key)) throw new HttpError(401, 'invalid signature')

    for (const name of REQUIRED) if (!fields.has(name)) throw new HttpError(400, `missing field ${name}`)
    const result = await applyGatewayCallback(getPrisma(), {
      id: fields.get('id')!,
      paid: fields.get('paid')!,
      paidAmount: fields.get('paid_amount')!,
      paidAt: fields.get('paid_at')!,
      transactionId: fields.get('transaction_id')!,
    })
    return json({ received: true, billStatus: result.billStatus })
  })
}
