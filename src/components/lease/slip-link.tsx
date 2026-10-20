'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { createClient } from '@/lib/supabase/browser'

/** Opens the private slip through a short-lived signed URL. Storage RLS decides who may create it (staff/managers of the org). */
export function SlipLink({ path }: { path: string }) {
  const [busy, setBusy] = useState(false)

  async function open() {
    setBusy(true)
    const { data, error } = await createClient().storage.from('payment-slips').createSignedUrl(path, 60)
    setBusy(false)
    if (error || !data) {
      toast.error('Could not open the slip.')
      return
    }
    window.open(data.signedUrl, '_blank', 'noopener,noreferrer')
  }

  return (
    <Button type="button" variant="link" className="h-8 px-0" onClick={open} disabled={busy} data-testid="slip-link">
      {busy ? 'Opening…' : 'View slip'}
    </Button>
  )
}
