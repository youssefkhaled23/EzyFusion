'use client'

import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { FormField } from '@/components/form-field'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { createClient } from '@/lib/supabase/browser'

export function LoginForm() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting) return
    setError(null)
    if (!email.trim() || !password) {
      setError('Enter your email and password.')
      return
    }
    setSubmitting(true)
    const { error: authError } = await createClient().auth.signInWithPassword({ email: email.trim(), password })
    if (authError) {
      // One generic message for every credential failure; network problems are reported as such.
      const message = authError.status === 400 || authError.status === 401 ? 'Invalid email or password.' : 'Sign-in failed. Please try again.'
      setError(message)
      toast.error(message)
      setSubmitting(false)
      return
    }
    toast.success('Signed in')
    router.replace('/') // the home page sends each role to its own portal
    router.refresh()
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5" aria-describedby={error ? 'login-error' : undefined}>
      {error ? (
        <Alert variant="destructive" id="login-error">
          <AlertTitle>Could not sign in</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <FormField id="login-email" label="Email">
        {(field) => <Input {...field} type="email" autoComplete="username" placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={error ? true : undefined} required />}
      </FormField>
      <FormField id="login-password" label="Password">
        {(field) => <Input {...field} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={error ? true : undefined} required />}
      </FormField>
      <Button type="submit" className="h-11 w-full" disabled={submitting} aria-busy={submitting}>
        {submitting ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  )
}
