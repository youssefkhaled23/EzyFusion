import type { NextRequest } from 'next/server'
import { collectionsReport } from '@/server/domain/reports'
import { getPrisma } from '@/server/db'
import { authenticate } from '@/server/http/auth'
import { handle, json } from '@/server/http/respond'

export function GET(request: NextRequest) {
  return handle(async () => {
    const userId = await authenticate(request)
    const params = request.nextUrl.searchParams
    return json(await collectionsReport(getPrisma(), userId, params.get('from'), params.get('to')))
  })
}
