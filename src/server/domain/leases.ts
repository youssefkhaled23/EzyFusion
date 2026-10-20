import { randomUUID } from 'node:crypto'
import { compareForAllocation } from '../../lib/allocation'
import { generateSchedule, invoiceStatus, type InvoiceKind, type InvoiceStatus } from '../../lib/billing'
import { orgIdsWithRole, resolveLeaseAccess } from './access'
import { dateOnly, isUuid, toDateColumn, toSafeNumber } from './convert'
import type { Db } from './db'
import { HttpError, notFound } from './errors'

export interface CreateLeaseInput {
  unitId: string
  tenantId: string
  startDate: string
  endDate: string
  monthlyRentSen: number
  depositSen: number
}

/** Postgres exclusion_violation (23P01) raised by leases_unit_no_overlap, however the driver wraps it. */
const isOverlapViolation = (e: unknown) => /23P01|leases_unit_no_overlap|exclusion constraint/i.test(`${(e as Error)?.message ?? ''} ${JSON.stringify((e as { meta?: unknown })?.meta ?? '')}`)

/**
 * Manager only. Creates the lease and ALL its invoices (from generateSchedule) plus the audit row in ONE transaction.
 * Overlap protection is the database exclusion constraint, so concurrent requests cannot both succeed.
 */
export async function createLease(db: Db, actorUserId: string, input: CreateLeaseInput): Promise<{ id: string }> {
  const managerOrgs = await orgIdsWithRole(db, actorUserId, ['manager'])
  if (managerOrgs.length === 0) throw new HttpError(403, 'only managers can create leases')

  let schedule
  try {
    schedule = generateSchedule(input)
  } catch (e) {
    throw new HttpError(400, (e as Error).message)
  }
  if (!isUuid(input.unitId) || !isUuid(input.tenantId)) throw new HttpError(400, 'unitId and tenantId must be UUIDs')

  // Organization scope comes from the manager's memberships and the unit/tenant rows, never from the request.
  const unit = await db.unit.findFirst({ where: { id: input.unitId, orgId: { in: managerOrgs } } })
  if (!unit) throw notFound('unit not found')
  const tenant = await db.tenant.findFirst({ where: { id: input.tenantId, orgId: unit.orgId } })
  if (!tenant) throw notFound('tenant not found')

  const leaseId = randomUUID()
  try {
    await db.$transaction(
      async (tx) => {
        await tx.lease.create({
          data: {
            id: leaseId,
            orgId: unit.orgId,
            unitId: unit.id,
            tenantId: tenant.id,
            startDate: toDateColumn(input.startDate),
            endDate: toDateColumn(input.endDate),
            monthlyRentSen: BigInt(input.monthlyRentSen),
            depositSen: BigInt(input.depositSen),
          },
        })
        await tx.invoice.createMany({
          data: schedule.map((s) => ({
            id: randomUUID(),
            orgId: unit.orgId,
            leaseId,
            kind: s.kind,
            periodIndex: s.periodIndex,
            periodStart: s.periodStart ? toDateColumn(s.periodStart) : null,
            periodEnd: s.periodEnd ? toDateColumn(s.periodEnd) : null,
            dueDate: toDateColumn(s.dueDate),
            amountSen: BigInt(s.amountSen),
          })),
        })
        await tx.auditLog.create({
          data: {
            orgId: unit.orgId,
            actorId: actorUserId,
            action: 'lease.created',
            entityId: leaseId,
            details: { unitId: unit.id, tenantId: tenant.id, startDate: input.startDate, endDate: input.endDate, monthlyRentSen: input.monthlyRentSen, depositSen: input.depositSen, invoices: schedule.length },
          },
        })
      },
      { timeout: 20_000, maxWait: 20_000 },
    )
  } catch (e) {
    if (isOverlapViolation(e)) throw new HttpError(409, 'the unit already has a lease overlapping these dates')
    throw e
  }
  return { id: leaseId }
}

export interface LeaseFormOptions {
  organizations: {
    id: string
    name: string
    /** Units with the date ranges already leased (the database exclusion constraint stays the authority on overlaps). */
    units: { id: string; name: string; leases: { startDate: string; endDate: string }[] }[]
    tenants: { id: string; fullName: string; email: string }[]
  }[]
}

