import type { Db } from './db'

export type Portal = 'manager' | 'staff' | 'tenant' | 'none'

export interface ViewerTenant {
  id: string
  orgId: string
  fullName: string
  email: string
  phone: string | null
}

export interface ViewerProfile {
  userId: string
  portal: Portal
  /** Organizations where the user is staff or manager (from memberships; never from user_metadata). */
  staffOrgIds: string[]
  /** Tenant rows linked to this user (tenants.user_id). */
  tenants: ViewerTenant[]
}

/**
 * Roles come from the database only: memberships for staff/managers, tenants.user_id for tenants.
 * A user with any manager membership gets the manager portal; staff otherwise; tenant when only tenant rows exist.
 */
export async function resolveViewer(db: Db, userId: string): Promise<ViewerProfile> {
  const [memberships, tenants] = await Promise.all([
    db.membership.findMany({ where: { userId }, select: { orgId: true, role: true } }),
    db.tenant.findMany({ where: { userId }, select: { id: true, orgId: true, fullName: true, email: true, phone: true } }),
  ])
  const portal: Portal = memberships.some((m) => m.role === 'manager') ? 'manager' : memberships.length > 0 ? 'staff' : tenants.length > 0 ? 'tenant' : 'none'
  return { userId, portal, staffOrgIds: memberships.map((m) => m.orgId), tenants }
}
