import { Suspense } from 'react'
import { notFound } from 'next/navigation'
import { BanknoteIcon, CircleAlertIcon, WalletIcon } from 'lucide-react'
import { LoadingSkeleton } from '@/components/loading-skeleton'
import { PageHeader } from '@/components/page-header'
import { InvoiceTable } from '@/components/lease/invoice-table'
import { PaymentForm } from '@/components/lease/payment-form'
import { PaymentTable } from '@/components/lease/payment-table'
import { SectionCard } from '@/components/section-card'
import { StatCard } from '@/components/stat-card'
import { Skeleton } from '@/components/ui/skeleton'
import { formatDateMy, formatRM } from '@/lib/format-my'
import { getPrisma } from '@/server/db'
import { getLeasePage } from '@/server/domain/views'
import { orNotFound, requirePortal } from '@/server/http/guards'

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-xs font-medium tracking-wide text-muted-foreground-strong uppercase">{label}</dt>
      <dd className="text-sm break-words">{children}</dd>
    </div>
  )
}

async function LeaseContent({ params }: { params: PageProps<'/leases/[id]'>['params'] }) {
  const viewer = await requirePortal('staff')
  const { id } = await params
  const page = await orNotFound(() => getLeasePage(getPrisma(), viewer.userId, id))
  if (page.role === 'tenant') notFound() // a staff-portal page never shows a lease through a tenant relationship
  const { detail } = page
  const invoiced = detail.invoices.reduce((s, i) => s + i.amountSen, 0)
  const paid = detail.invoices.reduce((s, i) => s + i.paidSen, 0)
  const pending = detail.payments.filter((p) => p.status === 'pending_verification').length
  return (
    <>
      <PageHeader
        eyebrow="Lease"
        title={`Unit ${page.unitName}`}
        description={`${page.tenant.fullName} · ${formatDateMy(detail.lease.startDate)} – ${formatDateMy(detail.lease.endDate)}`}
      />
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Due now (Malaysia date)" icon={CircleAlertIcon} tone={page.dueNowSen > 0 ? 'warning' : 'success'} value={formatRM(page.dueNowSen)} valueTestId="due-now" hint="Unpaid on invoices already due" />
        <StatCard label="Paid to date" icon={WalletIcon} tone="success" value={formatRM(paid)} hint={`of ${formatRM(invoiced)} invoiced`} />
        <StatCard label="Outstanding in total" icon={BanknoteIcon} value={formatRM(Math.max(0, invoiced - paid))} hint={pending > 0 ? `${pending} payment${pending === 1 ? '' : 's'} awaiting verification` : 'No payments awaiting verification'} />
      </div>

      <SectionCard title="Lease overview">
        <dl className="grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-2 lg:grid-cols-4">
          <Fact label="Tenant">
            <span className="font-medium">{page.tenant.fullName}</span>
            <span className="block text-muted-foreground-strong">{page.tenant.email}</span>
            <span className="block text-muted-foreground-strong">{page.tenant.phone ?? 'No phone number'}</span>
          </Fact>
          <Fact label="Term">{formatDateMy(detail.lease.startDate)} – {formatDateMy(detail.lease.endDate)}</Fact>
          <Fact label="Monthly rent / deposit"><span className="num">{formatRM(detail.lease.monthlyRentSen)}</span> <span className="text-muted-foreground-strong">·</span> <span className="num">{formatRM(detail.lease.depositSen)}</span></Fact>
          <Fact label="Your role"><span className="capitalize" data-testid="lease-role">{page.role}</span></Fact>
        </dl>
      </SectionCard>

      <SectionCard title="Invoices" description="Deposit and monthly rent, with what has been paid against each." flush>
        <InvoiceTable invoices={detail.invoices} />
      </SectionCard>
      <SectionCard title="Payments" description={page.role === 'manager' ? 'Approve, reject or void payments here.' : 'Payments recorded for this lease.'} flush>
        <PaymentTable payments={detail.payments} slipPaths={page.slipPaths} canManage={page.role === 'manager'} />
      </SectionCard>
      <SectionCard title="Record a payment" description="Cash and bank transfers received for this lease.">
        <PaymentForm leaseId={detail.lease.id} orgId={page.orgId} role={page.role} />
      </SectionCard>
    </>
  )
}

export default function LeasePage(props: PageProps<'/leases/[id]'>) {
  return (
    <Suspense fallback={<div className="space-y-6"><Skeleton className="h-14 w-72" /><LoadingSkeleton variant="page" rows={5} /></div>}>
      <LeaseContent params={props.params} />
    </Suspense>
  )
}
