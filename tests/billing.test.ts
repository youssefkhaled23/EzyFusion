import { describe, expect, it } from 'vitest'
import {
  generateSchedule,
  invoiceStatus,
  parseRinggitToSen,
  type ScheduledInvoice,
} from '../src/lib/billing'

const lease = (over: Partial<Parameters<typeof generateSchedule>[0]> = {}) => ({
  startDate: '2026-01-31',
  endDate: '2026-07-15',
  monthlyRentSen: 150000,
  depositSen: 300000,
  ...over,
})
const rent = (invoices: ScheduledInvoice[]) => invoices.filter((i) => i.kind === 'rent')
const starts = (invoices: ScheduledInvoice[]) => rent(invoices).map((i) => i.periodStart)

describe('generateSchedule: required worked example', () => {
  it('matches the brief exactly', () => {
    expect(generateSchedule(lease())).toEqual([
      { kind: 'deposit', periodIndex: null, periodStart: null, periodEnd: null, dueDate: '2026-01-31', amountSen: 300000 },
      { kind: 'rent', periodIndex: 0, periodStart: '2026-01-31', periodEnd: '2026-02-27', dueDate: '2026-01-31', amountSen: 150000 },
      { kind: 'rent', periodIndex: 1, periodStart: '2026-02-28', periodEnd: '2026-03-30', dueDate: '2026-02-28', amountSen: 150000 },
      { kind: 'rent', periodIndex: 2, periodStart: '2026-03-31', periodEnd: '2026-04-29', dueDate: '2026-03-31', amountSen: 150000 },
      { kind: 'rent', periodIndex: 3, periodStart: '2026-04-30', periodEnd: '2026-05-30', dueDate: '2026-04-30', amountSen: 150000 },
      { kind: 'rent', periodIndex: 4, periodStart: '2026-05-31', periodEnd: '2026-06-29', dueDate: '2026-05-31', amountSen: 150000 },
      { kind: 'rent', periodIndex: 5, periodStart: '2026-06-30', periodEnd: '2026-07-15', dueDate: '2026-06-30', amountSen: 77419 },
    ])
  })

  it('final period charges 16 of 31 days (150000 * 16 / 31 = 77419.35 -> 77419)', () => {
    const last = rent(generateSchedule(lease())).at(-1)!
    expect(last.amountSen).toBe(77419)
  })
})

describe('generateSchedule: deposit', () => {
  it('emits the deposit first, due on startDate, with null period fields', () => {
    const [first, second] = generateSchedule(lease())
    expect(first).toEqual({ kind: 'deposit', periodIndex: null, periodStart: null, periodEnd: null, dueDate: '2026-01-31', amountSen: 300000 })
    expect(second.kind).toBe('rent')
  })

  it('omits the deposit when depositSen is 0', () => {
    const invoices = generateSchedule(lease({ depositSen: 0 }))
    expect(invoices.some((i) => i.kind === 'deposit')).toBe(false)
    expect(invoices[0].kind).toBe('rent')
  })
})

