import { randomUUID } from 'node:crypto'
import { allocatePayment, maxManualPaymentSen, remainingBalanceSen, type AllocatableInvoice } from '../../lib/allocation'
import { resolveLeaseAccess, resolvePaymentAccess } from './access'
import { dateOnly, positiveSafeInt, reasonText, toSafeNumber } from './convert'
import type { Db, Tx } from './db'
import { HttpError, notFound } from './errors'
import { cleanupOrphanSlip, validateSlip } from './slips'

const TX = { timeout: 20_000, maxWait: 20_000 }

/**
 * THE per-lease lock. Every operation that changes payments, allocations or gateway bills for a lease (record, approve,
 * reject, void, and the future gateway webhook) must call this FIRST, inside its transaction, before it reads any balance.
 * It is a row lock in PostgreSQL (SELECT ... FOR UPDATE), so it serializes across processes and server instances.
 */
export async function lockLease(tx: Tx, leaseId: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`select id from public.leases where id = ${leaseId}::uuid for update`
  if (rows.length === 0) throw notFound('lease not found')
}

export interface LeaseState {
  invoices: AllocatableInvoice[]
  remainingBalanceSen: number
  pendingTotalSen: number
}

/** Must be called after lockLease(). */
export async function leaseState(tx: Tx, leaseId: string): Promise<LeaseState> {
  const [invoices, sums, pending] = await Promise.all([
    tx.invoice.findMany({ where: { leaseId } }),
    tx.paymentAllocation.groupBy({ by: ['invoiceId'], where: { invoice: { leaseId } }, _sum: { amountSen: true } }),
    tx.payment.aggregate({ where: { leaseId, status: 'pending_verification' }, _sum: { amountSen: true } }),
  ])
  const paid = new Map(sums.map((s) => [s.invoiceId, toSafeNumber(s._sum.amountSen, 'paidSen')]))
  const rows: AllocatableInvoice[] = invoices.map((i) => ({
    id: i.id,
    kind: i.kind as AllocatableInvoice['kind'],
    periodIndex: i.periodIndex,
    dueDate: dateOnly(i.dueDate),
    amountSen: toSafeNumber(i.amountSen, 'amountSen'),
    paidSen: paid.get(i.id) ?? 0,
  }))
  return { invoices: rows, remainingBalanceSen: remainingBalanceSen(rows), pendingTotalSen: toSafeNumber(pending._sum.amountSen, 'pendingTotal') }
}

/** Writes allocation rows for an approved payment. Returns the unapplied remainder (always 0 when !allowUnapplied). */
export async function allocate(tx: Tx, payment: { id: string; orgId: string; amountSen: number }, invoices: AllocatableInvoice[], allowUnapplied: boolean): Promise<number> {
  const result = allocatePayment(payment.amountSen, invoices)
  if (result.unappliedSen > 0 && !allowUnapplied) throw new HttpError(422, 'payment exceeds the remaining balance of the lease')
  if (result.allocations.length > 0) {
    await tx.paymentAllocation.createMany({
      data: result.allocations.map((a) => ({ id: randomUUID(), orgId: payment.orgId, paymentId: payment.id, invoiceId: a.invoiceId, amountSen: BigInt(a.amountSen) })),
    })
  }
  return result.unappliedSen
}

export const audit = (tx: Tx, orgId: string, actorId: string | null, action: string, entityId: string, details: Record<string, unknown>) =>
  tx.auditLog.create({ data: { orgId, actorId, action, entityId, details: details as never } })

export interface RecordPaymentInput {
  amountSen: number
  method: 'cash' | 'bank_transfer'
  receivedAt: Date
  slipPath?: string
}

/**
 * Staff and managers record manual payments. Managers' payments are approved (and allocated) immediately; staff
 * payments wait as pending_verification. Cap: amount <= remainingBalance - pendingTotal, checked under the lease lock.
 */