/** Manager only. The units and tenants of the organizations the caller manages: the choices for the Create Lease form. */
export async function getLeaseFormOptions(db: Db, actorUserId: string): Promise<LeaseFormOptions> {
  const managerOrgs = await orgIdsWithRole(db, actorUserId, ['manager'])
  if (managerOrgs.length === 0) throw new HttpError(403, 'only managers can create leases')
  const orgs = await db.organization.findMany({
    where: { id: { in: managerOrgs } },
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      units: { orderBy: { name: 'asc' }, select: { id: true, name: true, leases: { orderBy: { startDate: 'asc' }, select: { startDate: true, endDate: true } } } },
      tenants: { orderBy: { fullName: 'asc' }, select: { id: true, fullName: true, email: true } },
    },
  })
  return {
    organizations: orgs.map((o) => ({
      id: o.id,
      name: o.name,
      units: o.units.map((u) => ({ id: u.id, name: u.name, leases: u.leases.map((l) => ({ startDate: dateOnly(l.startDate), endDate: dateOnly(l.endDate) })) })),
      tenants: o.tenants,
    })),
  }
}

export interface LeaseDetail {
  lease: { id: string; unitId: string; tenantId: string; startDate: string; endDate: string; monthlyRentSen: number; depositSen: number }
  invoices: { id: string; kind: InvoiceKind; periodIndex: number | null; periodStart: string | null; periodEnd: string | null; dueDate: string; amountSen: number; paidSen: number; status: InvoiceStatus }[]
  payments: { id: string; amountSen: number; unappliedSen: number; method: string; status: string; receivedAt: string }[]
}

/** Visible to the lease's organization staff/managers and to the lease's own tenant; everyone else gets 404. */
export async function getLeaseDetail(db: Db, userId: string, leaseId: string, now: Date = new Date()): Promise<LeaseDetail> {
  const { lease } = await resolveLeaseAccess(db, userId, leaseId)
  const [invoices, sums, payments] = await Promise.all([
    db.invoice.findMany({ where: { leaseId: lease.id, orgId: lease.orgId } }),
    db.paymentAllocation.groupBy({ by: ['invoiceId'], where: { orgId: lease.orgId, invoice: { leaseId: lease.id } }, _sum: { amountSen: true } }),
    db.payment.findMany({ where: { leaseId: lease.id, orgId: lease.orgId }, orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }] }),
  ])
  const paid = new Map(sums.map((s) => [s.invoiceId, toSafeNumber(s._sum.amountSen, 'paidSen')]))

  const rows = invoices.map((i) => {
    const amountSen = toSafeNumber(i.amountSen, 'amountSen')
    const paidSen = paid.get(i.id) ?? 0
    const dueDate = dateOnly(i.dueDate)
    return {
      id: i.id,
      kind: i.kind as InvoiceKind,
      periodIndex: i.periodIndex,
      periodStart: i.periodStart ? dateOnly(i.periodStart) : null,
      periodEnd: i.periodEnd ? dateOnly(i.periodEnd) : null,
      dueDate,
      amountSen,
      paidSen,
      status: invoiceStatus({ dueDate, amountSen, paidSen }, now),
    }
  })
  rows.sort(compareForAllocation) // dueDate ASC, deposit before rent, periodIndex ASC (same order as allocation)

  return {
    lease: {
      id: lease.id,
      unitId: lease.unitId,
      tenantId: lease.tenantId,
      startDate: dateOnly(lease.startDate),
      endDate: dateOnly(lease.endDate),
      monthlyRentSen: toSafeNumber(lease.monthlyRentSen, 'monthlyRentSen'),
      depositSen: toSafeNumber(lease.depositSen, 'depositSen'),
    },
    invoices: rows,
    payments: payments.map((p) => ({
      id: p.id,
      amountSen: toSafeNumber(p.amountSen, 'amountSen'),
      unappliedSen: toSafeNumber(p.unappliedSen, 'unappliedSen'),
      method: p.method,
      status: p.status,
      receivedAt: p.receivedAt.toISOString(),
    })),
  }
}
