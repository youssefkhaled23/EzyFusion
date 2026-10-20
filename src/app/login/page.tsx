import { Suspense } from 'react'
import { redirect } from 'next/navigation'
import { BadgeCheckIcon, CalendarClockIcon, ShieldCheckIcon } from 'lucide-react'
import { LoginForm } from '@/components/auth/login-form'
import { LogoutButton } from '@/components/auth/logout-button'
import { Skeleton } from '@/components/ui/skeleton'
import { getViewer } from '@/server/http/session'

const POINTS = [
  { icon: CalendarClockIcon, title: 'Invoices from the lease', text: 'Deposit and monthly rent are scheduled automatically, in Malaysia time.' },
  { icon: BadgeCheckIcon, title: 'Verified payments', text: 'Staff record cash and transfers; a manager approves before money is applied.' },
  { icon: ShieldCheckIcon, title: 'Separated by organization', text: 'Every organization, and every tenant, only ever sees their own records.' },
]

async function LoginContent() {
  const viewer = await getViewer()
  if (viewer && viewer.portal !== 'none') redirect('/') // already signed in: go to the right portal
  if (viewer) {
    return (
      <div className="space-y-4" data-testid="no-access">
        <p role="alert" className="text-sm text-muted-foreground-strong">This account has no access to any organization. Ask an administrator to add you, or sign in with a different account.</p>
        <LogoutButton />
      </div>
    )
  }
  return <LoginForm />
}

function Mark() {
  return (
    <div className="flex items-center gap-2.5">
      <span aria-hidden="true" className="flex size-9 items-center justify-center rounded-lg bg-primary text-base font-bold text-primary-foreground">E</span>
      <span className="text-lg font-semibold tracking-tight">EzyFusion</span>
    </div>
  )
}

export default function LoginPage() {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <aside className="relative hidden flex-col justify-between overflow-hidden border-r bg-sidebar p-12 lg:flex">
        <div aria-hidden="true" className="pointer-events-none absolute -top-40 -left-32 size-[28rem] rounded-full bg-primary/10 blur-3xl" />
        <Mark />
        <div className="relative max-w-md space-y-8">
          <div className="space-y-3">
            <h2 className="text-3xl leading-tight font-semibold tracking-tight text-balance">Rent collection, kept in order.</h2>
            <p className="text-muted-foreground-strong">Leases, invoices and payments for property teams and their tenants, in one place.</p>
          </div>
          <ul className="space-y-5">
            {POINTS.map(({ icon: Icon, title, text }) => (
              <li key={title} className="flex gap-3.5">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-info-subtle text-info-subtle-foreground"><Icon aria-hidden="true" className="size-[18px]" /></span>
                <div>
                  <p className="text-sm font-medium">{title}</p>
                  <p className="text-sm text-muted-foreground-strong">{text}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-muted-foreground">All amounts in Malaysian ringgit (RM).</p>
      </aside>

      <main id="main" tabIndex={-1} className="flex flex-col justify-center px-4 py-10 focus:outline-none sm:px-8">
        <div className="mx-auto w-full max-w-sm space-y-8">
          <div className="lg:hidden"><Mark /></div>
          <div className="space-y-1.5">
            <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
            <p className="text-sm text-muted-foreground-strong">Use your EzyFusion account.</p>
          </div>
          <Suspense fallback={<div className="space-y-4"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></div>}>
            <LoginContent />
          </Suspense>
        </div>
      </main>
    </div>
  )
}
