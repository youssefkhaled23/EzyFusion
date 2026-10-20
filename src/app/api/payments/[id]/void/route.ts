import type { NextRequest } from 'next/server'
import { voidPayment } from '@/server/domain/payments'
import { getPrisma } from '@/server/db'
import { authenticate } from '@/server/http/auth'
import { handle, json, readJsonOrEmpty } from '@/server/http/respond'

export function POST(request: NextRequest, ctx: RouteContext<'/api/payments/[id]/void'>) {
  return handle(async () => {
    const userId = await authenticate(request)
    const { id } = await ctx.params
    return json(await voidPayment(getPrisma(), userId, id, (await readJsonOrEmpty(request)).reason))
  })
}
