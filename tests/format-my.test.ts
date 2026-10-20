import { describe, expect, it } from 'vitest'
import { formatDateMy, formatInstantMy, formatMonthMy, formatRM, lastMalaysiaMonths, malaysiaInputToIso, toMalaysiaInputValue } from '../src/lib/format-my'

describe('Malaysia formatting is deterministic (independent of the process timezone)', () => {
  it('formats instants in Malaysia time', () => {
    expect(formatInstantMy('2026-02-28T16:30:00.000Z')).toBe('1 Mar 2026, 00:30 MYT')
    expect(formatInstantMy('2026-01-31T02:00:00.000Z')).toBe('31 Jan 2026, 10:00 MYT')
    expect(formatInstantMy('2026-12-31T16:00:00Z')).toBe('1 Jan 2027, 00:00 MYT')
    expect(formatInstantMy('2026-03-31T15:59:59Z')).toBe('31 Mar 2026, 23:59 MYT')
    expect(formatInstantMy('2026-04-01T00:30:12+08:00')).toBe('1 Apr 2026, 00:30 MYT')
    expect(formatInstantMy('garbage')).toBe('garbage')
  })

  it('formats calendar dates and months without Date objects', () => {
    expect(formatDateMy('2026-03-05')).toBe('5 Mar 2026')
    expect(formatDateMy('2028-02-29')).toBe('29 Feb 2028')
    expect(formatDateMy('nope')).toBe('nope')
    expect(formatMonthMy('2026-01')).toBe('Jan 2026')
  })

  it('formats ringgit from integer sen', () => {
    expect(formatRM(0)).toBe('RM 0.00')
    expect(formatRM(5)).toBe('RM 0.05')
    expect(formatRM(150050)).toBe('RM 1,500.50')
    expect(formatRM(100029)).toBe('RM 1,000.29')
    expect(formatRM(123456789012)).toBe('RM 1,234,567,890.12')
    expect(formatRM(-4500)).toBe('-RM 45.00')
    expect(() => formatRM(1.5)).toThrow(RangeError)
  })

  it('datetime-local input <-> explicit +08:00 ISO instant', () => {
    expect(malaysiaInputToIso('2026-03-01T00:30')).toBe('2026-03-01T00:30:00+08:00')
    expect(new Date(malaysiaInputToIso('2026-03-01T00:30')!).toISOString()).toBe('2026-02-28T16:30:00.000Z')
    expect(malaysiaInputToIso('2026-03-01T00:30:15')).toBe('2026-03-01T00:30:15+08:00')
    for (const bad of ['', '2026-03-01', '2026-02-30T10:00', '2026-13-01T10:00', '2026-03-01T24:00', '2026-03-01T10:61', 'x']) expect(malaysiaInputToIso(bad), bad).toBeNull()
    expect(toMalaysiaInputValue(new Date('2026-02-28T16:30:00Z'))).toBe('2026-03-01T00:30')
  })

  it('lists the last six Malaysia calendar months', () => {
    expect(lastMalaysiaMonths(new Date('2026-04-15T00:00:00Z'), 6)).toEqual(['2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04'])
    expect(lastMalaysiaMonths(new Date('2026-03-31T16:00:00Z'), 3)).toEqual(['2026-02', '2026-03', '2026-04']) // already April in Malaysia
    expect(lastMalaysiaMonths(new Date('2026-03-31T15:59:59Z'), 1)).toEqual(['2026-03'])
  })
})
