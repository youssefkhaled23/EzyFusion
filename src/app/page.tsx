import { Suspense, type ReactNode } from 'react'
import { redirect } from 'next/navigation'
import { Skeleton } from '@/components/ui/skeleton'
import { getViewer } from '@/server/http/session'

async function PortalRedirect(): Promise<ReactNode> {
  const viewer = await getViewer()
  if (!viewer || viewer.portal === 'none') redirect('/login')
  redirect(viewer.portal === 'tenant' ? '/portal' : '/dashboard')
}

/** Sends each signed-in role to its own portal. */
export default function Home() {
  return (
    <Suspense fallback={<Skeleton className="h-24 w-full" />}>
      <PortalRedirect />
    </Suspense>
  )
}
