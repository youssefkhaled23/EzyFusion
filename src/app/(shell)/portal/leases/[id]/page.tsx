import { Suspense } from 'react'
import { notFound } from 'next/navigation'
import { LandmarkIcon, WalletIcon } from 'lucide-react'
import { LoadingSkeleton } from '@/components/loading-skeleton'
import { PageHeader } from '@/components/page-header'
import { InvoiceTable } from '@/components/lease/invoice-table'
import { PaymentTable } from '@/components/lease/payment-table'
import { SectionCard } from '@/components/section-card'
import { StatCard } from '@/components/stat-card'
import { PayNow } from '@/components/tenant/pay-now'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { formatDateMy, formatRM } from '@/lib/format-my'
import { getPrisma } from '@/server/db'
import { getLeasePage } from '@/server/domain/views'
import { orNotFound, requirePortal } from '@/server/http/guards'

async function TenantLeaseContent({ params }: { params: PageProps<'/portal/leases/[id]'>['params'] }) {
  const viewer = await requirePortal('tenant')
  const { id } = await params
  const page = await orNotFound(() => getLeasePage(getPrisma(), viewer.userId, id))
  if (page.role !== 'tenant') notFound() // only the lease's own tenant, never another tenant or an organization user
  const { detail } = page
  const invoiced = detail.invoices.reduce((s, i) => s + i.amountSen, 0)
  const paid = detail.invoices.reduce((s, i) => s + i.paidSen, 0)
  return (
    <>
      <PageHeader eyebrow="Your lease" title={`Unit ${page.unitName}`} description={`${formatDateMy(detail.lease.startDate)} – ${formatDateMy(detail.lease.endDate)} · ${formatRM(detail.lease.monthlyRentSen)} per month`} />
      <Card className="border-primary/30 bg-elevated">
        <div className="px-(--card-spacing)">
          <PayNow leaseId={detail.lease.id} dueNowSen={page.dueNowSen} />
        </div>
      </Card>
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Monthly rent" icon={LandmarkIcon} value={formatRM(detail.lease.monthlyRentSen)} valueClassName="text-2xl" hint={`Deposit ${formatRM(detail.lease.depositSen)}`} />
        <StatCard label="Paid to date" icon={WalletIcon} tone="success" value={formatRM(paid)} valueClassName="text-2xl" hint={`of ${formatRM(invoiced)} invoiced`} />
        <StatCard label="Remaining in total" icon={WalletIcon} tone="warning" value={formatRM(Math.max(0, invoiced - paid))} valueClassName="text-2xl" hint="Including invoices not yet due" />
      </div>
      <SectionCard title="Invoices" description="What you have been billed, and what has been paid." flush>
        <InvoiceTable invoices={detail.invoices} />
      </SectionCard>
      <SectionCard title="Payment history" flush>
        <PaymentTable payments={detail.payments} />
      </SectionCard>
    </>
  )
}

export default function TenantLeasePage(props: PageProps<'/portal/leases/[id]'>) {
  return (
    <Suspense fallback={<div className="space-y-6"><Skeleton className="h-14 w-72" /><LoadingSkeleton variant="page" rows={5} /></div>}>
      <TenantLeaseContent params={props.params} />
    </Suspense>
  )
}
