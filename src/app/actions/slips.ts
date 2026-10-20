'use server'

import { getPrisma } from '@/server/db'
import { resolveViewer } from '@/server/domain/viewer'
import { cleanupOrphanSlip } from '@/server/domain/slips'
import { sessionUserId } from '@/server/http/session'

/**
 * Removes a slip the browser uploaded for a payment that then failed to record. Safe: only staff/managers of the path's
 * organization, only inside that organization's folder, and only if no payment references the object.
 */
export async function cleanupSlip(path: string): Promise<{ removed: boolean }> {
  const userId = await sessionUserId()
  if (!userId || typeof path !== 'string') return { removed: false }
  const orgId = path.split('/')[0]
  const db = getPrisma()
  const viewer = await resolveViewer(db, userId)
  if (!viewer.staffOrgIds.includes(orgId)) return { removed: false }
  return { removed: await cleanupOrphanSlip(db, orgId, path) }
}
