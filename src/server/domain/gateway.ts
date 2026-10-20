import { randomUUID } from 'node:crypto'
import { malaysiaDate, parseGatewayPaidAt } from '../../lib/malaysia'
import { resolveLeaseAccess } from './access'
import { isUuid, toSafeNumber } from './convert'
import type { Db } from './db'
import { HttpError, notFound } from './errors'
import { allocate, audit, leaseState, lockLease } from './payments'

const TX = { timeout: 20_000, maxWait: 20_000 }

/**
 * Tenant only (the tenant who owns the lease). Bill amount = unpaid balance of every invoice due on or before today's
 * Malaysia date. Takes the per-lease lock, so it is consistent with concurrent payments and webhooks.
 * The amount and the tenant come from the server, never from the client.
 */
export async function createGatewayBill(db: Db, userId: string, leaseId: string, now: Date = new Date()): Promise<{ billId: string; amountSen: number }> {
  const { lease, role } = await resolveLeaseAccess(db, userId, leaseId)
  if (role !== 'tenant') throw new HttpError(403, 'only the tenant of this lease can create a payment bill')
  const today = malaysiaDate(now)

  return db.$transaction(async (tx) => {
    await lockLease(tx, lease.id)
    const state = await leaseState(tx, lease.id)
    let amountSen = 0
    for (const inv of state.invoices) if (inv.dueDate <= today) amountSen += Math.max(0, inv.amountSen - inv.paidSen)
    if (!Number.isSafeInteger(amountSen)) throw new RangeError('bill amount exceeds the safe integer range')
    if (amountSen <= 0) throw new HttpError(422, 'nothing is due on this lease')

    const billId = randomUUID() // CSPRNG, unpredictable
    await tx.gatewayBill.create({ data: { id: billId, orgId: lease.orgId, leaseId: lease.id, amountSen: BigInt(amountSen), status: 'pending' } })
    await audit(tx, lease.orgId, userId, 'gateway_bill.created', billId, { amountSen, dueOn: today })
    return { billId, amountSen }
  }, TX)
}

export interface GatewayCallback {
  id: string
  paid: string
  paidAmount: string
  paidAt: string
  transactionId: string
}

export type BillStatus = 'pending' | 'paid' | 'failed'

const isUniqueViolation = (e: unknown) => /P2002|23505|gateway_bill_id/i.test(`${(e as Error)?.message ?? ''} ${(e as { code?: string })?.code ?? ''}`)

/**
 * Applies a signature-verified gateway callback. Everything that depends on bill state happens INSIDE the transaction
 * that holds the per-lease lock (the same lock manual payments use), so concurrent callbacks serialize:
 *   paid=true  : amount must equal the bill exactly (422). pending|failed -> paid + exactly one approved online payment
 *                that is allocated (leftover -> unapplied_sen). Already paid -> no change.
 *   paid=false : pending -> failed. failed -> no change. paid is terminal -> no change.
 * The payment amount is the BILL's amount, never the callback's.
 */
export async function applyGatewayCallback(db: Db, cb: GatewayCallback): Promise<{ billStatus: BillStatus; changed: boolean }> {
  if (cb.paid !== 'true' && cb.paid !== 'false') throw new HttpError(400, 'paid must be "true" or "false"')
  if (cb.transactionId.length === 0 || cb.transactionId.length > 128) throw new HttpError(400, 'invalid transaction_id')
  const paid = cb.paid === 'true'
  let receivedAt: Date | null = null
  if (paid) {
    receivedAt = parseGatewayPaidAt(cb.paidAt)
    if (!receivedAt) throw new HttpError(400, 'paid_at must be "YYYY-MM-DD HH:mm:ss +0800"')
  }

  const first = isUuid(cb.id) ? await db.gatewayBill.findUnique({ where: { id: cb.id }, select: { leaseId: true } }) : null
  if (!first) throw notFound('bill not found')

  try {
    return await db.$transaction(async (tx) => {
      await lockLease(tx, first.leaseId)
      const bill = await tx.gatewayBill.findUnique({ where: { id: cb.id } }) // status is read AFTER the lock
      if (!bill) throw notFound('bill not found')
      const status = bill.status as BillStatus

      if (!paid) {
        if (status !== 'pending') return { billStatus: status, changed: false } // failed stays failed, paid is terminal
        await tx.gatewayBill.update({ where: { id: bill.id }, data: { status: 'failed' } })
        await audit(tx, bill.orgId, null, 'gateway_bill.failed', bill.id, { transactionId: cb.transactionId })
        return { billStatus: 'failed', changed: true }
      }

      // paid=true: the callback amount must be exactly the bill amount (canonical integer string, no sign/decimals/padding)
      if (cb.paidAmount !== bill.amountSen.toString()) throw new HttpError(422, 'paid_amount does not match the bill amount')
      if (status === 'paid') return { billStatus: 'paid', changed: false }

      const amountSen = toSafeNumber(bill.amountSen, 'amountSen')
      const paymentId = randomUUID()
      await tx.payment.create({
        data: { id: paymentId, orgId: bill.orgId, leaseId: bill.leaseId, amountSen: bill.amountSen, unappliedSen: 0n, method: 'online', status: 'approved', receivedAt: receivedAt!, gatewayBillId: bill.id },
      })
      const state = await leaseState(tx, bill.leaseId)
      // allocate() skips paid invoices, includes future ones, and returns what no invoice could absorb
      const unapplied = await allocate(tx, { id: paymentId, orgId: bill.orgId, amountSen }, state.invoices, true)
      if (unapplied > 0) await tx.payment.update({ where: { id: paymentId }, data: { unappliedSen: BigInt(unapplied) } })
      await tx.gatewayBill.update({ where: { id: bill.id }, data: { status: 'paid' } })
      await audit(tx, bill.orgId, null, 'payment.online_received', paymentId, { billId: bill.id, transactionId: cb.transactionId, amountSen, unappliedSen: unapplied })
      return { billStatus: 'paid', changed: true }
    }, TX)
  } catch (e) {
    // UNIQUE(payments.gateway_bill_id) is the last line of defence; if it ever fires, the bill was already settled.
    if (isUniqueViolation(e)) {
      const bill = await db.gatewayBill.findUnique({ where: { id: cb.id }, select: { status: true } })
      if (bill?.status === 'paid') return { billStatus: 'paid', changed: false }
      throw new HttpError(409, 'conflicting payment state')
    }
    throw e
  }
}

/** Bill details for the return page: only the tenant who owns the lease behind the bill may see it. */
export async function getBillForTenant(db: Db, userId: string, billId: string): Promise<{ status: BillStatus; amountSen: number } | null> {
  if (!isUuid(billId)) return null
  const bill = await db.gatewayBill.findUnique({ where: { id: billId } })
  if (!bill) return null
  const tenant = await db.tenant.findFirst({ where: { userId, orgId: bill.orgId, leases: { some: { id: bill.leaseId } } }, select: { id: true } })
  if (!tenant) return null
  return { status: bill.status as BillStatus, amountSen: toSafeNumber(bill.amountSen, 'amountSen') }
}
