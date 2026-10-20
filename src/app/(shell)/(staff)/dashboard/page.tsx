import { Suspense } from 'react'
import { AlertTriangleIcon, BarChart3Icon, ClockIcon, WalletIcon } from 'lucide-react'
import { CollectionsChart } from '@/components/dashboard/collections-chart'
import { EmptyState } from '@/components/empty-state'
import { LoadingSkeleton } from '@/components/loading-skeleton'
import { PageHeader } from '@/components/page-header'
import { SectionCard } from '@/components/section-card'
import { StatCard } from '@/components/stat-card'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatMonthMy, formatRM } from '@/lib/format-my'
import { getPrisma } from '@/server/db'
import { getDashboard } from '@/server/domain/views'
import { orNotFound, requirePortal } from '@/server/http/guards'

async function DashboardContent() {
  const viewer = await requirePortal('staff')
  const data = await orNotFound(() => getDashboard(getPrisma(), viewer.userId))
  const max = Math.max(1, ...data.collections.map((c) => c.collectedSen))
  const total = data.collections.reduce((s, c) => s + c.collectedSen, 0)
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard
          testId="overdue-card"
          valueTestId="overdue-count"
          label="Overdue invoices"
          icon={AlertTriangleIcon}
          tone={data.overdueInvoices > 0 ? 'destructive' : 'success'}
          value={data.overdueInvoices}
          hint="Unpaid invoices past their due date (Malaysia time)"
        />
        <StatCard
          testId="pending-card"
          valueTestId="pending-count"
          label="Payments awaiting verification"
          icon={ClockIcon}
          tone={data.pendingPayments > 0 ? 'warning' : 'success'}
          value={data.pendingPayments}
          hint={viewer.portal === 'manager' ? 'Open a lease to approve or reject them' : 'A manager must approve these'}
        />
        <StatCard
          className="sm:col-span-2 xl:col-span-1"
          label="Collected, last six months"
          icon={WalletIcon}
          tone="default"
          value={formatRM(total)}
          valueClassName="text-2xl sm:text-3xl"
          hint="Approved payments, by Malaysia calendar month"
        />
      </div>

      <SectionCard title="Collections, last six months" description={`Approved payments by Malaysia calendar month. Total ${formatRM(total)}.`}>
        {total === 0 ? (
          <EmptyState icon={BarChart3Icon} title="No approved payments in this period" description="Collections appear here once payments are approved." className="py-6" />
        ) : (
          <CollectionsChart points={data.collections} />
        )}
      </SectionCard>

      <SectionCard title="Monthly breakdown" flush>
        <Table data-testid="collections-table">
          <TableCaption className="sr-only">Collections by month</TableCaption>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead scope="col" className="px-5 md:px-6">Month</TableHead>
              <TableHead scope="col" className="px-5 text-right md:px-6">Collected</TableHead>
              <TableHead scope="col" className="hidden w-1/2 px-5 sm:table-cell md:px-6"><span className="sr-only">Share of the highest month</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.collections.map((c) => (
              <TableRow key={c.month} data-testid="collections-row" data-month={c.month}>
                <TableCell className="px-5 md:px-6">{formatMonthMy(c.month)}</TableCell>
                <TableCell className="px-5 text-right num md:px-6">{formatRM(c.collectedSen)}</TableCell>
                <TableCell className="hidden px-5 sm:table-cell md:px-6" aria-hidden="true">
                  <div className="h-1.5 rounded-full bg-border"><div className="h-1.5 rounded-full bg-primary" style={{ width: `${Math.round((c.collectedSen / max) * 100)}%` }} /></div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </SectionCard>
    </>
  )
}

export default function DashboardPage() {
  return (
    <>
      <PageHeader eyebrow="Overview" title="Dashboard" description="Overdue invoices, payments waiting for review and what your organization collected over the last six months." />
      <Suspense fallback={<LoadingSkeleton variant="page" rows={6} />}>
        <DashboardContent />
      </Suspense>
    </>
  )
}