describe('generateSchedule: month-end anchors come from the ORIGINAL start date', () => {
  const anchors = (startDate: string, endDate: string) => starts(generateSchedule(lease({ startDate, endDate, depositSen: 0 })))

  it('Jan 31 (non-leap): Feb 28, Mar 31, Apr 30, May 31, Jun 30', () => {
    expect(anchors('2026-01-31', '2026-06-30')).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30'])
  })

  it('Jan 30 (non-leap): Feb 28, Mar 30', () => {
    expect(anchors('2026-01-30', '2026-04-30')).toEqual(['2026-01-30', '2026-02-28', '2026-03-30', '2026-04-30'])
  })

  it('Jan 29 (non-leap): Feb 28, Mar 29', () => {
    expect(anchors('2026-01-29', '2026-04-29')).toEqual(['2026-01-29', '2026-02-28', '2026-03-29', '2026-04-29'])
  })

  it('Jan 29/30/31 in a leap year clamp to Feb 29 (Jan 29 is not clamped at all)', () => {
    expect(anchors('2028-01-29', '2028-03-29')).toEqual(['2028-01-29', '2028-02-29', '2028-03-29'])
    expect(anchors('2028-01-30', '2028-03-30')).toEqual(['2028-01-30', '2028-02-29', '2028-03-30'])
    expect(anchors('2028-01-31', '2028-03-31')).toEqual(['2028-01-31', '2028-02-29', '2028-03-31'])
  })

  it('never drifts: a Jan 31 start still lands on the 31st after a clamped month', () => {
    const list = anchors('2026-01-31', '2026-03-31')
    expect(list[2]).toBe('2026-03-31') // from the previous anchor it would be 2026-03-28
  })

  it('Feb 29 start returns to Feb 29 only in leap years', () => {
    const list = starts(generateSchedule(lease({ startDate: '2028-02-29', endDate: '2032-02-29', depositSen: 0 })))
    expect(list[0]).toBe('2028-02-29')
    expect(list[12]).toBe('2029-02-28')
    expect(list[24]).toBe('2030-02-28')
    expect(list[36]).toBe('2031-02-28')
    expect(list[48]).toBe('2032-02-29')
    expect(list[1]).toBe('2028-03-29')
  })

  it('crosses year boundaries (Dec 31 -> Jan 31 -> Feb 28)', () => {
    expect(anchors('2026-12-31', '2027-03-31')).toEqual(['2026-12-31', '2027-01-31', '2027-02-28', '2027-03-31'])
  })

  it('period ends are inclusive and chain without gaps or overlaps', () => {
    const list = rent(generateSchedule(lease({ startDate: '2026-01-31', endDate: '2027-01-30', depositSen: 0 })))
    for (let i = 1; i < list.length; i++) {
      const prevEnd = new Date(`${list[i - 1].periodEnd}T00:00:00Z`).getTime()
      const start = new Date(`${list[i].periodStart}T00:00:00Z`).getTime()
      expect(start - prevEnd).toBe(86_400_000)
    }
  })
})

describe('generateSchedule: leap-year period lengths', () => {
  it('February 2028 period is 29 days long: proration uses 29 as the full period', () => {
    // start Feb 1 2028, end Feb 10 2028: 10 of 29 days
    const [only] = generateSchedule(lease({ startDate: '2028-02-01', endDate: '2028-02-10', depositSen: 0, monthlyRentSen: 290000 }))
    expect(only.periodEnd).toBe('2028-02-10')
    expect(only.amountSen).toBe(100000) // 290000 * 10 / 29
  })

  it('same dates in a non-leap year use 28 days', () => {
    const [only] = generateSchedule(lease({ startDate: '2027-02-01', endDate: '2027-02-10', depositSen: 0, monthlyRentSen: 280000 }))
    expect(only.amountSen).toBe(100000) // 280000 * 10 / 28
  })

  it('a lease ending exactly on Feb 29 (leap) is a full month with no proration', () => {
    const list = rent(generateSchedule(lease({ startDate: '2028-02-01', endDate: '2028-02-29', depositSen: 0 })))
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ periodStart: '2028-02-01', periodEnd: '2028-02-29', amountSen: 150000 })
  })
})

describe('generateSchedule: one-day and boundary leases', () => {
  it('start == end produces one prorated rent period of 1 day', () => {
    const invoices = generateSchedule(lease({ startDate: '2026-04-01', endDate: '2026-04-01', monthlyRentSen: 300000, depositSen: 0 }))
    expect(invoices).toEqual([
      { kind: 'rent', periodIndex: 0, periodStart: '2026-04-01', periodEnd: '2026-04-01', dueDate: '2026-04-01', amountSen: 10000 }, // 300000 / 30
    ])
  })

  it('one-day lease on a clamped start date', () => {
    const [only] = generateSchedule(lease({ startDate: '2026-01-31', endDate: '2026-01-31', monthlyRentSen: 280000, depositSen: 0 }))
    expect(only.periodEnd).toBe('2026-01-31')
    expect(only.amountSen).toBe(10000) // anchor 1 is Feb 28 -> full period 28 days
  })

  it('endDate on the last day of the natural period: one full-price period, no extra period', () => {
    const list = rent(generateSchedule(lease({ startDate: '2026-01-01', endDate: '2026-01-31', depositSen: 0 })))
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ periodEnd: '2026-01-31', amountSen: 150000 })
  })

  it('endDate exactly on the next anchor adds a one-day prorated period', () => {
    const list = rent(generateSchedule(lease({ startDate: '2026-01-01', endDate: '2026-02-01', depositSen: 0 })))
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ periodStart: '2026-01-01', periodEnd: '2026-01-31', amountSen: 150000 })
    expect(list[1]).toMatchObject({ periodIndex: 1, periodStart: '2026-02-01', periodEnd: '2026-02-01', dueDate: '2026-02-01', amountSen: 5357 }) // 150000 / 28 = 5357.14
  })

  it('exactly twelve full months ending the day before the anniversary has 12 full periods', () => {
    const list = rent(generateSchedule(lease({ startDate: '2026-03-15', endDate: '2027-03-14', depositSen: 0 })))
    expect(list).toHaveLength(12)
    expect(list.every((i) => i.amountSen === 150000)).toBe(true)
    expect(list.at(-1)!.periodEnd).toBe('2027-03-14')
  })

  it('the final period always ends at endDate and the first starts at startDate', () => {
    const list = rent(generateSchedule(lease({ startDate: '2026-05-20', endDate: '2026-12-02', depositSen: 0 })))
    expect(list[0].periodStart).toBe('2026-05-20')
    expect(list.at(-1)!.periodEnd).toBe('2026-12-02')
  })

  it('periodIndex counts from 0 and rent is ordered after the deposit', () => {
    const invoices = generateSchedule(lease())
    expect(invoices.map((i) => i.periodIndex)).toEqual([null, 0, 1, 2, 3, 4, 5])
  })

  it('does not mutate its input', () => {
    const input = lease()
    const copy = { ...input }
    generateSchedule(input)
    expect(input).toEqual(copy)
  })
})

