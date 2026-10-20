'use client'

import { useRouter } from 'next/navigation'
import { useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from 'react'
import { toast } from 'sonner'
import { cleanupSlip } from '@/app/actions/slips'
import { FileCheckIcon, InfoIcon, Loader2Icon, UploadCloudIcon } from 'lucide-react'
import { FormField } from '@/components/form-field'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { describeFailure, postJson } from '@/lib/api-client'
import { parseRinggitToSen } from '@/lib/billing'
import { formatRM, malaysiaInputToIso, toMalaysiaInputValue } from '@/lib/format-my'
import { createClient } from '@/lib/supabase/browser'

const SLIP_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' }
const SLIP_MAX = 5 * 1024 * 1024
const METHODS = [
  { value: 'cash', label: 'Cash' },
  { value: 'bank_transfer', label: 'Bank transfer' },
]

type Errors = Partial<Record<'amount' | 'receivedAt' | 'slip', string>>

interface Props {
  leaseId: string
  /** Organization folder for slips (the organization id is not a secret; Storage RLS enforces the rest). */
  orgId: string
  role: 'manager' | 'staff'
}

export function PaymentForm({ leaseId, orgId, role }: Props) {
  const router = useRouter()
  const fileRef = useRef<HTMLInputElement>(null)
  const [method, setMethod] = useState<string>('cash')
  const [amount, setAmount] = useState('')
  // Default "received" time = now in Malaysia time. It is only computed on the client (never during server rendering), so
  // there is no hydration mismatch; until the user edits the field, the default is used.
  const mounted = useSyncExternalStore(() => () => undefined, () => true, () => false)
  const defaultReceivedAt = useMemo(() => (mounted ? toMalaysiaInputValue(new Date()) : ''), [mounted])
  const [receivedEdit, setReceivedEdit] = useState<string | null>(null)
  const receivedAt = receivedEdit ?? defaultReceivedAt
  const setReceivedAt = setReceivedEdit
  const [file, setFile] = useState<File | null>(null)
  const [errors, setErrors] = useState<Errors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting) return
    setFormError(null)
    const next: Errors = {}

    let amountSen = 0
    try {
      amountSen = parseRinggitToSen(amount)
      if (amountSen <= 0) next.amount = 'Amount must be greater than zero.'
    } catch {
      next.amount = 'Enter a valid amount in ringgit, for example 1,500.50 (at most 2 decimals).'
    }
    const iso = malaysiaInputToIso(receivedAt)
    if (!iso) next.receivedAt = 'Enter the date and time the payment was received (Malaysia time).'
    if (method === 'bank_transfer') {
      if (!file) next.slip = 'Attach the bank transfer slip (JPEG, PNG or PDF).'
      else if (!(file.type in SLIP_TYPES)) next.slip = 'The slip must be a JPEG, PNG or PDF file.'
      else if (file.size > SLIP_MAX) next.slip = 'The slip must be 5 MB or smaller.'
      else if (file.size === 0) next.slip = 'The selected file is empty.'
    }
    setErrors(next)
    if (Object.keys(next).length > 0 || !iso) return

    setSubmitting(true)
    let uploaded: string | null = null
    try {
      if (method === 'bank_transfer' && file) {
        const path = `${orgId}/${crypto.randomUUID()}.${SLIP_TYPES[file.type]}`
        const { error } = await createClient().storage.from('payment-slips').upload(path, file, { contentType: file.type, upsert: false })
        if (error) {
          fail('Could not upload the slip. Check the file and try again.')
          return
        }
        uploaded = path
      }
      const result = await postJson<{ id: string; status: string }>(`/api/leases/${leaseId}/payments`, {
        amountSen,
        method,
        receivedAt: iso,
        ...(uploaded ? { slipPath: uploaded } : {}),
      })
      if (!result.ok || !result.data) {
        // the server removes unreferenced slips itself after a failed recording; this covers rejections before that point.
        if (uploaded) await cleanupSlip(uploaded).catch(() => undefined)
        fail(describeFailure(result.status, result.error))
        return
      }
      toast.success(result.data.status === 'approved' ? `Payment of ${formatRM(amountSen)} recorded and approved` : `Payment of ${formatRM(amountSen)} recorded, pending verification`)
      setAmount('')
      setFile(null)
      if (fileRef.current) fileRef.current.value = ''
      setReceivedAt(toMalaysiaInputValue(new Date()))
      router.refresh()
    } finally {
      setSubmitting(false)
    }
  }

  function fail(message: string) {
    setFormError(message)
    toast.error(message)
    setSubmitting(false)
  }

  const fileSize = file ? (file.size >= 1024 * 1024 ? `${(file.size / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(file.size / 1024))} KB`) : ''

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5" data-testid="payment-form">
      <p className="flex items-start gap-2 rounded-lg bg-elevated px-3.5 py-3 text-sm text-muted-foreground-strong">
        <InfoIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
        {role === 'manager' ? 'Payments you record are approved immediately.' : 'Payments you record wait for a manager to verify them.'}
      </p>
      {formError ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Payment not recorded</AlertTitle>
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-x-5 gap-y-4 md:grid-cols-3">
        <FormField id="pay-method" label="Method" hint={method === 'cash' ? 'Cash handed over in person.' : 'A bank slip is required.'}>
          {(field) => (
            <Select items={METHODS} value={method} onValueChange={(v) => { setMethod(v ?? 'cash'); setErrors((e) => ({ ...e, slip: undefined })) }}>
              <SelectTrigger id={field.id}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {METHODS.map((m) => (
                  <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </FormField>
        <FormField id="pay-amount" label="Amount (RM)" error={errors.amount} hint="Up to 2 decimals, for example 1,500.50">
          {(field) => (
            <div className="relative">
              <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted-foreground-strong">RM</span>
              <Input {...field} inputMode="decimal" autoComplete="off" className="pl-10 text-right num" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
          )}
        </FormField>
        <FormField id="pay-received" label="Received (Malaysia time, UTC+8)" error={errors.receivedAt}>
          {(field) => <Input {...field} type="datetime-local" value={receivedAt} onChange={(e) => setReceivedAt(e.target.value)} />}
        </FormField>
      </div>
      {method === 'bank_transfer' ? (
        <FormField id="pay-slip" label="Transfer slip" error={errors.slip} hint="JPEG, PNG or PDF, up to 5 MB.">
          {(field) => (
            <div>
              <input {...field} ref={fileRef} type="file" className="peer sr-only" accept="image/jpeg,image/png,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              <label
                htmlFor={field.id}
                className="flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-input bg-background px-4 py-4 text-sm transition-colors hover:border-primary hover:bg-elevated/50 peer-focus-visible:border-ring peer-focus-visible:outline-2 peer-focus-visible:outline-ring/40 peer-aria-invalid:border-destructive"
              >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-info-subtle text-info-subtle-foreground">
                  {file ? <FileCheckIcon aria-hidden="true" className="size-5" /> : <UploadCloudIcon aria-hidden="true" className="size-5" />}
                </span>
                <span className="min-w-0">
                  <span className="block truncate font-medium">{file ? file.name : 'Choose the bank transfer slip'}</span>
                  <span className="block text-xs text-muted-foreground-strong">{file ? `${fileSize} · select again to replace` : 'Click to browse your files'}</span>
                </span>
              </label>
            </div>
          )}
        </FormField>
      ) : null}
      <Button type="submit" disabled={submitting} aria-busy={submitting} data-testid="record-payment" className="w-full sm:w-auto">
        {submitting ? <Loader2Icon aria-hidden="true" className="animate-spin" /> : null}
        {submitting ? 'Recording…' : 'Record payment'}
      </Button>
    </form>
  )
}
