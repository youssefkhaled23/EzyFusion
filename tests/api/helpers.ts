import { randomUUID } from "node:crypto";
import type pg from "pg";
import { PNG, PUBLISHABLE, SECRET, URL_, ownerClient, signIn, storage } from "../db/helpers";

export { PNG, URL_ };
export const BASE = process.env.API_BASE_URL ?? "http://localhost:3300";

export const ACCOUNTS = ["manager@northwind.test", "staff@northwind.test", "aisyah@northwind.test", "ben@northwind.test", "probe@northwind.test", "manager@beta.test", "chen@beta.test"] as const;
export type Account = (typeof ACCOUNTS)[number];

export interface Ctx {
  db: pg.Client;
  tok: Record<Account, string>;
  nw: string;
  beta: string;
  unit: Record<string, string>;
  tenant: Record<string, string>;
  leaseOf: Record<string, string>;
  userId: Record<string, string>;
  created: { leases: string[]; slips: string[]; units: string[] };
}

export async function setup(): Promise<Ctx> {
  const db = await ownerClient();
  const q = async <T>(sql: string) => (await db.query(sql)).rows as T[];
  const tok = {} as Record<Account, string>;
  for (const a of ACCOUNTS) tok[a] = await signIn(a);
  const orgs = await q<{ id: string; name: string }>("select id, name from organizations");
  return {
    db,
    tok,
    nw: orgs.find((o) => o.name === "Northwind Properties")!.id,
    beta: orgs.find((o) => o.name === "Beta Realty")!.id,
    unit: Object.fromEntries((await q<{ name: string; id: string }>("select name, id from units")).map((u) => [u.name, u.id])),
    tenant: Object.fromEntries((await q<{ email: string; id: string }>("select email, id from tenants")).map((t) => [t.email, t.id])),
    leaseOf: Object.fromEntries((await q<{ email: string; id: string }>("select t.email, l.id from leases l join tenants t on t.id = l.tenant_id where l.start_date < '2100-01-01'")).map((t) => [t.email, t.id])),
    userId: Object.fromEntries((await q<{ email: string; user_id: string }>("select email, user_id from tenants")).map((t) => [t.email, t.user_id])),
    created: { leases: [], slips: [], units: [] },
  };
}

export async function teardown(ctx: Ctx) {
  const ids = ctx.created.leases;
  if (ids.length) {
    await ctx.db.query("delete from payment_allocations where payment_id in (select id from payments where lease_id = any($1))", [ids]);
    await ctx.db.query("delete from payments where lease_id = any($1)", [ids]);
    await ctx.db.query("delete from gateway_bills where lease_id = any($1)", [ids]);
    await ctx.db.query("delete from invoices where lease_id = any($1)", [ids]);
    await ctx.db.query("delete from leases where id = any($1)", [ids]);
  }
  if (ctx.created.units.length) await ctx.db.query("delete from units where id = any($1)", [ctx.created.units]);
  if (ctx.created.slips.length) await storage("object/payment-slips", { secret: true, method: "DELETE", body: JSON.stringify({ prefixes: ctx.created.slips }), headers: { "content-type": "application/json" } });
  await ctx.db.end();
}

export interface ApiOpts {
  token?: string;
  cookie?: string;
  method?: string;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
}
export async function api(path: string, opts: ApiOpts = {}) {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.cookie) headers.cookie = opts.cookie;
  let body: string | undefined = opts.rawBody;
  if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers["content-type"] = "application/json";
  }
  const res = await fetch(BASE + path, { method: opts.method ?? (body !== undefined ? "POST" : "GET"), headers, body });
  const text = await res.text();
  let data: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    data = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, data, text, headers: res.headers };
}

/** Supabase SSR cookie for a fresh session (same format @supabase/ssr writes). */
export async function sessionCookie(email: string): Promise<string> {
  const res = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: PUBLISHABLE, "content-type": "application/json" },
    body: JSON.stringify({ email, password: process.env.SEED_PASSWORD }),
  });
  const session = await res.json();
  return `sb-${new URL(URL_).hostname.split(".")[0]}-auth-token=base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
}

let nextYear = 2100 + Math.floor(Math.random() * 600);
/** A fresh calendar year per call, so test leases never overlap one another (or the seeded 2026-27 leases). */
export const freshYear = () => nextYear++;

export async function newLease(ctx: Ctx, o: { org?: "nw" | "beta"; year?: number; rent?: number; deposit?: number; start?: string; end?: string } = {}) {
  const org = o.org ?? "nw";
  const year = o.year ?? freshYear();
  const token = org === "nw" ? ctx.tok["manager@northwind.test"] : ctx.tok["manager@beta.test"];
  const body = {
    unitId: org === "nw" ? ctx.unit["D-03-2"] : ctx.unit["KL-1"],
    tenantId: org === "nw" ? ctx.tenant["ben@northwind.test"] : ctx.tenant["chen@beta.test"],
    startDate: o.start ?? `${year}-01-01`,
    endDate: o.end ?? `${year}-03-31`,
    monthlyRentSen: o.rent ?? 100000,
    depositSen: o.deposit ?? 0,
  };
  const r = await api("/api/leases", { token, body });
  if (r.status !== 201) throw new Error(`newLease failed: ${r.status} ${r.text}`);
  ctx.created.leases.push(r.data.id);
  return { id: r.data.id as string, year, body };
}

export const pay = (ctx: Ctx, leaseId: string, who: Account, amountSen: number, extra: Record<string, unknown> = {}) =>
  api(`/api/leases/${leaseId}/payments`, { token: ctx.tok[who], body: { amountSen, method: "cash", receivedAt: "2026-05-05T10:00:00+08:00", ...extra } });

export const lease = (ctx: Ctx, id: string, who: Account = "manager@northwind.test") => api(`/api/leases/${id}`, { token: ctx.tok[who] });

export async function uploadSlip(token: string | undefined, path: string, ctx?: Ctx, opts: { secret?: boolean; mime?: string; body?: BodyInit } = {}) {
  const r = await storage(`object/payment-slips/${path}`, { token, secret: opts.secret, method: "POST", body: opts.body ?? new Uint8Array(PNG), headers: { "content-type": opts.mime ?? "image/png" } });
  if (r.status === 200 && ctx) ctx.created.slips.push(path);
  return r;
}

export const rid = () => randomUUID();
export { SECRET };

/** A brand-new unit (owner SQL), so a test can create leases around "today" without ever overlapping another test. */
export async function freshUnit(ctx: Ctx, org: "nw" | "beta" = "nw"): Promise<string> {
  const id = randomUUID();
  await ctx.db.query("insert into units (id, org_id, name) values ($1, $2, $3)", [id, org === "nw" ? ctx.nw : ctx.beta, `T-${id.slice(0, 8)}`]);
  ctx.created.units.push(id);
  return id;
}