describe('generateSchedule: proration and half-up rounding', () => {
  // start 2026-04-01 -> full period Apr 1..Apr 30 = 30 days; one-day lease uses 1 of 30.
  const oneOf30 = (monthlyRentSen: number) =>
    generateSchedule(lease({ startDate: '2026-04-01', endDate: '2026-04-01', depositSen: 0, monthlyRentSen }))[0].amountSen

  it('exactly .5 rounds UP: 15/30 = 0.5 -> 1, 45/30 = 1.5 -> 2, 75/30 = 2.5 -> 3', () => {
    expect(oneOf30(15)).toBe(1)
    expect(oneOf30(45)).toBe(2)
    expect(oneOf30(75)).toBe(3)
  })

  it('just below .5 rounds down, just above rounds up', () => {
    expect(oneOf30(14)).toBe(0) // 0.4667
    expect(oneOf30(16)).toBe(1) // 0.5333
    expect(oneOf30(44)).toBe(1) // 1.4667
    expect(oneOf30(46)).toBe(2) // 1.5333
  })

  it('exact divisions are not changed', () => {
    expect(oneOf30(300000)).toBe(10000)
    expect(oneOf30(30)).toBe(1)
  })

  it('a prorated period never exceeds the full monthly rent', () => {
    for (const end of ['2026-04-01', '2026-04-10', '2026-04-29']) {
      const [only] = generateSchedule(lease({ startDate: '2026-04-01', endDate: end, depositSen: 0 }))
      expect(only.amountSen).toBeLessThan(150000)
    }
  })

  it('is exact for very large rents (no floating point loss)', () => {
    const rentSen = Number.MAX_SAFE_INTEGER // 9007199254740991
    const [only] = generateSchedule(lease({ startDate: '2026-04-01', endDate: '2026-04-01', depositSen: 0, monthlyRentSen: rentSen }))
    const expected = (2n * BigInt(rentSen) * 1n + 30n) / (2n * 30n)
    expect(only.amountSen).toBe(Number(expected))
  })

  it('full periods are charged the full rent even when it is not divisible', () => {
    const list = rent(generateSchedule(lease({ monthlyRentSen: 100001, depositSen: 0 })))
    expect(list.slice(0, -1).every((i) => i.amountSen === 100001)).toBe(true)
  })
})

describe('generateSchedule: validation', () => {
  const bad = (over: object) => () => generateSchedule(lease(over as never))

  it('rejects malformed or non-existent dates', () => {
    const invalid = ['', '2026-1-1', '26-01-01', '2026/01/01', '2026-01-01T00:00:00Z', ' 2026-01-01', '2026-13-01', '2026-00-10', '2026-04-31', '2026-02-29', '2100-02-29', '2026-01-00', '0000-01-01', 'abcd-ef-gh']
    for (const value of invalid) {
      expect(bad({ startDate: value }), `startDate ${JSON.stringify(value)}`).toThrow(Error)
      expect(bad({ endDate: value }), `endDate ${JSON.stringify(value)}`).toThrow(Error)
    }
    expect(bad({ startDate: undefined })).toThrow(Error)
    expect(bad({ endDate: null })).toThrow(Error)
    expect(bad({ startDate: 20260101 })).toThrow(Error)
  })

  it('accepts real leap days', () => {
    expect(() => generateSchedule(lease({ startDate: '2028-02-29', endDate: '2028-03-01' }))).not.toThrow()
    expect(() => generateSchedule(lease({ startDate: '2000-02-29', endDate: '2000-03-01' }))).not.toThrow()
  })

  it('rejects an end date before the start date', () => {
    expect(bad({ startDate: '2026-02-01', endDate: '2026-01-31' })).toThrow(Error)
    expect(bad({ startDate: '2026-02-01', endDate: '2025-12-01' })).toThrow(Error)
  })

  it('rejects monthlyRentSen that is not a positive integer', () => {
    for (const value of [0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '1000', null, undefined]) {
      expect(bad({ monthlyRentSen: value }), `monthlyRentSen ${String(value)}`).toThrow(Error)
    }
  })

  it('rejects depositSen that is not a non-negative integer', () => {
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '300000', null, undefined]) {
      expect(bad({ depositSen: value }), `depositSen ${String(value)}`).toThrow(Error)
    }
  })
})

