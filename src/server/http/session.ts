import 'server-only'
import { createServerClient } from '@supabase/ssr'
import { cache } from 'react'
import { cookies } from 'next/headers'
import { connection } from 'next/server'
import { getPrisma } from '../db'
import { resolveViewer, type ViewerProfile } from '../domain/viewer'

export interface SessionUser {
  id: string
  email: string | undefined
}

/** Verified user from the SSR session cookies (Server Components). getUser() validates with the Auth server. */
export const sessionUser = cache(async (): Promise<SessionUser | null> => {
  // Session lookups (token expiry checks, database reads) read the clock: they must only ever run at request time, never
  // during a prerender or prefetch pass ("Blocking Route: Date.now() while prerendering").
  await connection()
  const store = await cookies()
  if (store.getAll().length === 0) return null
  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    cookies: { getAll: () => store.getAll(), setAll: () => undefined },
  })
  const { data, error } = await supabase.auth.getUser()
  return error || !data.user ? null : { id: data.user.id, email: data.user.email }
})

export async function sessionUserId(): Promise<string | null> {
  return (await sessionUser())?.id ?? null
}

/** Verified user + roles resolved from memberships / tenants (never from user_metadata). Cached per request. */
export const getViewer = cache(async (): Promise<(ViewerProfile & { email: string | undefined }) | null> => {
  const user = await sessionUser()
  if (!user) return null
  return { ...(await resolveViewer(getPrisma(), user.id)), email: user.email }
})