export async function recordPayment(db: Db, userId: string, leaseId: string, input: RecordPaymentInput): Promise<{ id: string; status: string }> {
  const { lease, role } = await resolveLeaseAccess(db, userId, leaseId)
  if (role === 'tenant') throw new HttpError(403, 'tenants cannot record payments')
  positiveSafeInt(input.amountSen, 'amountSen')

  let slipPath: string | undefined
  if (input.slipPath !== undefined) {
    if (input.method !== 'bank_transfer') throw new HttpError(400, 'only bank_transfer payments can carry a slip')
    slipPath = await validateSlip(db, lease.orgId, input.slipPath)
  }

  const id = randomUUID()
  const status = role === 'manager' ? 'approved' : 'pending_verification'
  try {
    await db.$transaction(async (tx) => {
      await lockLease(tx, lease.id)
      const state = await leaseState(tx, lease.id)
      const max = maxManualPaymentSen(state.remainingBalanceSen, state.pendingTotalSen)
      if (input.amountSen > max) throw new HttpError(422, `amount exceeds the maximum payable for this lease (${max} sen)`)

      await tx.payment.create({
        data: { id, orgId: lease.orgId, leaseId: lease.id, amountSen: BigInt(input.amountSen), unappliedSen: 0n, method: input.method, status, receivedAt: input.receivedAt, slipPath: slipPath ?? null },
      })
      await audit(tx, lease.orgId, userId, 'payment.recorded', id, { amountSen: input.amountSen, method: input.method, status, slipPath: slipPath ?? null })
      if (status === 'approved') {
        await allocate(tx, { id, orgId: lease.orgId, amountSen: input.amountSen }, state.invoices, false)
        await audit(tx, lease.orgId, userId, 'payment.approved', id, { automatic: true })
      }
    }, TX)
  } catch (e) {
    if (slipPath) await cleanupOrphanSlip(db, lease.orgId, slipPath) // the upload belongs to a payment that was not recorded
    throw e
  }
  return { id, status }
}

/** Manager only. pending_verification -> approved; allocates and re-checks against the remaining balance. */
export async function approvePayment(db: Db, userId: string, paymentId: string): Promise<{ status: 'approved' }> {
  const { lease, role } = await resolvePaymentAccess(db, userId, paymentId)
  if (role !== 'manager') throw new HttpError(403, 'only managers can approve payments')

  await db.$transaction(async (tx) => {
    await lockLease(tx, lease.id)
    const payment = await tx.payment.findUnique({ where: { id: paymentId } }) // re-read AFTER taking the lock
    if (!payment) throw notFound('payment not found')
    if (payment.status !== 'pending_verification') throw new HttpError(409, `payment is ${payment.status}, only pending_verification payments can be approved`)
    const amountSen = toSafeNumber(payment.amountSen, 'amountSen')
    const state = await leaseState(tx, lease.id)
    if (amountSen > state.remainingBalanceSen) throw new HttpError(422, 'payment exceeds the remaining balance of the lease')

    const unapplied = await allocate(tx, { id: payment.id, orgId: payment.orgId, amountSen }, state.invoices, payment.method === 'online')
    await tx.payment.update({ where: { id: payment.id }, data: { status: 'approved', unappliedSen: BigInt(unapplied) } })
    await audit(tx, payment.orgId, userId, 'payment.approved', payment.id, { amountSen })
  }, TX)
  return { status: 'approved' }
}

/** Manager only. pending_verification -> rejected (reason required, kept in the audit log). */
export async function rejectPayment(db: Db, userId: string, paymentId: string, reasonInput: unknown): Promise<{ status: 'rejected' }> {
  const { lease, role } = await resolvePaymentAccess(db, userId, paymentId)
  if (role !== 'manager') throw new HttpError(403, 'only managers can reject payments')
  const reason = reasonText(reasonInput)

  await db.$transaction(async (tx) => {
    await lockLease(tx, lease.id)
    const payment = await tx.payment.findUnique({ where: { id: paymentId } })
    if (!payment) throw notFound('payment not found')
    if (payment.status !== 'pending_verification') throw new HttpError(409, `payment is ${payment.status}, only pending_verification payments can be rejected`)
    await tx.payment.update({ where: { id: payment.id }, data: { status: 'rejected', unappliedSen: 0n } })
    await audit(tx, payment.orgId, userId, 'payment.rejected', payment.id, { reason })
  }, TX)
  return { status: 'rejected' }
}

/**
 * Manager only. approved -> voided. Removes ONLY this payment's allocations; other payments are not reallocated and
 * the payment row is kept.
 */
export async function voidPayment(db: Db, userId: string, paymentId: string, reasonInput: unknown): Promise<{ status: 'voided' }> {
  const { lease, role } = await resolvePaymentAccess(db, userId, paymentId)
  if (role !== 'manager') throw new HttpError(403, 'only managers can void payments')
  const reason = reasonText(reasonInput)

  await db.$transaction(async (tx) => {
    await lockLease(tx, lease.id)
    const payment = await tx.payment.findUnique({ where: { id: paymentId } })
    if (!payment) throw notFound('payment not found')
    if (payment.status !== 'approved') throw new HttpError(409, `payment is ${payment.status}, only approved payments can be voided`)
    const removed = await tx.paymentAllocation.deleteMany({ where: { paymentId: payment.id } })
    await tx.payment.update({ where: { id: payment.id }, data: { status: 'voided', unappliedSen: 0n } })
    await audit(tx, payment.orgId, userId, 'payment.voided', payment.id, { reason, allocationsRemoved: removed.count, amountSen: toSafeNumber(payment.amountSen, 'amountSen') })
  }, TX)
  return { status: 'voided' }
}