describe('invoiceStatus', () => {
  const inv = (over: Partial<{ dueDate: string; amountSen: number; paidSen: number }> = {}) => ({
    dueDate: '2026-03-01',
    amountSen: 100000,
    paidSen: 0,
    ...over,
  })
  const at = (iso: string) => new Date(iso)

  it('paid when paidSen >= amountSen (including overpayment and zero-amount invoices)', () => {
    expect(invoiceStatus(inv({ paidSen: 100000 }), at('2026-02-01T00:00:00Z'))).toBe('paid')
    expect(invoiceStatus(inv({ paidSen: 100001 }), at('2026-02-01T00:00:00Z'))).toBe('paid')
    expect(invoiceStatus(inv({ amountSen: 0, paidSen: 0 }), at('2026-02-01T00:00:00Z'))).toBe('paid')
  })

  it('precedence 1: paid beats overdue', () => {
    expect(invoiceStatus(inv({ paidSen: 100000 }), at('2027-01-01T00:00:00Z'))).toBe('paid')
  })

  it('precedence 2: overdue beats partially_paid', () => {
    expect(invoiceStatus(inv({ paidSen: 50000 }), at('2026-03-02T00:00:00+08:00'))).toBe('overdue')
  })

  it('precedence 3: partially_paid beats unpaid when not yet overdue', () => {
    expect(invoiceStatus(inv({ paidSen: 1 }), at('2026-02-15T00:00:00Z'))).toBe('partially_paid')
    expect(invoiceStatus(inv({ paidSen: 99999 }), at('2026-02-15T00:00:00Z'))).toBe('partially_paid')
  })

  it('unpaid when nothing is paid and it is not overdue', () => {
    expect(invoiceStatus(inv(), at('2026-02-15T00:00:00Z'))).toBe('unpaid')
  })

  it('unpaid with nothing paid becomes overdue after the due date', () => {
    expect(invoiceStatus(inv(), at('2026-03-05T12:00:00Z'))).toBe('overdue')
  })

  describe('Malaysia midnight boundary (UTC+8)', () => {
    it('due 2026-03-01 is NOT overdue through 2026-03-01 23:59:59.999 Malaysia time (15:59:59.999Z)', () => {
      expect(invoiceStatus(inv(), at('2026-03-01T15:59:59.999Z'))).toBe('unpaid')
    })

    it('due 2026-03-01 IS overdue at 2026-03-02 00:00 Malaysia time (2026-03-01T16:00:00Z)', () => {
      expect(invoiceStatus(inv(), at('2026-03-01T16:00:00.000Z'))).toBe('overdue')
    })

    it('is not overdue on the due date itself at any Malaysia time of day', () => {
      for (const iso of ['2026-02-28T16:00:00Z', '2026-03-01T00:00:00Z', '2026-03-01T12:00:00Z', '2026-03-01T15:59:59Z']) {
        expect(invoiceStatus(inv(), at(iso)), iso).toBe('unpaid')
      }
    })

    it('uses the Malaysia calendar date, not the UTC date: 2026-03-01T20:00Z is already 2026-03-02 in Malaysia', () => {
      expect(invoiceStatus(inv(), at('2026-03-01T20:00:00Z'))).toBe('overdue')
    })

    it('the boundary works for partially paid invoices too', () => {
      expect(invoiceStatus(inv({ paidSen: 10 }), at('2026-03-01T15:59:59.999Z'))).toBe('partially_paid')
      expect(invoiceStatus(inv({ paidSen: 10 }), at('2026-03-01T16:00:00.000Z'))).toBe('overdue')
    })

    it('handles month and year ends', () => {
      expect(invoiceStatus(inv({ dueDate: '2026-12-31' }), at('2026-12-31T15:59:59.999Z'))).toBe('unpaid')
      expect(invoiceStatus(inv({ dueDate: '2026-12-31' }), at('2026-12-31T16:00:00.000Z'))).toBe('overdue')
      expect(invoiceStatus(inv({ dueDate: '2028-02-29' }), at('2028-02-29T16:00:00.000Z'))).toBe('overdue')
      expect(invoiceStatus(inv({ dueDate: '2028-02-28' }), at('2028-02-29T15:59:59.999Z'))).toBe('overdue')
    })
  })

  it('rejects an invalid due date, invalid Date or non-integer money', () => {
    expect(() => invoiceStatus(inv({ dueDate: '2026-02-30' }), at('2026-03-01T00:00:00Z'))).toThrow(Error)
    expect(() => invoiceStatus(inv(), new Date('nope'))).toThrow(Error)
    expect(() => invoiceStatus(inv({ amountSen: 10.5 }), at('2026-03-01T00:00:00Z'))).toThrow(Error)
    expect(() => invoiceStatus(inv({ paidSen: NaN }), at('2026-03-01T00:00:00Z'))).toThrow(Error)
  })
})

