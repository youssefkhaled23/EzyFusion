import 'server-only'
import { notFound, redirect } from 'next/navigation'
import { HttpError } from '../domain/errors'
import { getViewer } from './session'

export type PageViewer = NonNullable<Awaited<ReturnType<typeof getViewer>>>

/**
 * Page-level role guard. Unauthenticated visitors go to /login; a signed-in user in the wrong portal is sent to their own.
 * (The data functions behind each page authorize again; this only decides where a user belongs.)
 */
export async function requirePortal(kind: 'staff' | 'tenant'): Promise<PageViewer> {
  const viewer = await getViewer()
  if (!viewer) redirect('/login')
  if (viewer.portal === 'none') redirect('/login')
  const isStaff = viewer.portal === 'manager' || viewer.portal === 'staff'
  if (kind === 'staff' && !isStaff) redirect('/portal')
  if (kind === 'tenant' && isStaff) redirect('/dashboard')
  return viewer
}

/** Runs a read-model query; a 404/403 from the domain layer becomes the framework's not-found page. */
export async function orNotFound<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (e) {
    if (e instanceof HttpError && (e.status === 404 || e.status === 403)) notFound()
    throw e
  }
}
