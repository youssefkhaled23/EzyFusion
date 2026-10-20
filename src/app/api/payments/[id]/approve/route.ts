import type { NextRequest } from 'next/server'
import { approvePayment } from '@/server/domain/payments'
import { getPrisma } from '@/server/db'
import { authenticate } from '@/server/http/auth'
import { handle, json } from '@/server/http/respond'

export function POST(request: NextRequest, ctx: RouteContext<'/api/payments/[id]/approve'>) {
  return handle(async () => {
    const userId = await authenticate(request)
    const { id } = await ctx.params
    return json(await approvePayment(getPrisma(), userId, id))
  })
}
