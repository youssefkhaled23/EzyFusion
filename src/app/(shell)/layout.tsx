import { Suspense, type ReactNode } from 'react'
import { AppShell, Breadcrumb } from '@/components/app-shell'
import { AccountMenu, RoleNav } from '@/components/shell-slots'

/** Signed-in chrome (sidebar, header, account). The login page lives outside this group and has its own full-screen layout. */
export default function ShellLayout({ children }: { children: ReactNode }) {
  return (
    <AppShell
      nav={
        <Suspense fallback={null}>
          <RoleNav />
        </Suspense>
      }
      breadcrumb={
        <Suspense fallback={null}>
          <Breadcrumb />
        </Suspense>
      }
      account={
        <Suspense fallback={null}>
          <AccountMenu />
        </Suspense>
      }
    >
      {children}
    </AppShell>
  )
}
