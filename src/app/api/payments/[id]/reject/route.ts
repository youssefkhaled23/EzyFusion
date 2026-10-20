import type { NextRequest } from 'next/server'
import { rejectPayment } from '@/server/domain/payments'
import { getPrisma } from '@/server/db'
import { authenticate } from '@/server/http/auth'
import { handle, json, readJsonOrEmpty } from '@/server/http/respond'

export function POST(request: NextRequest, ctx: RouteContext<'/api/payments/[id]/reject'>) {
  return handle(async () => {
    const userId = await authenticate(request)
    const { id } = await ctx.params
    return json(await rejectPayment(getPrisma(), userId, id, (await readJsonOrEmpty(request)).reason))
  })
}
