'use client'

import { useState, type ReactElement } from 'react'
import { FormField } from '@/components/form-field'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'

const MIN_REASON = 5

interface Props {
  trigger: ReactElement
  title: string
  description: string
  confirmLabel: string
  destructive?: boolean
  /** When set, the user must give a reason of at least 5 characters, which is passed to onConfirm. */
  requireReason?: boolean
  /** Return an error message to keep the dialog open, or null when the action succeeded. */
  onConfirm: (reason: string) => Promise<string | null>
}

/** Accessible confirmation dialog (focus is trapped, Escape cancels). Optionally collects a reason. */
export function ConfirmationDialog({ trigger, title, description, confirmLabel, destructive, requireReason, onConfirm }: Props) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit() {
    const trimmed = reason.trim()
    if (requireReason && trimmed.length < MIN_REASON) {
      setError(`Enter a reason of at least ${MIN_REASON} characters.`)
      return
    }
    setBusy(true)
    setError(null)
    const failure = await onConfirm(trimmed)
    setBusy(false)
    if (failure) {
      setError(failure)
      return
    }
    setOpen(false)
    setReason('')
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) { setError(null); setReason('') } }}>
      <DialogTrigger render={trigger} />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {requireReason ? (
          <FormField id="reason-input" label={`Reason (at least ${MIN_REASON} characters)`} error={error}>
            {(field) => <Textarea {...field} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />}
          </FormField>
        ) : error ? (
          <p role="alert" className="text-sm text-destructive">{error}</p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
          <Button type="button" variant={destructive ? 'destructive' : 'default'} onClick={submit} disabled={busy} aria-busy={busy} data-testid="reason-confirm">
            {busy ? 'Working…' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
