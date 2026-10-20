/**
 * Read models for the UI. Every function takes the verified user id and enforces scope itself (Prisma bypasses RLS):
 * staff/managers see only their organizations, tenants only their own leases. Nothing here trusts client input.
 */
import { invoiceStatus } from '../../lib/billing'
import { malaysiaDate } from '../../lib/malaysia'
import { lastMalaysiaMonths } from '../../lib/format-my'
import { resolveLeaseAccess, type LeaseRole } from './access'
import { dateOnly, toSafeNumber } from './convert'
import type { Db } from './db'
import { HttpError } from './errors'
import { getLeaseDetail, type LeaseDetail } from './leases'
import { collectionsReport } from './reports'
import { resolveViewer } from './viewer'

interface InvoiceFact {
  leaseId: string
  dueDate: string
  amountSen: number
  paidSen: number
}

async function invoiceFacts(db: Db, where: { orgId?: { in: string[] }; leaseId?: { in: string[] } }): Promise<InvoiceFact[]> {
  const invoices = await db.invoice.findMany({ where, select: { id: true, leaseId: true, dueDate: true, amountSen: true } })
  const sums = await db.paymentAllocation.groupBy({ by: ['invoiceId'], where: { invoice: where }, _sum: { amountSen: true } })
  const paid = new Map(sums.map((s) => [s.invoiceId, toSafeNumber(s._sum.amountSen, 'paidSen')]))
  return invoices.map((i) => ({ leaseId: i.leaseId, dueDate: dateOnly(i.dueDate), amountSen: toSafeNumber(i.amountSen, 'amountSen'), paidSen: paid.get(i.id) ?? 0 }))
}

const isOverdue = (f: InvoiceFact, now: Date) => invoiceStatus(f, now) === 'overdue'
const dueNowSen = (facts: InvoiceFact[], today: string) => facts.reduce((sum, f) => (f.dueDate <= today ? sum + Math.max(0, f.amountSen - f.paidSen) : sum), 0)

export interface Dashboard {
  overdueInvoices: number
  pendingPayments: number
  collections: { month: string; collectedSen: number }[]
}

/** Staff and managers only. Collections cover the last six Malaysia calendar months, zero months included. */
export async function getDashboard(db: Db, userId: string, now: Date = new Date()): Promise<Dashboard> {
  const viewer = await resolveViewer(db, userId)
  if (viewer.staffOrgIds.length === 0) throw new HttpError(403, 'staff or manager access required')
  const months = lastMalaysiaMonths(now, 6)
  const [facts, pending, collections] = await Promise.all([
    invoiceFacts(db, { orgId: { in: viewer.staffOrgIds } }),
    db.payment.count({ where: { orgId: { in: viewer.staffOrgIds }, status: 'pending_verification' } }),
    collectionsReport(db, userId, months[0], months[months.length - 1]),
  ])
  return { overdueInvoices: facts.filter((f) => isOverdue(f, now)).length, pendingPayments: pending, collections }
}

export interface LeaseListItem {
  id: string
  unitName: string
  tenantName: string
  startDate: string
  endDate: string
  monthlyRentSen: number
  overdueInvoices: number
  /** Unpaid amount on invoices due on or before today's Malaysia date */
  dueNowSen: number
}

/** Staff/managers: leases of their organizations. Tenants: their own leases. Anyone else: nothing. */
export async function listLeases(db: Db, userId: string, now: Date = new Date()): Promise<LeaseListItem[]> {
  const viewer = await resolveViewer(db, userId)
  const where =
    viewer.staffOrgIds.length > 0
      ? { orgId: { in: viewer.staffOrgIds } }
      : viewer.tenants.length > 0
        ? { tenantId: { in: viewer.tenants.map((t) => t.id) }, orgId: { in: viewer.tenants.map((t) => t.orgId) } }
        : null
  if (!where) return []
  const leases = await db.lease.findMany({ where, include: { unit: { select: { name: true } }, tenant: { select: { fullName: true } } }, orderBy: [{ startDate: 'desc' }, { id: 'asc' }] })
  const facts = await invoiceFacts(db, { leaseId: { in: leases.map((l) => l.id) } })
  const today = malaysiaDate(now)
  return leases.map((l) => {
    const own = facts.filter((f) => f.leaseId === l.id)
    return {
      id: l.id,
      unitName: l.unit.name,
      tenantName: l.tenant.fullName,
      startDate: dateOnly(l.startDate),
      endDate: dateOnly(l.endDate),
      monthlyRentSen: toSafeNumber(l.monthlyRentSen, 'monthlyRentSen'),
      overdueInvoices: own.filter((f) => isOverdue(f, now)).length,
      dueNowSen: dueNowSen(own, today),
    }
  })
}

export interface LeasePage {
  role: LeaseRole
  orgId: string
  unitName: string
  tenant: { id: string; fullName: string; email: string; phone: string | null }
  detail: LeaseDetail
  /** payment id -> slip path. Staff/managers only (tenants cannot read slips). */
  slipPaths: Record<string, string>
  dueNowSen: number
}

/** 404 (via HttpError) unless the viewer may see the lease. */
export async function getLeasePage(db: Db, userId: string, leaseId: string, now: Date = new Date()): Promise<LeasePage> {
  const { lease, role } = await resolveLeaseAccess(db, userId, leaseId)
  const detail = await getLeaseDetail(db, userId, leaseId, now)
  const [unit, tenant, slips] = await Promise.all([
    db.unit.findUniqueOrThrow({ where: { id: lease.unitId }, select: { name: true } }),
    db.tenant.findUniqueOrThrow({ where: { id: lease.tenantId }, select: { id: true, fullName: true, email: true, phone: true } }),
    role === 'tenant' ? Promise.resolve([]) : db.payment.findMany({ where: { leaseId: lease.id, orgId: lease.orgId, slipPath: { not: null } }, select: { id: true, slipPath: true } }),
  ])
  const today = malaysiaDate(now)
  const dueNow = detail.invoices.reduce((sum, i) => (i.dueDate <= today ? sum + Math.max(0, i.amountSen - i.paidSen) : sum), 0)
  return {
    role,
    orgId: lease.orgId,
    unitName: unit.name,
    tenant,
    detail,
    slipPaths: Object.fromEntries(slips.flatMap((p) => (p.slipPath ? [[p.id, p.slipPath]] : []))),
    dueNowSen: dueNow,
  }
}
