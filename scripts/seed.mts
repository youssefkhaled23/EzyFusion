/**
 * Seeds the local database and Supabase Auth. Idempotent: reference data uses fixed ids; leases, invoices, payments and
 * allocations are created through the SAME domain functions the API uses (createLease, recordPayment, approvePayment),
 * and anything that already exists is left alone.
 * Server-side only: uses SUPABASE_SECRET_KEY (bypasses RLS) and the owner database connection.
 * Run after `npx supabase db reset`:  npm run seed
 */
import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { createLease } from "../src/server/domain/leases";
import { approvePayment, recordPayment } from "../src/server/domain/payments";
import { createPrismaClient } from "../src/server/prisma";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* rely on the process environment */
}
const need = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (cp .env.example .env.local)`);
  return value;
};
const supabaseUrl = need("NEXT_PUBLIC_SUPABASE_URL");
const secretKey = need("SUPABASE_SECRET_KEY");
const password = need("SEED_PASSWORD");

/** Deterministic UUID from a stable name, so the seed is reproducible and re-runnable. */
function id(name: string): string {
  const h = createHash("sha1").update(`ezyfusion-seed:${name}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// ---- data ----------------------------------------------------------------------------------------------------------------
const ORG = { northwind: id("org:northwind"), beta: id("org:beta") };

const USERS = [
  { email: "manager@northwind.test", org: ORG.northwind, role: "manager" as const, name: "Northwind Manager" },
  { email: "staff@northwind.test", org: ORG.northwind, role: "staff" as const, name: "Northwind Staff" },
  { email: "aisyah@northwind.test", org: ORG.northwind, role: "tenant" as const, name: "Aisyah Rahman", phone: "+60123456781" },
  { email: "ben@northwind.test", org: ORG.northwind, role: "tenant" as const, name: "Ben Lim", phone: "+60123456782" },
  { email: "probe@northwind.test", org: ORG.northwind, role: "tenant" as const, name: "Probe Tenant", phone: "+60123456783" },
  { email: "manager@beta.test", org: ORG.beta, role: "manager" as const, name: "Beta Manager" },
  { email: "chen@beta.test", org: ORG.beta, role: "tenant" as const, name: "Chen Wei", phone: "+60123456784" },
].map((u) => ({ ...u, userId: id(`user:${u.email}`) }));
const user = (email: string) => USERS.find((u) => u.email === email)!;

const UNITS = [
  { key: "A-12-3", org: ORG.northwind },
  { key: "B-05-1", org: ORG.northwind },
  { key: "C-01-7", org: ORG.northwind },
  { key: "D-03-2", org: ORG.northwind }, // intentionally has no lease
  { key: "KL-1", org: ORG.beta },
].map((u) => ({ ...u, id: id(`unit:${u.org}:${u.key}`) }));

const LEASES = [
  { key: "aisyah", unit: "A-12-3", tenant: "aisyah@northwind.test", start: "2026-01-31", end: "2026-07-15", rent: 150000, deposit: 300000 },
  { key: "ben", unit: "B-05-1", tenant: "ben@northwind.test", start: "2026-01-01", end: "2026-04-15", rent: 100029, deposit: 0 },
  { key: "probe", unit: "C-01-7", tenant: "probe@northwind.test", start: "2026-02-28", end: "2027-02-27", rent: 200000, deposit: 400000 },
  { key: "chen", unit: "KL-1", tenant: "chen@beta.test", start: "2026-03-15", end: "2027-03-14", rent: 220000, deposit: 440000 },
].map((l) => {
  const tenant = user(l.tenant);
  return { ...l, org: tenant.org, id: id(`lease:${l.key}`), unitId: UNITS.find((u) => u.key === l.unit)!.id, tenantId: id(`tenant:${l.tenant}`) };
});

// 1x1 PNG used as the slip image (a real object in the private payment-slips bucket).
const SLIP_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

