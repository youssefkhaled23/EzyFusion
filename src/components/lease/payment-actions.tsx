'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'
import { ConfirmationDialog } from '@/components/confirmation-dialog'
import { Button } from '@/components/ui/button'
import { describeFailure, postJson } from '@/lib/api-client'


interface Props {
  paymentId: string
  status: string
  amountLabel: string
}

/** Manager-only controls. The server enforces the role too; staff never receive this component. */
export function PaymentActions({ paymentId, status, amountLabel }: Props) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function run(action: 'approve' | 'reject' | 'void', body: unknown, success: string): Promise<string | null> {
    const result = await postJson(`/api/payments/${paymentId}/${action}`, body)
    if (!result.ok) {
      const message = describeFailure(result.status, result.error)
      toast.error(message)
      router.refresh() // the payment may have changed meanwhile
      return message
    }
    toast.success(success)
    router.refresh()
    return null
  }

  if (status === 'pending_verification') {
    return (
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={busy} aria-busy={busy} data-testid="approve-payment" onClick={async () => { setBusy(true); await run('approve', {}, `Payment of ${amountLabel} approved`); setBusy(false) }}>
          Approve
        </Button>
        <ConfirmationDialog
          trigger={<Button type="button" variant="outline" size="sm" data-testid="reject-payment">Reject</Button>}
          title="Reject payment"
          description={`Reject the pending payment of ${amountLabel}. The reason is kept in the audit log.`}
          confirmLabel="Reject payment"
          destructive
          requireReason
          onConfirm={(reason) => run('reject', { reason }, 'Payment rejected')}
        />
      </div>
    )
  }
  if (status === 'approved') {
    return (
      <ConfirmationDialog
        trigger={<Button type="button" variant="outline" size="sm" data-testid="void-payment">Void</Button>}
        title="Void this payment?"
        description={`This removes the payment of ${amountLabel} from the invoices it paid. Other payments are not reallocated. This cannot be undone.`}
        confirmLabel="Void payment"
        destructive
        requireReason
        onConfirm={(reason) => run('void', { reason }, 'Payment voided')}
      />
    )
  }
  return null
}
