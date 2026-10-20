import 'server-only'
import { unstable_rethrow } from 'next/navigation'
import { NextResponse, type NextRequest } from 'next/server'
import { HttpError } from '../domain/errors'

export const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } })

/** Maps domain errors to their HTTP status; anything unexpected becomes a generic 500 (details only in the server log). */
export async function handle(fn: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await fn()
  } catch (e) {
    unstable_rethrow(e) // Next.js control-flow errors (dynamic bail-out, redirects) must not be swallowed
    if (e instanceof HttpError) return json({ error: e.message }, e.status)
    // Only the error class and code are logged: driver errors can embed query parameters and webhook payload values.
    console.error('unhandled API error', (e as Error)?.name, (e as { code?: string })?.code)
    return json({ error: 'internal server error' }, 500)
  }
}

/** Parses a JSON object body; anything else is a 400. */
export async function readJsonObject(request: NextRequest): Promise<Record<string, unknown>> {
  const body: unknown = await request.json().catch(() => undefined)
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'request body must be a JSON object')
  return body as Record<string, unknown>
}

/** Lenient body read for endpoints whose 404/403 must win over body validation. */
export async function readJsonOrEmpty(request: NextRequest): Promise<Record<string, unknown>> {
  const body: unknown = await request.json().catch(() => undefined)
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
}
