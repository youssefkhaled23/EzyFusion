'use client'

import type { InvoiceStatus } from '@/lib/billing'
import { StatusBadge, type StatusTone } from '@/components/status-badge'

const invoice: Record<InvoiceStatus, { label: string; tone: StatusTone }> = {
  paid: { label: 'Paid', tone: 'success' },
  partially_paid: { label: 'Partially paid', tone: 'warning' },
  unpaid: { label: 'Unpaid', tone: 'neutral' },
  overdue: { label: 'Overdue', tone: 'destructive' },
}
const payment: Record<string, { label: string; tone: StatusTone }> = {
  approved: { label: 'Approved', tone: 'success' },
  pending_verification: { label: 'Pending verification', tone: 'warning' },
  rejected: { label: 'Rejected', tone: 'destructive' },
  voided: { label: 'Voided', tone: 'neutral' },
}
const bill: Record<string, { label: string; tone: StatusTone }> = {
  pending: { label: 'Pending', tone: 'warning' },
  paid: { label: 'Paid', tone: 'success' },
  failed: { label: 'Failed', tone: 'destructive' },
}

export const InvoiceStatusBadge = ({ status }: { status: InvoiceStatus }) => <StatusBadge tone={invoice[status].tone}>{invoice[status].label}</StatusBadge>
export const PaymentStatusBadge = ({ status }: { status: string }) => <StatusBadge tone={(payment[status] ?? { tone: 'neutral' as const }).tone}>{(payment[status] ?? { label: status }).label}</StatusBadge>
export const BillStatusBadge = ({ status }: { status: string }) => <StatusBadge tone={(bill[status] ?? { tone: 'neutral' as const }).tone}>{(bill[status] ?? { label: status }).label}</StatusBadge>
