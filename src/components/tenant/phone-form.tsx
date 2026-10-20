'use client'

import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { FormField } from '@/components/form-field'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { createClient } from '@/lib/supabase/browser'

/**
 * Updates the tenant's own phone number straight from the browser with the user's session (publishable key): the database
 * allows exactly this write (column-level UPDATE(phone) grant + own-row RLS policy). The service role is never involved.
 */
export function PhoneForm({ tenantId, phone }: { tenantId: string; phone: string | null }) {
  const router = useRouter()
  const [value, setValue] = useState(phone ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmed = value.trim()
    if (trimmed.length > 32) {
      setError('A phone number can have at most 32 characters.')
      return
    }
    if (trimmed !== '' && !/^[+0-9 ()-]{3,32}$/.test(trimmed)) {
      setError('Use digits, spaces, + ( ) and - only, for example +60 12 345 6789.')
      return
    }
    setError(null)
    setBusy(true)
    const { data, error: updateError } = await createClient().from('tenants').update({ phone: trimmed === '' ? null : trimmed }).eq('id', tenantId).select('phone')
    setBusy(false)
    if (updateError || !data || data.length !== 1) {
      const message = 'Could not update your phone number.'
      setError(message)
      toast.error(message)
      return
    }
    toast.success('Phone number updated')
    router.refresh()
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4" data-testid="phone-form">
      <FormField id="tenant-phone" label="Phone number" error={error} hint="Digits, spaces, + ( ) and - only.">
        {(field) => <Input {...field} type="tel" autoComplete="tel" placeholder="+60 12 345 6789" value={value} onChange={(e) => setValue(e.target.value)} />}
      </FormField>
      <Button type="submit" disabled={busy} aria-busy={busy} data-testid="save-phone">
        {busy ? 'Saving…' : 'Save phone number'}
      </Button>
    </form>
  )
}
