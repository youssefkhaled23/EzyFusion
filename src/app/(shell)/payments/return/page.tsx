import Link from 'next/link'
import { Suspense } from 'react'
import { CircleCheckIcon, CircleXIcon, ClockIcon, SearchXIcon, LogInIcon } from 'lucide-react'
import { MoneyDisplay } from '@/components/money-display'
import { PageHeader } from '@/components/page-header'
import { BillStatusBadge } from '@/components/status-badges'
import { buttonVariants } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { getBillForTenant } from '@/server/domain/gateway'
import { getPrisma } from '@/server/db'
import { sessionUserId } from '@/server/http/session'

const LABEL = { pending: 'Payment pending', paid: 'Payment received', failed: 'Payment failed' } as const
const DETAIL = {
  pending: 'We are waiting for confirmation from the payment gateway. This page shows the confirmed status only; refresh in a moment.',
  paid: 'The payment gateway confirmed this payment and it has been applied to your invoices.',
  failed: 'The payment gateway reported that this payment did not go through. Nothing was charged to your balance. You can start a new payment from your lease.',
} as const
const ICON = { pending: ClockIcon, paid: CircleCheckIcon, failed: CircleXIcon } as const
const TINT = { pending: 'bg-warning-subtle text-warning-subtle-foreground', paid: 'bg-success-subtle text-success-subtle-foreground', failed: 'bg-destructive-subtle text-destructive-subtle-foreground' } as const

function Notice({ state, icon: Icon, title, text, action }: { state: string; icon: typeof ClockIcon; title: string; text: string; action?: React.ReactNode }) {
  return (
    <div data-testid="return-state" data-state={state} className="flex flex-col items-center gap-3 py-6 text-center">
      <span className="flex size-14 items-center justify-center rounded-full bg-elevated text-muted-foreground-strong"><Icon aria-hidden="true" className="size-6" /></span>
      <p className="text-lg font-semibold">{title}</p>
      <p className="max-w-sm text-sm text-muted-foreground-strong">{text}</p>
      {action}
    </div>
  )
}

async function BillStatus({ searchParams }: { searchParams: PageProps<'/payments/return'>['searchParams'] }) {
  // Only bill_id is read. The `paid` query parameter is UNTRUSTED and is deliberately ignored: the gateway webhook is
  // the only thing that settles a bill, and this page only ever displays the persisted status.
  const { bill_id: billId } = await searchParams
  const userId = await sessionUserId()
  if (!userId) {
    return <Notice state="signin" icon={LogInIcon} title="Please sign in to view this payment." text="Sign in with the account that created the payment." action={<Link href="/login" className={buttonVariants()}>Sign in</Link>} />
  }

  const bill = typeof billId === 'string' ? await getBillForTenant(getPrisma(), userId, billId) : null
  if (!bill) {
    return <Notice state="not-found" icon={SearchXIcon} title="Payment not found." text="This payment does not exist or does not belong to your account." action={<Link href="/portal" className={buttonVariants({ variant: 'outline' })}>Back to my leases</Link>} />
  }

  const Icon = ICON[bill.status]
  return (
    <div data-testid="return-state" data-state="bill" data-bill-status={bill.status} className="flex flex-col items-center gap-4 py-6 text-center">
      <span className={`flex size-14 items-center justify-center rounded-full ${TINT[bill.status]}`}><Icon aria-hidden="true" className="size-6" /></span>
      <div className="space-y-2">
        <p className="text-lg font-semibold">{LABEL[bill.status]}</p>
        <BillStatusBadge status={bill.status} />
      </div>
      <p className="text-3xl font-semibold tracking-tight">
        <span className="sr-only">Amount: </span>
        <MoneyDisplay amount={BigInt(bill.amountSen)} currency="MYR" className="text-3xl font-semibold" />
      </p>
      <p className="max-w-sm text-sm text-muted-foreground-strong">{DETAIL[bill.status]}</p>
      <Link href="/portal" className={buttonVariants({ variant: 'outline' })}>Back to my leases</Link>
    </div>
  )
}

export default function PaymentReturnPage(props: PageProps<'/payments/return'>) {
  return (
    <>
      <PageHeader eyebrow="Payments" title="Payment status" description="The confirmed status of your payment, as recorded by the payment gateway." />
      <Card className="mx-auto w-full max-w-xl">
        <div className="px-(--card-spacing)">
          <Suspense fallback={<div className="space-y-3 py-6" role="status" aria-busy="true"><span className="sr-only">Loading…</span><Skeleton className="mx-auto size-14 rounded-full" /><Skeleton className="mx-auto h-5 w-40" /><Skeleton className="mx-auto h-8 w-32" /></div>}>
            <BillStatus searchParams={props.searchParams} />
          </Suspense>
        </div>
      </Card>
    </>
  )
}
