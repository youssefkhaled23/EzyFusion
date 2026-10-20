import type { NextRequest } from 'next/server'
import { createGatewayBill } from '@/server/domain/gateway'
import { getPrisma } from '@/server/db'
import { authenticate } from '@/server/http/auth'
import { handle, json } from '@/server/http/respond'

/** Tenant of the lease only. The request body is ignored: amount and tenant are always derived on the server. */
export function POST(request: NextRequest, ctx: RouteContext<'/api/leases/[id]/gateway-bills'>) {
  return handle(async () => {
    const userId = await authenticate(request)
    const { id } = await ctx.params
    return json(await createGatewayBill(getPrisma(), userId, id), 201)
  })
}
