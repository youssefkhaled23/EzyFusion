import type { NextRequest } from 'next/server'
import { getLeaseDetail } from '@/server/domain/leases'
import { getPrisma } from '@/server/db'
import { authenticate } from '@/server/http/auth'
import { handle, json } from '@/server/http/respond'

export function GET(request: NextRequest, ctx: RouteContext<'/api/leases/[id]'>) {
  return handle(async () => {
    const userId = await authenticate(request)
    const { id } = await ctx.params
    return json(await getLeaseDetail(getPrisma(), userId, id))
  })
}
