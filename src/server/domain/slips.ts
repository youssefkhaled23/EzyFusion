import { createClient } from '@supabase/supabase-js'
import type { Db } from './db'
import { HttpError } from './errors'

export const SLIP_BUCKET = 'payment-slips'
export const SLIP_MAX_BYTES = 5 * 1024 * 1024
export const SLIP_MIME_TYPES = ['image/jpeg', 'image/png', 'application/pdf']

/** Structural check only: the path must be "<org_id>/<file>" with no traversal tricks. */
export function slipPathBelongsToOrg(path: unknown, orgId: string): path is string {
  return (
    typeof path === 'string' &&
    path.length <= 512 &&
    path.startsWith(`${orgId}/`) &&
    path.length > orgId.length + 1 &&
    !path.includes('..') &&
    !path.includes('\\') &&
    !path.includes('//') &&
    !path.endsWith('/') &&
    !/[\u0000-\u001f]/.test(path)
  )
}

async function slipObject(db: Db, path: string): Promise<{ size: number; mimetype: string } | null> {
  const rows = await db.$queryRaw<{ size: string | null; mimetype: string | null }[]>`
    select metadata->>'size' as size, metadata->>'mimetype' as mimetype
    from storage.objects where bucket_id = ${SLIP_BUCKET} and name = ${path}`
  if (rows.length === 0) return null
  return { size: Number(rows[0].size), mimetype: String(rows[0].mimetype) }
}

/**
 * A slip is accepted only if it exists in the private bucket under the payment's organization, is a JPEG/PNG/PDF of
 * at most 5 MB, and is not already attached to another payment. Never trusts the client's idea of the path.
 */
export async function validateSlip(db: Db, orgId: string, path: unknown): Promise<string> {
  if (!slipPathBelongsToOrg(path, orgId)) throw new HttpError(400, 'slipPath must be "<your organization id>/<file>" in the payment-slips bucket')
  const object = await slipObject(db, path)
  if (!object) throw new HttpError(400, 'slip not found in storage; upload it before recording the payment')
  if (!SLIP_MIME_TYPES.includes(object.mimetype)) throw new HttpError(400, 'slip must be a JPEG, PNG or PDF')
  if (!Number.isFinite(object.size) || object.size <= 0 || object.size > SLIP_MAX_BYTES) throw new HttpError(400, 'slip must be at most 5 MB')
  if (await db.payment.findFirst({ where: { slipPath: path }, select: { id: true } })) throw new HttpError(409, 'slip is already attached to another payment')
  return path
}

/**
 * Deletes an uploaded slip after a failed payment recording. Safe by construction: it only touches objects inside the
 * caller's own organization prefix that no payment references (checked again right before deleting), so a slip that
 * backs an existing payment is never removed. Best effort: failures are swallowed.
 */
export async function cleanupOrphanSlip(db: Db, orgId: string, path: unknown): Promise<boolean> {
  try {
    if (!slipPathBelongsToOrg(path, orgId)) return false
    if (!(await slipObject(db, path))) return false
    if (await db.payment.findFirst({ where: { slipPath: path }, select: { id: true } })) return false
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.SUPABASE_SECRET_KEY
    if (!url || !key) return false
    const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
    const { error } = await admin.storage.from(SLIP_BUCKET).remove([path])
    return !error
  } catch {
    return false
  }
}
