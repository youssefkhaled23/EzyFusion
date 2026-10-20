/**
 * Authorization lookups. Prisma connects as the database owner and BYPASSES RLS, so every decision about who may
 * see or do what is made here, from rows in memberships / tenants, never from client-supplied roles or org ids.
 */
import type { Db } from './db'
import { isUuid } from './convert'
import { notFound } from './errors'

export type LeaseRole = 'manager' | 'staff' | 'tenant'

export interface LeaseRow {
  id: string
  orgId: string
  unitId: string
  tenantId: string
  startDate: Date
  endDate: Date
  monthlyRentSen: bigint
  depositSen: bigint
}

export const orgIdsWithRole = async (db: Db, userId: string, roles: ('manager' | 'staff')[]): Promise<string[]> =>
  (await db.membership.findMany({ where: { userId, role: { in: roles } }, select: { orgId: true } })).map((m) => m.orgId)

/** A visible lease plus the caller's role on it; throws 404 when the caller may not see it (or it does not exist). */
export async function resolveLeaseAccess(db: Db, userId: string, leaseId: string): Promise<{ lease: LeaseRow; role: LeaseRole }> {
  if (!isUuid(leaseId)) throw notFound('lease not found')
  const lease = await db.lease.findUnique({ where: { id: leaseId } })
  if (!lease) throw notFound('lease not found')
  const membership = await db.membership.findUnique({ where: { userId_orgId: { userId, orgId: lease.orgId } }, select: { role: true } })
  if (membership?.role === 'manager' || membership?.role === 'staff') return { lease, role: membership.role }
  const tenant = await db.tenant.findFirst({ where: { id: lease.tenantId, orgId: lease.orgId, userId }, select: { id: true } })
  if (tenant) return { lease, role: 'tenant' }
  throw notFound('lease not found')
}

export async function resolvePaymentAccess(db: Db, userId: string, paymentId: string) {
  if (!isUuid(paymentId)) throw notFound('payment not found')
  const payment = await db.payment.findUnique({ where: { id: paymentId } })
  if (!payment) throw notFound('payment not found')
  try {
    const { lease, role } = await resolveLeaseAccess(db, userId, payment.leaseId)
    return { payment, lease, role }
  } catch {
    throw notFound('payment not found')
  }
}
