import type { NextRequest } from 'next/server'
import { getLeaseFormOptions } from '@/server/domain/leases'
import { getPrisma } from '@/server/db'
import { authenticate } from '@/server/http/auth'
import { handle, json } from '@/server/http/respond'

/** Manager-only: units and tenants of the caller's own organizations (the choices for the Create Lease form). */
export function GET(request: NextRequest) {
  return handle(async () => {
    const userId = await authenticate(request)
    return json(await getLeaseFormOptions(getPrisma(), userId))
  })
}