// ---- run -------------------------------------------------------------------------------------------------------------------------
const admin = createClient(supabaseUrl, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
const prisma = createPrismaClient();

// 1. Auth users (fixed ids; password reset to the documented one on every run)
for (const u of USERS) {
  const existing = await admin.auth.admin.getUserById(u.userId);
  const attrs = { email: u.email, password, email_confirm: true, user_metadata: { full_name: u.name } };
  const { error } = existing.data.user
    ? await admin.auth.admin.updateUserById(u.userId, attrs)
    : await admin.auth.admin.createUser({ id: u.userId, ...attrs });
  if (error) throw new Error(`auth user ${u.email}: ${error.message}`);
}

// 2. Organizations, memberships, units, tenants, leases
await prisma.organization.createMany({
  data: [
    { id: ORG.northwind, name: "Northwind Properties" },
    { id: ORG.beta, name: "Beta Realty" },
  ],
  skipDuplicates: true,
});
await prisma.membership.createMany({
  data: USERS.filter((u) => u.role !== "tenant").map((u) => ({ userId: u.userId, orgId: u.org, role: u.role })),
  skipDuplicates: true,
});
await prisma.unit.createMany({ data: UNITS.map((u) => ({ id: u.id, orgId: u.org, name: u.key })), skipDuplicates: true });
await prisma.tenant.createMany({
  data: USERS.filter((u) => u.role === "tenant").map((u) => ({
    id: id(`tenant:${u.email}`),
    orgId: u.org,
    userId: u.userId,
    fullName: u.name,
    email: u.email,
    phone: u.phone,
  })),
  skipDuplicates: true,
});
// 3. Leases + ALL invoices: the real createLease() (generateSchedule inside one transaction, overlap guard, audit row).
const toDate = (iso: string) => new Date(`${iso}T00:00:00Z`);
for (const l of LEASES) {
  const exists = await prisma.lease.findFirst({ where: { unitId: l.unitId, tenantId: l.tenantId, startDate: toDate(l.start), endDate: toDate(l.end) } });
  if (exists) continue;
  const manager = USERS.find((u) => u.org === l.org && u.role === "manager")!;
  await createLease(prisma, manager.userId, {
    unitId: l.unitId,
    tenantId: l.tenantId,
    startDate: l.start,
    endDate: l.end,
    monthlyRentSen: l.rent,
    depositSen: l.deposit,
  });
}

// 4. Aisyah's payments through the real payment domain (allocation, cap, locking, audit).
const northwind = ORG.northwind;
const aisyahLease = await prisma.lease.findFirstOrThrow({ where: { tenantId: id("tenant:aisyah@northwind.test"), orgId: northwind } });
const manager = user("manager@northwind.test");
const staff = user("staff@northwind.test");
const cashReceived = new Date("2026-01-31T10:00:00+08:00");
const transferReceived = new Date("2026-03-01T00:30:00+08:00");

// 4a. approved cash 300000, recorded by the manager (manager-recorded manual payments are approved immediately)
if (!(await prisma.payment.findFirst({ where: { leaseId: aisyahLease.id, method: "cash", receivedAt: cashReceived } }))) {
  await recordPayment(prisma, manager.userId, aisyahLease.id, { amountSen: 300000, method: "cash", receivedAt: cashReceived });
}

// 4b. bank transfer 200000 with a real slip in the private bucket: recorded by STAFF (pending_verification), approved by the manager
if (!(await prisma.payment.findFirst({ where: { leaseId: aisyahLease.id, method: "bank_transfer", receivedAt: transferReceived } }))) {
  const slipPath = `${northwind}/${id("slip:aisyah:transfer")}.png`;
  const upload = await admin.storage.from("payment-slips").upload(slipPath, SLIP_PNG, { contentType: "image/png", upsert: true });
  if (upload.error) throw new Error(`slip upload: ${upload.error.message}`);
  const { id: paymentId, status } = await recordPayment(prisma, staff.userId, aisyahLease.id, { amountSen: 200000, method: "bank_transfer", receivedAt: transferReceived, slipPath });
  if (status !== "pending_verification") throw new Error(`staff payment should be pending_verification, got ${status}`);
  await approvePayment(prisma, manager.userId, paymentId);
}

const counts = {
  organizations: await prisma.organization.count(),
  memberships: await prisma.membership.count(),
  units: await prisma.unit.count(),
  tenants: await prisma.tenant.count(),
  leases: await prisma.lease.count(),
  invoices: await prisma.invoice.count(),
  payments: await prisma.payment.count(),
  paymentAllocations: await prisma.paymentAllocation.count(),
  auditLog: await prisma.auditLog.count(),
};
console.log("seed complete:", JSON.stringify(counts));
await prisma.$disconnect();
