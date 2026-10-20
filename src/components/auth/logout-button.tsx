'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'
import { LogOutIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { createClient } from '@/lib/supabase/browser'

export function LogoutButton() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function logout() {
    setBusy(true)
    // scope "local": end THIS browser session only (the default "global" would sign the user out everywhere)
    const { error } = await createClient().auth.signOut({ scope: 'local' })
    if (error) {
      toast.error('Could not sign out. Please try again.')
      setBusy(false)
      return
    }
    toast.success('Signed out')
    router.replace('/login')
    router.refresh()
  }

  return (
    <Button type="button" variant="outline" onClick={logout} disabled={busy}>
      <LogOutIcon aria-hidden="true" data-icon="inline-start" />
      <span className="sr-only sm:not-sr-only">Log out</span>
    </Button>
  )
}
