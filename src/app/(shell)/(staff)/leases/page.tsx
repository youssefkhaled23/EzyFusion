import Link from 'next/link'
import { Suspense } from 'react'
import { ChevronRightIcon, FileTextIcon, PlusIcon } from 'lucide-react'
import { EmptyState } from '@/components/empty-state'
import { LoadingSkeleton } from '@/components/loading-skeleton'
import { PageHeader } from '@/components/page-header'
import { SectionCard } from '@/components/section-card'
import { StatusBadge } from '@/components/status-badge'
import { buttonVariants } from '@/components/ui/button'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatDateMy, formatRM } from '@/lib/format-my'
import { getPrisma } from '@/server/db'
import { listLeases } from '@/server/domain/views'
import { getViewer } from '@/server/http/session'
import { requirePortal } from '@/server/http/guards'

async function LeaseList() {
  const viewer = await requirePortal('staff')
  const leases = await listLeases(getPrisma(), viewer.userId)
  if (leases.length === 0) return <EmptyState icon={FileTextIcon} title="No leases yet" description="Leases created for your organization will appear here." />
  return (
    <Table data-testid="lease-table">
      <TableCaption className="sr-only">Leases</TableCaption>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead scope="col" className="px-5 md:px-6">Unit</TableHead>
          <TableHead scope="col" className="px-5">Tenant</TableHead>
          <TableHead scope="col" className="px-5">Term</TableHead>
          <TableHead scope="col" className="px-5 text-right">Monthly rent</TableHead>
          <TableHead scope="col" className="px-5 text-right">Due now</TableHead>
          <TableHead scope="col" className="px-5">Overdue</TableHead>
          <TableHead scope="col" className="w-10 px-5 md:pr-6"><span className="sr-only">Open</span></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {leases.map((l) => (
          <TableRow key={l.id} data-testid="lease-row">
            <TableCell className="px-5 font-medium md:px-6">
              <Link href={`/leases/${l.id}`} className="rounded-sm text-foreground underline-offset-4 hover:text-primary hover:underline focus-ring" data-testid="lease-link">{l.unitName}</Link>
            </TableCell>
            <TableCell className="px-5">{l.tenantName}</TableCell>
            <TableCell className="px-5 text-muted-foreground-strong">{formatDateMy(l.startDate)} – {formatDateMy(l.endDate)}</TableCell>
            <TableCell className="px-5 text-right num">{formatRM(l.monthlyRentSen)}</TableCell>
            <TableCell className="px-5 text-right num font-medium">{formatRM(l.dueNowSen)}</TableCell>
            <TableCell className="px-5">{l.overdueInvoices > 0 ? <StatusBadge tone="destructive">{l.overdueInvoices} overdue</StatusBadge> : <StatusBadge tone="success">None</StatusBadge>}</TableCell>
            <TableCell className="px-5 md:pr-6" aria-hidden="true"><ChevronRightIcon className="size-4 text-subtle-text" /></TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

/** Managers only: staff cannot create leases (the API enforces it too). */
async function CreateLeaseButton() {
  const viewer = await getViewer()
  if (viewer?.portal !== 'manager') return null
  return (
    <Link href="/leases/new" className={buttonVariants()} data-testid="create-lease-link">
      <PlusIcon aria-hidden="true" data-icon="inline-start" />
      Create lease
    </Link>
  )
}

export default function LeasesPage() {
  return (
    <>
      <PageHeader
        eyebrow="Portfolio"
        title="Leases"
        description="Every lease in your organization with what is due now and what is overdue."
        actions={
          <Suspense fallback={null}>
            <CreateLeaseButton />
          </Suspense>
        }
      />
      <SectionCard title="All leases" flush>
        <Suspense fallback={<div className="p-5"><LoadingSkeleton variant="table" rows={4} /></div>}>
          <LeaseList />
        </Suspense>
      </SectionCard>
    </>
  )
}
