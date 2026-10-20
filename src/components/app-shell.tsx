'use client'

import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ChevronRightIcon, LayoutDashboardIcon, MenuIcon, PanelLeftCloseIcon, PanelLeftOpenIcon, ReceiptTextIcon, UserIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'

const ICONS = { dashboard: LayoutDashboardIcon, leases: ReceiptTextIcon, portal: UserIcon } as const
export interface NavItem {
  label: string
  href: string
  icon: keyof typeof ICONS
}

function Brand({ className }: { className?: string }) {
  return (
    <Link href="/" className={cn('flex h-10 items-center gap-2.5 rounded-lg focus-ring', className)}>
      <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">E</span>
      <span className="text-base font-semibold tracking-tight group-data-[collapsed=true]/sidebar:sr-only">EzyFusion</span>
    </Link>
  )
}

/** Role-aware navigation: the server decides which items a user gets; this only renders them and marks the current page. */
export function NavLinks({ items }: { items: NavItem[] }) {
  const pathname = usePathname()
  return (
    <ul className="space-y-1">
      {items.map(({ label, href, icon }) => {
        const Icon = ICONS[icon]
        const current = pathname === href || pathname.startsWith(`${href}/`)
        return (
          <li key={href}>
            <Link
              href={href}
              title={label}
              aria-current={current ? 'page' : undefined}
              className={cn(
                'relative flex min-h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors focus-ring group-data-[collapsed=true]/sidebar:justify-center group-data-[collapsed=true]/sidebar:px-0',
                current ? 'bg-info-subtle text-info-subtle-foreground' : 'text-muted-foreground-strong hover:bg-elevated hover:text-foreground',
              )}
            >
              {current ? <span aria-hidden="true" className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-primary" /> : null}
              <Icon aria-hidden="true" className="size-[18px] shrink-0" />
              <span className="group-data-[collapsed=true]/sidebar:sr-only">{label}</span>
            </Link>
          </li>
        )
      })}
    </ul>
  )
}

const CRUMBS: { match: RegExp; trail: { label: string; href?: string }[] }[] = [
  { match: /^\/dashboard$/, trail: [{ label: 'Dashboard' }] },
  { match: /^\/leases$/, trail: [{ label: 'Leases' }] },
  { match: /^\/leases\/new$/, trail: [{ label: 'Leases', href: '/leases' }, { label: 'Create lease' }] },
  { match: /^\/leases\/[^/]+$/, trail: [{ label: 'Leases', href: '/leases' }, { label: 'Lease details' }] },
  { match: /^\/portal$/, trail: [{ label: 'My leases' }] },
  { match: /^\/portal\/leases\/[^/]+$/, trail: [{ label: 'My leases', href: '/portal' }, { label: 'Lease details' }] },
  { match: /^\/payments\/return$/, trail: [{ label: 'My leases', href: '/portal' }, { label: 'Payment status' }] },
]

/** Breadcrumb for the current route; the last item is the page the user is on. */
export function Breadcrumb() {
  const pathname = usePathname()
  const trail = CRUMBS.find((c) => c.match.test(pathname))?.trail ?? []
  if (trail.length === 0) return null
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex items-center gap-1.5 text-sm">
        {trail.map((crumb, i) => {
          const last = i === trail.length - 1
          return (
            <li key={crumb.label} className="flex min-w-0 items-center gap-1.5">
              {i > 0 ? <ChevronRightIcon aria-hidden="true" className="size-3.5 shrink-0 text-subtle-text" /> : null}
              {crumb.href && !last ? (
                <Link href={crumb.href} className="rounded-sm text-muted-foreground-strong hover:text-foreground focus-ring">{crumb.label}</Link>
              ) : (
                <span aria-current={last ? 'page' : undefined} className={cn('truncate', last ? 'font-medium text-foreground' : 'text-muted-foreground-strong')}>{crumb.label}</span>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

interface Props {
  children: ReactNode
  /** Server-rendered role navigation (rendered in the sidebar and in the mobile drawer) */
  nav: ReactNode
  /** Server-rendered account area: who is signed in + log out */
  account: ReactNode
  /** Breadcrumb (client component that reads the pathname inside its own Suspense boundary) */
  breadcrumb?: ReactNode
}

/** Page chrome: collapsible sidebar at lg+, header with breadcrumb and account, and a Sheet drawer below lg. Always renders <main id="main">. */
export function AppShell({ children, nav, account, breadcrumb }: Props) {
  const [open, setOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(false)

  return (
    <div className={cn('min-h-dvh lg:grid', collapsed ? 'lg:grid-cols-[4.5rem_minmax(0,1fr)]' : 'lg:grid-cols-[16.25rem_minmax(0,1fr)]')}>
      <aside
        data-collapsed={collapsed}
        className="group/sidebar sticky top-0 hidden h-dvh flex-col gap-6 border-r bg-sidebar px-3 py-4 lg:flex"
      >
        <div className="flex items-center justify-between gap-2 px-1 group-data-[collapsed=true]/sidebar:justify-center">
          <Brand />
        </div>
        <nav aria-label="Primary" className="flex-1">{nav}</nav>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="justify-start text-muted-foreground-strong group-data-[collapsed=true]/sidebar:justify-center"
          aria-pressed={collapsed}
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <PanelLeftOpenIcon aria-hidden="true" /> : <PanelLeftCloseIcon aria-hidden="true" />}
          <span className="group-data-[collapsed=true]/sidebar:sr-only">{collapsed ? 'Expand sidebar' : 'Collapse sidebar'}</span>
        </Button>
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b bg-background/90 px-4 backdrop-blur md:px-6 lg:px-8">
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger render={<Button variant="ghost" size="icon" className="-ml-2 lg:hidden" />}>
              <MenuIcon aria-hidden="true" />
              <span className="sr-only">Open navigation</span>
            </SheetTrigger>
            <SheetContent side="left" className="w-72 max-w-[85vw] bg-sidebar p-4">
              <SheetHeader className="p-0">
                <SheetTitle><Brand /></SheetTitle>
                <SheetDescription className="sr-only">Primary site navigation</SheetDescription>
              </SheetHeader>
              {/* close the drawer when a link inside it is followed */}
              <nav aria-label="Primary mobile" onClick={(e) => { if ((e.target as HTMLElement).closest('a')) setOpen(false) }}>{nav}</nav>
            </SheetContent>
          </Sheet>
          <div className="min-w-0 flex-1">{breadcrumb}</div>
          <div className="flex shrink-0 items-center gap-3">{account}</div>
        </header>

        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-7xl flex-1 space-y-6 px-4 py-6 focus:outline-none md:px-6 md:py-8 lg:px-8">
          {children}
        </main>
      </div>
    </div>
  )
}
