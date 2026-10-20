'use client'

import Link from 'next/link'
import { useState } from 'react'
import { CreditCardIcon, Loader2Icon } from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { describeFailure, postJson } from '@/lib/api-client'
import { formatRM } from '@/lib/format-my'

interface Bill {
  billId: string
  amountSen: number
}

export function PayNow({ leaseId, dueNowSen }: { leaseId: string; dueNowSen: number }) {
  const [busy, setBusy] = useState(false)
  const [bill, setBill] = useState<Bill | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function create() {
    setBusy(true)
    setError(null)
    const result = await postJson<Bill>(`/api/leases/${leaseId}/gateway-bills`)
    setBusy(false)
    if (!result.ok || !result.data) {
      const message = result.status === 422 ? 'Nothing is due on this lease right now.' : describeFailure(result.status, result.error)
      setError(message)
      toast.error(message)
      return
    }
    setBill(result.data)
    toast.success(`Payment bill created for ${formatRM(result.data.amountSen)}`)
  }

  return (
    <div className="space-y-5" data-testid="pay-now">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <p className="text-sm font-medium text-muted-foreground-strong">Outstanding balance due now</p>
          <p className="text-4xl font-semibold tracking-tight num" data-testid="due-now">{formatRM(dueNowSen)}</p>
          <p className="text-sm text-muted-foreground">
            {dueNowSen <= 0 ? 'Nothing is due right now.' : 'Unpaid rent and deposit on invoices that are already due.'}
          </p>
        </div>
        <Button type="button" size="lg" className="h-12 px-6 text-base sm:min-w-44" onClick={create} disabled={busy || dueNowSen <= 0} aria-busy={busy} data-testid="pay-now-button">
          {busy ? <Loader2Icon aria-hidden="true" className="animate-spin" /> : <CreditCardIcon aria-hidden="true" />}
          {busy ? 'Creating bill…' : 'Pay now'}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">Pay now creates a payment bill. Your balance only changes after the payment gateway confirms the payment.</p>
      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Could not create the bill</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {bill ? (
        <Alert variant="success" data-testid="bill-created">
          <AlertTitle>Payment bill created</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>
              Amount: <strong className="num">{formatRM(bill.amountSen)}</strong>
            </p>
            <p className="break-all">
              Bill ID: <code className="rounded bg-background/60 px-1.5 py-0.5 font-mono text-xs" data-testid="bill-id">{bill.billId}</code>
            </p>
            <p>
              <Link className="font-medium underline underline-offset-2" href={`/payments/return?bill_id=${bill.billId}`} data-testid="bill-return-link">
                Check payment status
              </Link>
            </p>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  )
}
