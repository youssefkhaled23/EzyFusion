import { Suspense } from 'react'
import { redirect } from 'next/navigation'
import { LeaseForm } from '@/components/lease/lease-form'
import { LoadingSkeleton } from '@/components/loading-skeleton'
import { PageHeader } from '@/components/page-header'
import { getPrisma } from '@/server/db'
import { getLeaseFormOptions } from '@/server/domain/leases'
import { orNotFound, requirePortal } from '@/server/http/guards'

async function NewLeaseContent() {
  const viewer = await requirePortal('staff')
  if (viewer.portal !== 'manager') redirect('/leases') // only managers create leases (the API enforces it as well)
  const options = await orNotFound(() => getLeaseFormOptions(getPrisma(), viewer.userId))
  return <LeaseForm options={options} />
}

export default function NewLeasePage() {
  return (
    <>
      <PageHeader eyebrow="Leases" title="Create lease" description="Pick a unit and a tenant, set the term and the rent. The deposit and monthly rent invoices are generated automatically." />
      <Suspense fallback={<LoadingSkeleton variant="table" rows={4} />}>
        <NewLeaseContent />
      </Suspense>
    </>
  )
}
