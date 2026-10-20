import 'server-only'
import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import type { NextRequest } from 'next/server'
import { HttpError } from '../domain/errors'

const url = () => process.env.NEXT_PUBLIC_SUPABASE_URL!
const publishableKey = () => process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Returns the verified Supabase user id, from EITHER an `Authorization: Bearer <access token>` header OR the Supabase SSR
 * session cookies. Identity is always verified by the Auth server via getUser() (signature, expiry AND that the session
 * still exists). getSession() is never used: it only decodes whatever the client sent. Throws 401 when unauthenticated.
 *
 * Roles, organizations and tenancy are NOT taken from the token or the request; they are resolved from the database.
 */
export async function authenticate(request: NextRequest): Promise<string> {
  const header = request.headers.get('authorization')
  if (header !== null) {
    const match = /^Bearer\s+(\S+)$/i.exec(header.trim())
    if (!match) throw new HttpError(401, 'invalid Authorization header')
    const supabase = createClient(url(), publishableKey(), { auth: { persistSession: false, autoRefreshToken: false } })
    const { data, error } = await supabase.auth.getUser(match[1])
    if (error || !data.user) throw new HttpError(401, 'invalid or expired token')
    return data.user.id
  }

  if (request.cookies.getAll().length === 0) throw new HttpError(401, 'authentication required')
  // Cookie-authenticated, state-changing requests must come from our own origin (CSRF defence beyond SameSite=Lax).
  if (!SAFE_METHODS.has(request.method) && request.headers.get('origin') !== request.nextUrl.origin) {
    throw new HttpError(403, 'cross-origin request rejected')
  }
  const supabase = createServerClient(url(), publishableKey(), {
    cookies: { getAll: () => request.cookies.getAll(), setAll: () => undefined },
  })
  const { data, error } = await supabase.auth.getUser()
  if (error || !data.user) throw new HttpError(401, 'authentication required')
  return data.user.id
}
