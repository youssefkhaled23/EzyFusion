import type { NextRequest } from 'next/server'
import { orgIdsWithRole } from '@/server/domain/access'
import { createLease } from '@/server/domain/leases'
import { HttpError } from '@/server/domain/errors'
import { getPrisma } from '@/server/db'
import { authenticate } from '@/server/http/auth'
import { handle, json, readJsonObject } from '@/server/http/respond'

export function POST(request: NextRequest) {
  return handle(async () => {
    const userId = await authenticate(request)
    const db = getPrisma()
    if ((await orgIdsWithRole(db, userId, ['manager'])).length === 0) throw new HttpError(403, 'only managers can create leases')

    const b = await readJsonObject(request)
    const strings = ['unitId', 'tenantId', 'startDate', 'endDate'] as const
    for (const key of strings) if (typeof b[key] !== 'string') throw new HttpError(400, `${key} must be a string`)
    for (const key of ['monthlyRentSen', 'depositSen'] as const) if (typeof b[key] !== 'number') throw new HttpError(400, `${key} must be a number`)

    const { id } = await createLease(db, userId, {
      unitId: b.unitId as string,
      tenantId: b.tenantId as string,
      startDate: b.startDate as string,
      endDate: b.endDate as string,
      monthlyRentSen: b.monthlyRentSen as number,
      depositSen: b.depositSen as number,
    })
    return json({ id }, 201)
  })
}
