import { EmptyState } from '@/components/empty-state'
import { InvoiceStatusBadge } from '@/components/status-badges'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { LeaseDetail } from '@/server/domain/leases'
import { formatDateMy, formatRM } from '@/lib/format-my'
import { FileTextIcon } from 'lucide-react'

const period = (i: LeaseDetail['invoices'][number]) => (i.kind === 'deposit' ? 'Deposit' : `${formatDateMy(i.periodStart ?? '')} – ${formatDateMy(i.periodEnd ?? '')}`)

export function InvoiceTable({ invoices }: { invoices: LeaseDetail['invoices'] }) {
  if (invoices.length === 0) return <EmptyState icon={FileTextIcon} title="No invoices" description="Invoices appear once the lease schedule is generated." />
  return (
    <Table data-testid="invoice-table">
      <TableCaption className="sr-only">Invoices</TableCaption>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead scope="col" className="px-5 md:px-6">Period</TableHead>
          <TableHead scope="col" className="px-5">Due date</TableHead>
          <TableHead scope="col" className="px-5 text-right">Amount</TableHead>
          <TableHead scope="col" className="px-5 text-right">Paid</TableHead>
          <TableHead scope="col" className="px-5 md:pr-6">Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {invoices.map((i) => (
          <TableRow key={i.id} data-testid="invoice-row" data-status={i.status}>
            <TableCell className="px-5 font-medium md:px-6">{period(i)}</TableCell>
            <TableCell className="px-5 text-muted-foreground-strong">{formatDateMy(i.dueDate)}</TableCell>
            <TableCell className="px-5 text-right num">{formatRM(i.amountSen)}</TableCell>
            <TableCell className="px-5 text-right num">{formatRM(i.paidSen)}</TableCell>
            <TableCell className="px-5 md:pr-6">
              <InvoiceStatusBadge status={i.status} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
