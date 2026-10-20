import { WalletIcon } from 'lucide-react'
import { EmptyState } from '@/components/empty-state'
import { PaymentStatusBadge } from '@/components/status-badges'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { LeaseDetail } from '@/server/domain/leases'
import { formatInstantMy, formatRM } from '@/lib/format-my'
import { PaymentActions } from './payment-actions'
import { SlipLink } from './slip-link'

const METHOD: Record<string, string> = { cash: 'Cash', bank_transfer: 'Bank transfer', online: 'Online' }

interface Props {
  payments: LeaseDetail['payments']
  /** payment id -> slip path (staff/managers only) */
  slipPaths?: Record<string, string>
  /** Manager-only controls (approve / reject / void). Never true for staff or tenants. */
  canManage?: boolean
}

export function PaymentTable({ payments, slipPaths = {}, canManage = false }: Props) {
  if (payments.length === 0) return <EmptyState icon={WalletIcon} title="No payments yet" description="Payments recorded for this lease will be listed here." />
  return (
    <Table data-testid="payment-table">
      <TableCaption className="sr-only">Payments</TableCaption>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead scope="col" className="px-5 md:px-6">Method</TableHead>
          <TableHead scope="col" className="px-5 text-right">Amount</TableHead>
          <TableHead scope="col" className="px-5">Received (Malaysia time)</TableHead>
          <TableHead scope="col" className="px-5">Status</TableHead>
          <TableHead scope="col" className="px-5">Slip</TableHead>
          {canManage ? <TableHead scope="col" className="px-5"><span className="sr-only">Actions</span></TableHead> : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {payments.map((p) => (
          <TableRow key={p.id} data-testid="payment-row" data-status={p.status} data-payment-id={p.id}>
            <TableCell className="px-5 font-medium md:px-6">{METHOD[p.method] ?? p.method}</TableCell>
            <TableCell className="px-5 text-right num">
              {formatRM(p.amountSen)}
              {p.unappliedSen > 0 ? <span className="block text-xs text-warning-subtle-foreground">{formatRM(p.unappliedSen)} unapplied</span> : null}
            </TableCell>
            <TableCell className="px-5">{formatInstantMy(p.receivedAt)}</TableCell>
            <TableCell className="px-5">
              <PaymentStatusBadge status={p.status} />
            </TableCell>
            <TableCell className="px-5">{p.method === 'bank_transfer' && slipPaths[p.id] ? <SlipLink path={slipPaths[p.id]} /> : <span className="text-muted-foreground-strong">—</span>}</TableCell>
            {canManage ? (
              <TableCell className="px-5">
                <PaymentActions paymentId={p.id} status={p.status} amountLabel={formatRM(p.amountSen)} />
              </TableCell>
            ) : null}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
