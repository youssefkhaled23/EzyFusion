import Link from 'next/link'
import { Suspense } from 'react'
import { ArrowRightIcon, FileTextIcon, WalletIcon } from 'lucide-react'
import { EmptyState } from '@/components/empty-state'
import { LoadingSkeleton } from '@/components/loading-skeleton'
import { PageHeader } from '@/components/page-header'
import { SectionCard } from '@/components/section-card'
import { StatCard } from '@/components/stat-card'
import { StatusBadge } from '@/components/status-badge'
import { PhoneForm } from '@/components/tenant/phone-form'
import { Card } from '@/components/ui/card'
import { buttonVariants } from '@/components/ui/button'
import { formatDateMy, formatRM } from '@/lib/format-my'
import { getPrisma } from '@/server/db'
import { listLeases } from '@/server/domain/views'
import { requirePortal } from '@/server/http/guards'

async function PortalContent() {
  const viewer = await requirePortal('tenant')
  const leases = await listLeases(getPrisma(), viewer.userId)
  const me = viewer.tenants[0]
  const dueTotal = leases.reduce((s, l) => s + l.dueNowSen, 0)
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <StatCard label="Due now across your leases" icon={WalletIcon} tone={dueTotal > 0 ? 'warning' : 'success'} value={formatRM(dueTotal)} hint={dueTotal > 0 ? 'Open a lease to pay' : 'You are all paid up'} />
        <StatCard label="Active leases" icon={FileTextIcon} value={leases.length} hint="Leases linked to your account" />
      </div>
      <section aria-labelledby="leases-heading" className="space-y-3">
        <h2 id="leases-heading" className="text-lg font-semibold tracking-tight">Your leases</h2>
        {leases.length === 0 ? (
          <Card className="py-0"><EmptyState icon={FileTextIcon} title="No leases yet" description="Your landlord has not created a lease for you." /></Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2" data-testid="tenant-leases">
            {leases.map((l) => (
              <Card key={l.id} className="gap-4" data-testid="tenant-lease">
                <div className="flex items-start justify-between gap-3 px-(--card-spacing)">
                  <div className="min-w-0">
                    <p className="text-lg font-semibold tracking-tight">Unit {l.unitName}</p>
                    <p className="text-sm text-muted-foreground-strong">{formatDateMy(l.startDate)} – {formatDateMy(l.endDate)}</p>
                  </div>
                  {l.overdueInvoices > 0 ? <StatusBadge tone="destructive">{l.overdueInvoices} overdue</StatusBadge> : <StatusBadge tone="success">Up to date</StatusBadge>}
                </div>
                <dl className="grid grid-cols-2 gap-4 border-y px-(--card-spacing) py-4">
                  <div><dt className="text-xs font-medium tracking-wide text-muted-foreground-strong uppercase">Monthly rent</dt><dd className="mt-1 text-sm num">{formatRM(l.monthlyRentSen)}</dd></div>
                  <div><dt className="text-xs font-medium tracking-wide text-muted-foreground-strong uppercase">Due now</dt><dd className="mt-1 text-lg font-semibold num">{formatRM(l.dueNowSen)}</dd></div>
                </dl>
                <div className="px-(--card-spacing)">
                  <Link href={`/portal/leases/${l.id}`} className={buttonVariants({ variant: l.dueNowSen > 0 ? 'default' : 'outline' }) + ' w-full sm:w-auto'} data-testid="tenant-lease-link">
                    View invoices and pay
                    <ArrowRightIcon aria-hidden="true" />
                  </Link>
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>
      {me ? (
        <SectionCard title="Your details" description={`${me.fullName} · ${me.email}`} testId="profile-card" className="max-w-xl">
          <PhoneForm tenantId={me.id} phone={me.phone} />
        </SectionCard>
      ) : null}
    </>
  )
}

export default function PortalPage() {
  return (
    <>
      <PageHeader eyebrow="Tenant portal" title="My leases" description="Your leases, what you owe and your payment history." />
      <Suspense fallback={<LoadingSkeleton variant="page" rows={3} />}>
        <PortalContent />
      </Suspense>
    </>
  )
}