describe('parseRinggitToSen', () => {
  it('parses the examples from the brief', () => {
    expect(parseRinggitToSen('1,500.50')).toBe(150050)
    expect(parseRinggitToSen('1.15')).toBe(115)
    expect(parseRinggitToSen('7')).toBe(700)
  })

  it('parses whole and fractional values', () => {
    const cases: Record<string, number> = {
      '0': 0,
      '0.5': 50,
      '0.05': 5,
      '0.00': 0,
      '1.1': 110,
      '1.10': 110,
      '1,000': 100000,
      '12,345': 1234500,
      '999,999.99': 99999999,
      '1,234,567.89': 123456789,
      '100': 10000,
      '1500': 150000,
      '1500.5': 150050,
      '007': 700,
    }
    for (const [input, expected] of Object.entries(cases)) expect(parseRinggitToSen(input), input).toBe(expected)
  })

  it('ignores whitespace around the value', () => {
    expect(parseRinggitToSen('  1,500.50  ')).toBe(150050)
    expect(parseRinggitToSen('\t7\n')).toBe(700)
  })

  it('returns integers exactly (no float artefacts: 1.15 -> 115, 19.99 -> 1999, 0.07 -> 7)', () => {
    expect(parseRinggitToSen('19.99')).toBe(1999)
    expect(parseRinggitToSen('0.07')).toBe(7)
    expect(parseRinggitToSen('4.35')).toBe(435)
    expect(Number.isInteger(parseRinggitToSen('1.15'))).toBe(true)
  })

  it('rejects the invalid examples from the brief', () => {
    for (const input of ['', '-5', '1.234', '1e3', 'RM 10', '1,23']) {
      expect(() => parseRinggitToSen(input), JSON.stringify(input)).toThrow(Error)
    }
  })

  it('rejects other malformed input', () => {
    const invalid = [
      ' ', '+5', '-0', '.5', '5.', '1.', '1.234', '1.2345', '1,2345', '1,23,456', ',100', '100,', '1,,000', '1,000,00', '1,0000',
      '1 000', '1.5.0', '1,000.5.5', '1e3', '1E3', '1e-2', '0x10', 'NaN', 'Infinity', '$10', 'RM10', '10 RM', '1_000', '१२', '１２', '1,000,', '--5', '(5)', '5%', '1,5',
    ]
    for (const input of invalid) expect(() => parseRinggitToSen(input), JSON.stringify(input)).toThrow(Error)
  })

  it('rejects non-string input', () => {
    for (const input of [5, null, undefined, {}, NaN]) expect(() => parseRinggitToSen(input as never)).toThrow(Error)
  })

  it('accepts the largest safe amount and rejects anything that would lose precision', () => {
    expect(parseRinggitToSen('90,071,992,547,409.91')).toBe(9007199254740991)
    expect(() => parseRinggitToSen('90,071,992,547,409.92')).toThrow(Error)
    expect(() => parseRinggitToSen('99,999,999,999,999,999,999')).toThrow(Error)
    expect(() => parseRinggitToSen('9'.repeat(40))).toThrow(Error)
  })
})
