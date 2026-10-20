import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

/**
 * Server-side data access. SECURITY: this connection is the database OWNER and BYPASSES Row Level Security.
 * Authorization is NOT provided by the database here: every caller must first verify the Supabase user, resolve the
 * user's membership / tenant row and scope every query by org_id (and tenant) itself.
 * Never import this from client code (use `src/server/db.ts`, which is guarded by `server-only`, inside the app).
 */
export function createPrismaClient(connectionString = process.env.DATABASE_URL): PrismaClient {
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export function getPrisma(): PrismaClient {
  globalForPrisma.prisma ??= createPrismaClient();
  return globalForPrisma.prisma;
}
