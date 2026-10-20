import Link from 'next/link'
import { LogoutButton } from '@/components/auth/logout-button'
import { NavLinks, type NavItem } from '@/components/app-shell'
import { StatusBadge } from '@/components/status-badge'
import { buttonVariants } from '@/components/ui/button'
import { getViewer } from '@/server/http/session'

/** Navigation for the signed-in role. Visitors without a role-bearing session get no navigation. */
export async function RoleNav() {
  const viewer = await getViewer()
  if (!viewer) return null
  const items: NavItem[] =
    viewer.portal === 'manager' || viewer.portal === 'staff'
      ? [
          { label: 'Dashboard', href: '/dashboard', icon: 'dashboard' },
          { label: 'Leases', href: '/leases', icon: 'leases' },
        ]
      : viewer.portal === 'tenant'
        ? [{ label: 'My leases', href: '/portal', icon: 'portal' }]
        : []
  return <NavLinks items={items} />
}

const ROLE_LABEL = { manager: 'Manager', staff: 'Staff', tenant: 'Tenant', none: 'No access' } as const

export async function AccountMenu() {
  const viewer = await getViewer()
  if (!viewer) return <Link href="/login" className={buttonVariants({ variant: 'outline' })}>Sign in</Link>
  return (
    <>
      <div className="flex min-w-0 items-center gap-2.5 text-sm" data-testid="account">
        <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-full bg-elevated text-xs font-semibold uppercase text-foreground">{(viewer.email ?? '?').slice(0, 1)}</span>
        <span className="hidden min-w-0 flex-col leading-tight md:flex">
          <span className="max-w-48 truncate font-medium" data-testid="account-email">{viewer.email}</span>
        </span>
        <StatusBadge tone="info" className="hidden sm:inline-flex"><span data-testid="account-role">{ROLE_LABEL[viewer.portal]}</span></StatusBadge>
      </div>
      <LogoutButton />
    </>
  )
}
