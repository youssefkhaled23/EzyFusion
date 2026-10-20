/**
 * Payment allocation rules. Pure module: integer sen only, no framework or database imports.
 * Persistence and locking live in src/server/domain/payments.ts.
 */
import type { InvoiceKind } from './billing'

export interface AllocatableInvoice {
  id: string
  kind: InvoiceKind
  periodIndex: number | null
  /** YYYY-MM-DD */
  dueDate: string
  amountSen: number
  /** SUM(payment_allocations.amount_sen) for this invoice */
  paidSen: number
}

export interface Allocation {
  invoiceId: string
  amountSen: number
}

export interface AllocationResult {
  allocations: Allocation[]
  /** Part of the payment that no invoice could absorb. Always 0 for manual payments (they are capped). */
  unappliedSen: number
}

/** Allocation order: due_date ASC, deposit before rent, then period_index ASC (id as a stable final tie-break). */
export function compareForAllocation(a: AllocatableInvoice, b: AllocatableInvoice): number {
  if (a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1 // YYYY-MM-DD sorts lexicographically
  if (a.kind !== b.kind) return a.kind === 'deposit' ? -1 : 1
  const ai = a.periodIndex ?? -1
  const bi = b.periodIndex ?? -1
  if (ai !== bi) return ai - bi
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

const isNonNegativeSafeInt = (n: number) => Number.isSafeInteger(n) && n >= 0

export const balanceSen = (invoice: Pick<AllocatableInvoice, 'amountSen' | 'paidSen'>) => invoice.amountSen - invoice.paidSen

/** SUM(invoice.amount_sen) - SUM(allocations.amount_sen) */
export function remainingBalanceSen(invoices: Pick<AllocatableInvoice, 'amountSen' | 'paidSen'>[]): number {
  let total = 0
  for (const inv of invoices) {
    if (!isNonNegativeSafeInt(inv.amountSen) || !isNonNegativeSafeInt(inv.paidSen)) throw new Error('invoice amounts must be non-negative integers')
    total += balanceSen(inv)
    if (!Number.isSafeInteger(total)) throw new RangeError('remaining balance exceeds the safe integer range')
  }
  return total
}

/** Largest NEW manual payment that fits: remainingBalance - pendingTotal (never negative). */
export function maxManualPaymentSen(remainingBalance: number, pendingTotal: number): number {
  return Math.max(0, remainingBalance - pendingTotal)
}

/**
 * Fills invoices in allocation order, each one completely before the next (future invoices included).
 * Fully paid invoices are skipped. Whatever is left over is returned as unappliedSen.
 */
export function allocatePayment(amountSen: number, invoices: AllocatableInvoice[]): AllocationResult {
  if (!Number.isSafeInteger(amountSen) || amountSen <= 0) throw new Error('payment amount must be a positive integer number of sen')
  const allocations: Allocation[] = []
  let left = amountSen
  for (const inv of [...invoices].sort(compareForAllocation)) {
    if (left === 0) break
    if (!isNonNegativeSafeInt(inv.amountSen) || !isNonNegativeSafeInt(inv.paidSen)) throw new Error('invoice amounts must be non-negative integers')
    const open = balanceSen(inv)
    if (open <= 0) continue
    const take = Math.min(open, left)
    allocations.push({ invoiceId: inv.id, amountSen: take })
    left -= take
  }
  return { allocations, unappliedSen: left }
}
