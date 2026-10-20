import { describe, expect, it } from 'vitest'
import { allocatePayment, compareForAllocation, maxManualPaymentSen, remainingBalanceSen, type AllocatableInvoice } from '../src/lib/allocation'
import { generateSchedule } from '../src/lib/billing'

const fromSchedule = (paid: Record<string, number> = {}): AllocatableInvoice[] =>
  generateSchedule({ startDate: '2026-01-31', endDate: '2026-07-15', monthlyRentSen: 150000, depositSen: 300000 }).map((s) => {
    const id = s.kind === 'deposit' ? 'deposit' : `rent${s.periodIndex}`
    return { id, kind: s.kind, periodIndex: s.periodIndex, dueDate: s.dueDate, amountSen: s.amountSen, paidSen: paid[id] ?? 0 }
  })

describe('allocation order', () => {
  it('due date ASC, then deposit before rent, then period index', () => {
    const shuffled = [...fromSchedule()].reverse()
    expect([...shuffled].sort(compareForAllocation).map((i) => i.id)).toEqual(['deposit', 'rent0', 'rent1', 'rent2', 'rent3', 'rent4', 'rent5'])
  })

  it('deposit and rent 0 share a due date: the deposit still comes first', () => {
    const [d, r0] = fromSchedule()
    expect(d.dueDate).toBe(r0.dueDate)
    expect(compareForAllocation(d, r0)).toBeLessThan(0)
    expect(compareForAllocation(r0, d)).toBeGreaterThan(0)
  })
})

describe('allocatePayment', () => {
  it("Aisyah's two payments: 300000 -> deposit; 200000 -> rent 0 in full then 50000 of rent 1", () => {
    const first = allocatePayment(300000, fromSchedule())
    expect(first).toEqual({ allocations: [{ invoiceId: 'deposit', amountSen: 300000 }], unappliedSen: 0 })
    const second = allocatePayment(200000, fromSchedule({ deposit: 300000 }))
    expect(second).toEqual({ allocations: [{ invoiceId: 'rent0', amountSen: 150000 }, { invoiceId: 'rent1', amountSen: 50000 }], unappliedSen: 0 })
  })

  it('fills each invoice completely before moving on and tops up partially paid invoices first', () => {
    const r = allocatePayment(120000, fromSchedule({ deposit: 300000, rent0: 150000, rent1: 100000 }))
    expect(r.allocations).toEqual([{ invoiceId: 'rent1', amountSen: 50000 }, { invoiceId: 'rent2', amountSen: 70000 }])
    expect(r.unappliedSen).toBe(0)
  })

  it('includes future invoices', () => {
    const r = allocatePayment(300000 + 5 * 150000 + 77419, fromSchedule())
    expect(r.allocations).toHaveLength(7)
    expect(r.allocations.at(-1)).toEqual({ invoiceId: 'rent5', amountSen: 77419 }) // the last (future) invoice is included
    expect(r.unappliedSen).toBe(0)
  })

  it('returns the remainder as unapplied when everything is paid (online payments only)', () => {
    const total = 300000 + 5 * 150000 + 77419
    const r = allocatePayment(total + 1234, fromSchedule())
    expect(r.unappliedSen).toBe(1234)
    expect(r.allocations.reduce((s, a) => s + a.amountSen, 0)).toBe(total)
  })

  it('skips fully paid invoices and allocates nothing when no balance remains', () => {
    const all = fromSchedule()
    const paid = Object.fromEntries(all.map((i) => [i.id, i.amountSen]))
    expect(allocatePayment(500, fromSchedule(paid))).toEqual({ allocations: [], unappliedSen: 500 })
  })

  it('never allocates more than the payment or more than an invoice balance, to the sen', () => {
    for (const amount of [1, 149999, 150000, 150001, 299999, 300001, 777777]) {
      const r = allocatePayment(amount, fromSchedule())
      expect(r.allocations.reduce((s, a) => s + a.amountSen, 0) + r.unappliedSen).toBe(amount)
      for (const a of r.allocations) expect(a.amountSen).toBeLessThanOrEqual(fromSchedule().find((i) => i.id === a.invoiceId)!.amountSen)
    }
  })

  it('does not mutate its input and rejects invalid amounts', () => {
    const invoices = fromSchedule()
    const copy = JSON.stringify(invoices)
    allocatePayment(1000, invoices)
    expect(JSON.stringify(invoices)).toBe(copy)
    for (const bad of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(() => allocatePayment(bad, invoices)).toThrow(Error)
  })
})

describe('remaining balance and manual cap', () => {
  it('remainingBalance = SUM(amount) - SUM(paid)', () => {
    expect(remainingBalanceSen(fromSchedule())).toBe(300000 + 5 * 150000 + 77419)
    expect(remainingBalanceSen(fromSchedule({ deposit: 300000, rent0: 1 }))).toBe(300000 + 5 * 150000 + 77419 - 300000 - 1)
  })

  it('maximum new manual payment = remaining - pending, floored at 0', () => {
    expect(maxManualPaymentSen(1000, 400)).toBe(600)
    expect(maxManualPaymentSen(1000, 1000)).toBe(0)
    expect(maxManualPaymentSen(1000, 1500)).toBe(0)
  })
})
