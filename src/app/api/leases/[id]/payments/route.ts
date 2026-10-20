import type { NextRequest } from 'next/server'
import { resolveLeaseAccess } from '@/server/domain/access'
import { HttpError } from '@/server/domain/errors'
import { parseInstant, positiveSafeInt } from '@/server/domain/convert'
import { recordPayment } from '@/server/domain/payments'
import { getPrisma } from '@/server/db'
import { authenticate } from '@/server/http/auth'
import { handle, json, readJsonObject } from '@/server/http/respond'

export function POST(request: NextRequest, ctx: RouteContext<'/api/leases/[id]/payments'>) {
  return handle(async () => {
    const userId = await authenticate(request)
    const { id } = await ctx.params
    const db = getPrisma()
    // 404 for leases the caller cannot see; 403 for tenants (who can see their lease but may not record payments).
    const { role } = await resolveLeaseAccess(db, userId, id)
    if (role === 'tenant') throw new HttpError(403, 'tenants cannot record payments')

    const b = await readJsonObject(request)
    const amountSen = positiveSafeInt(b.amountSen, 'amountSen')
    if (b.method !== 'cash' && b.method !== 'bank_transfer') throw new HttpError(400, "method must be 'cash' or 'bank_transfer'")
    const receivedAt = parseInstant(b.receivedAt, 'receivedAt')
    if (b.slipPath !== undefined && typeof b.slipPath !== 'string') throw new HttpError(400, 'slipPath must be a string')

    const result = await recordPayment(db, userId, id, { amountSen, method: b.method, receivedAt, slipPath: b.slipPath as string | undefined })
    return json(result, 201)
  })
}
