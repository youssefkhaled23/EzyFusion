import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateSchedule, invoiceStatus } from "../../src/lib/billing";
import { type Ctx, api, freshYear, lease, newLease, rid, sessionCookie, setup, teardown } from "./helpers";

let ctx: Ctx;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => {
  await teardown(ctx);
});

describe("authentication (Bearer token and Supabase SSR cookies)", () => {
  const some = () => ctx.leaseOf["aisyah@northwind.test"];

  it("every endpoint answers 401 without credentials", async () => {
    const id = some();
    const calls: [string, string, unknown?][] = [
      ["GET", `/api/leases/${id}`],
      ["POST", "/api/leases", {}],
      ["POST", `/api/leases/${id}/payments`, {}],
      ["POST", `/api/payments/${rid()}/approve`, {}],
      ["POST", `/api/payments/${rid()}/reject`, { reason: "not valid" }],
      ["POST", `/api/payments/${rid()}/void`, { reason: "not valid" }],
      ["GET", "/api/reports/collections?from=2026-01&to=2026-03"],
    ];
    for (const [method, path, body] of calls) {
      const r = await api(path, { method, body });
      expect(r.status, `${method} ${path}`).toBe(401);
    }
  });

  it("rejects malformed, garbage, tampered and empty Bearer credentials", async () => {
    const id = some();
    const good = ctx.tok["manager@northwind.test"];
    for (const headers of [
      { authorization: "Bearer " },
      { authorization: "Bearer not-a-jwt" },
      { authorization: `Bearer ${good.slice(0, -4)}AAAA` },
      { authorization: `Basic ${good}` },
      { authorization: good },
    ]) {
      expect((await api(`/api/leases/${id}`, { headers })).status, JSON.stringify(headers).slice(0, 40)).toBe(401);
    }
  });

  it("accepts a valid Bearer token", async () => {
    expect((await lease(ctx, some())).status).toBe(200);
  });

  it("accepts a valid Supabase SSR session cookie", async () => {
    const cookie = await sessionCookie("manager@northwind.test");
    expect((await api(`/api/leases/${some()}`, { cookie })).status).toBe(200);
    expect((await api(`/api/leases/${some()}`, { cookie: await sessionCookie("ben@northwind.test") })).status).toBe(404); // other tenant
  });

  it("a garbage session cookie is 401", async () => {
    expect((await api(`/api/leases/${some()}`, { cookie: "sb-127-auth-token=base64-not-json" })).status).toBe(401);
  });

  it("an invalid Bearer header never falls back to a valid cookie", async () => {
    const cookie = await sessionCookie("manager@northwind.test");
    expect((await api(`/api/leases/${some()}`, { cookie, headers: { authorization: "Bearer nope" } })).status).toBe(401);
  });

  it("cookie-authenticated writes need a same-origin Origin header (CSRF); Bearer writes do not", async () => {
    const lid = await newLease(ctx);
    const cookie = await sessionCookie("staff@northwind.test");
    const body = { amountSen: 1000, method: "cash", receivedAt: "2026-05-05T10:00:00+08:00" };
    expect((await api(`/api/leases/${lid.id}/payments`, { cookie, body })).status).toBe(403);
    expect((await api(`/api/leases/${lid.id}/payments`, { cookie, body, headers: { origin: "http://evil.example" } })).status).toBe(403);
    expect((await api(`/api/leases/${lid.id}/payments`, { cookie, body, headers: { origin: "http://localhost:3300" } })).status).toBe(201);
  });

  it("roles are resolved from the database, not from the token: user_metadata cannot make a tenant a manager", async () => {
    const user = ctx.userId["aisyah@northwind.test"];
    const admin = { apikey: process.env.SUPABASE_SECRET_KEY!, authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY!}`, "content-type": "application/json" };
    const put = (meta: object) => fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/admin/users/${user}`, { method: "PUT", headers: admin, body: JSON.stringify({ user_metadata: meta }) });
    try {
      await put({ role: "manager", org_id: ctx.nw });
      const { signIn } = await import("../db/helpers");
      const token = await signIn("aisyah@northwind.test");
      const r = await api("/api/leases", { token, body: { unitId: ctx.unit["D-03-2"], tenantId: ctx.tenant["ben@northwind.test"], startDate: "2099-01-01", endDate: "2099-02-01", monthlyRentSen: 1, depositSen: 0 } });
      expect(r.status).toBe(403);
      expect((await api(`/api/reports/collections?from=2026-01&to=2026-03`, { token })).status).toBe(403);
    } finally {
      await put({ full_name: "Aisyah Rahman" });
    }
  });
});

describe("POST /api/leases", () => {
  const payload = (year: number, over: Record<string, unknown> = {}) => ({
    unitId: ctx.unit["D-03-2"],
    tenantId: ctx.tenant["ben@northwind.test"],
    startDate: `${year}-01-31`,
    endDate: `${year}-07-15`,
    monthlyRentSen: 150000,
    depositSen: 300000,
    ...over,
  });

  it("a manager creates a lease with ALL its invoices from generateSchedule() in one go", async () => {
    const year = freshYear();
    const body = payload(year);
    const r = await api("/api/leases", { token: ctx.tok["manager@northwind.test"], body });
    expect(r.status).toBe(201);
    expect(Object.keys(r.data)).toEqual(["id"]);
    ctx.created.leases.push(r.data.id);

    const expected = generateSchedule({ startDate: body.startDate, endDate: body.endDate, monthlyRentSen: 150000, depositSen: 300000 });
    const rows = (await ctx.db.query("select kind, period_index, period_start::text, period_end::text, due_date::text, amount_sen::text from invoices where lease_id = $1 order by due_date, kind, period_index", [r.data.id])).rows;
    expect(rows).toHaveLength(expected.length);
    expect(rows.map((x) => [x.kind, x.period_index, x.period_start, x.period_end, x.due_date, Number(x.amount_sen)])).toEqual(
      expected.map((e) => [e.kind, e.periodIndex, e.periodStart, e.periodEnd, e.dueDate, e.amountSen]),
    );
    const lease = (await ctx.db.query("select org_id, monthly_rent_sen::text, deposit_sen::text from leases where id = $1", [r.data.id])).rows[0];
    expect(lease.org_id).toBe(ctx.nw);
    expect(Number(lease.deposit_sen)).toBe(300000);

    const audit = (await ctx.db.query("select actor_id, action, org_id from audit_log where entity_id = $1", [r.data.id])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "lease.created", org_id: ctx.nw });
  });

  it("only managers: staff and tenants get 403, anonymous gets 401", async () => {
    const body = payload(freshYear());
    expect((await api("/api/leases", { token: ctx.tok["staff@northwind.test"], body })).status).toBe(403);
    expect((await api("/api/leases", { token: ctx.tok["aisyah@northwind.test"], body })).status).toBe(403);
    expect((await api("/api/leases", { body })).status).toBe(401);
    expect((await ctx.db.query("select count(*)::int n from leases where start_date = $1", [body.startDate])).rows[0].n).toBe(0);
  });

  it("validation errors are 400 and nothing is written", async () => {
    const y = freshYear();
    const mk = (over: Record<string, unknown>) => api("/api/leases", { token: ctx.tok["manager@northwind.test"], body: payload(y, over) });
    const bad: Record<string, unknown>[] = [
      { startDate: "2026-02-30" }, { startDate: "2026-13-01" }, { startDate: "20260101" }, { startDate: "" }, { endDate: "nope" },
      { startDate: `${y}-05-01`, endDate: `${y}-04-30` },
      { monthlyRentSen: 0 }, { monthlyRentSen: -1 }, { monthlyRentSen: 1.5 }, { monthlyRentSen: "100" }, { monthlyRentSen: null },
      { depositSen: -1 }, { depositSen: 0.5 }, { depositSen: "0" },
      { unitId: "not-a-uuid" }, { tenantId: 123 }, { unitId: undefined }, { tenantId: undefined }, { startDate: undefined },
    ];
    for (const over of bad) expect((await mk(over)).status, JSON.stringify(over)).toBe(400);
    expect((await api("/api/leases", { token: ctx.tok["manager@northwind.test"], rawBody: "{not json", headers: { "content-type": "application/json" } })).status).toBe(400);
    expect((await api("/api/leases", { token: ctx.tok["manager@northwind.test"], rawBody: "[]", headers: { "content-type": "application/json" } })).status).toBe(400);
    expect((await ctx.db.query("select count(*)::int n from leases where start_date >= $1 and start_date < $2", [`${y}-01-01`, `${y + 1}-01-01`])).rows[0].n).toBe(0);
  });

  it("accepts a zero deposit (no deposit invoice) and a one-day lease", async () => {
    const y = freshYear();
    const r = await api("/api/leases", { token: ctx.tok["manager@northwind.test"], body: payload(y, { startDate: `${y}-04-01`, endDate: `${y}-04-01`, depositSen: 0, monthlyRentSen: 300000 }) });
    expect(r.status).toBe(201);
    ctx.created.leases.push(r.data.id);
    const inv = (await ctx.db.query("select kind, amount_sen::text from invoices where lease_id = $1", [r.data.id])).rows;
    expect(inv).toEqual([{ kind: "rent", amount_sen: "10000" }]);
  });

  it("unit or tenant outside the manager's organization (or missing) is 404", async () => {
    const y = freshYear();
    const nwMgr = ctx.tok["manager@northwind.test"];
    const betaMgr = ctx.tok["manager@beta.test"];
    expect((await api("/api/leases", { token: betaMgr, body: payload(y) })).status).toBe(404); // Northwind unit + tenant, Beta manager
    expect((await api("/api/leases", { token: nwMgr, body: payload(y, { unitId: ctx.unit["KL-1"] }) })).status).toBe(404); // Beta unit
    expect((await api("/api/leases", { token: nwMgr, body: payload(y, { tenantId: ctx.tenant["chen@beta.test"] }) })).status).toBe(404); // Beta tenant
    expect((await api("/api/leases", { token: nwMgr, body: payload(y, { unitId: rid() }) })).status).toBe(404);
    expect((await api("/api/leases", { token: nwMgr, body: payload(y, { tenantId: rid() }) })).status).toBe(404);
    expect((await api("/api/leases", { token: betaMgr, body: { ...payload(y), unitId: ctx.unit["KL-1"], tenantId: ctx.tenant["ben@northwind.test"] } })).status).toBe(404);
  });

  it("a client-supplied organization id is ignored", async () => {
    const y = freshYear();
    const r = await api("/api/leases", { token: ctx.tok["manager@northwind.test"], body: { ...payload(y), orgId: ctx.beta, org_id: ctx.beta } });
    expect(r.status).toBe(201);
    ctx.created.leases.push(r.data.id);
    expect((await ctx.db.query("select org_id from leases where id = $1", [r.data.id])).rows[0].org_id).toBe(ctx.nw);
  });

  it("overlapping leases are 409 with inclusive dates; adjacent leases are fine", async () => {
    const y = freshYear();
    const mgr = ctx.tok["manager@northwind.test"];
    const first = await api("/api/leases", { token: mgr, body: payload(y, { startDate: `${y}-03-01`, endDate: `${y}-03-31`, depositSen: 0 }) });
    expect(first.status).toBe(201);
    ctx.created.leases.push(first.data.id);
    const mk = (s: string, e: string) => api("/api/leases", { token: mgr, body: payload(y, { startDate: s, endDate: e, depositSen: 0 }) });
    expect((await mk(`${y}-03-01`, `${y}-03-31`)).status).toBe(409); // identical
    expect((await mk(`${y}-03-31`, `${y}-04-30`)).status).toBe(409); // shares the last day (inclusive)
    expect((await mk(`${y}-02-01`, `${y}-03-01`)).status).toBe(409); // shares the first day
    expect((await mk(`${y}-03-10`, `${y}-03-12`)).status).toBe(409); // inside
    expect((await mk(`${y}-01-01`, `${y}-12-31`)).status).toBe(409); // surrounds
    const before = await mk(`${y}-02-01`, `${y}-02-28`);
    const after = await mk(`${y}-04-01`, `${y}-04-30`);
    expect(before.status).toBe(201);
    expect(after.status).toBe(201);
    ctx.created.leases.push(before.data.id, after.data.id);
    // a 409 leaves no partial lease/invoice rows behind
    expect((await ctx.db.query("select count(*)::int n from leases where unit_id = $1 and start_date >= $2 and start_date <= $3", [ctx.unit["D-03-2"], `${y}-01-01`, `${y}-12-31`])).rows[0].n).toBe(3);
  });

  it("the seeded leases of other tenants/units also block overlaps (409)", async () => {
    const r = await api("/api/leases", { token: ctx.tok["manager@northwind.test"], body: { unitId: ctx.unit["A-12-3"], tenantId: ctx.tenant["ben@northwind.test"], startDate: "2026-07-15", endDate: "2026-12-31", monthlyRentSen: 100, depositSen: 0 } });
    expect(r.status).toBe(409);
  });

  it("concurrent overlapping requests: exactly one wins (database exclusion constraint)", async () => {
    const y = freshYear();
    const mgr = ctx.tok["manager@northwind.test"];
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => api("/api/leases", { token: mgr, body: payload(y, { startDate: `${y}-0${1 + (i % 3)}-01`, endDate: `${y}-06-30`, depositSen: 0 }) })),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(7);
    for (const r of results) if (r.status === 201) ctx.created.leases.push(r.data.id);
    expect((await ctx.db.query("select count(*)::int n from leases where unit_id = $1 and start_date >= $2 and start_date <= $3", [ctx.unit["D-03-2"], `${y}-01-01`, `${y}-12-31`])).rows[0].n).toBe(1);
  });
});

describe("GET /api/leases/:id", () => {
  const seeded = () => ctx.leaseOf["aisyah@northwind.test"];

  it("returns the exact contract for the seeded lease (shape, ordering, paidSen, status, formats)", async () => {
    const r = await lease(ctx, seeded());
    expect(r.status).toBe(200);
    expect(Object.keys(r.data).sort()).toEqual(["invoices", "lease", "payments"]);
    expect(r.data.lease).toEqual({
      id: seeded(),
      unitId: ctx.unit["A-12-3"],
      tenantId: ctx.tenant["aisyah@northwind.test"],
      startDate: "2026-01-31",
      endDate: "2026-07-15",
      monthlyRentSen: 150000,
      depositSen: 300000,
    });
    const inv = r.data.invoices as Record<string, unknown>[];
    expect(inv.map((i) => [i.kind, i.periodIndex, i.periodStart, i.periodEnd, i.dueDate, i.amountSen, i.paidSen])).toEqual([
      ["deposit", null, null, null, "2026-01-31", 300000, 300000],
      ["rent", 0, "2026-01-31", "2026-02-27", "2026-01-31", 150000, 150000],
      ["rent", 1, "2026-02-28", "2026-03-30", "2026-02-28", 150000, 50000],
      ["rent", 2, "2026-03-31", "2026-04-29", "2026-03-31", 150000, 0],
      ["rent", 3, "2026-04-30", "2026-05-30", "2026-04-30", 150000, 0],
      ["rent", 4, "2026-05-31", "2026-06-29", "2026-05-31", 150000, 0],
      ["rent", 5, "2026-06-30", "2026-07-15", "2026-06-30", 77419, 0],
    ]);
    for (const i of inv) {
      expect(Object.keys(i).sort()).toEqual(["amountSen", "dueDate", "id", "kind", "paidSen", "periodEnd", "periodIndex", "periodStart", "status"]);
      expect(i.status).toBe(invoiceStatus({ dueDate: i.dueDate as string, amountSen: i.amountSen as number, paidSen: i.paidSen as number }, new Date()));
    }
    expect(inv[0].status).toBe("paid");
    expect(inv[1].status).toBe("paid");
    const pays = r.data.payments as Record<string, unknown>[];
    expect(pays.map((p) => [p.amountSen, p.unappliedSen, p.method, p.status, p.receivedAt])).toEqual([
      [300000, 0, "cash", "approved", "2026-01-31T02:00:00.000Z"],
      [200000, 0, "bank_transfer", "approved", "2026-02-28T16:30:00.000Z"],
    ]);
    for (const p of pays) expect(Object.keys(p).sort()).toEqual(["amountSen", "id", "method", "receivedAt", "status", "unappliedSen"]);
  });

  it("staff, managers of the organization and the lease's own tenant can read it", async () => {
    for (const who of ["manager@northwind.test", "staff@northwind.test", "aisyah@northwind.test"] as const) expect((await lease(ctx, seeded(), who)).status, who).toBe(200);
  });

  it("everyone else gets 404: other tenants, other organizations, unknown ids", async () => {
    for (const who of ["ben@northwind.test", "probe@northwind.test", "manager@beta.test", "chen@beta.test"] as const) {
      const r = await lease(ctx, seeded(), who);
      expect(r.status, who).toBe(404);
      expect(r.text).not.toContain("2026-01-31");
    }
    expect((await lease(ctx, rid())).status).toBe(404);
    expect((await lease(ctx, "not-a-uuid")).status).toBe(404);
    expect((await lease(ctx, "x' or '1'='1")).status).toBe(404);
  });

  it("a tenant sees only their own lease; the Beta manager sees only Beta", async () => {
    expect((await lease(ctx, ctx.leaseOf["chen@beta.test"], "chen@beta.test")).status).toBe(200);
    expect((await lease(ctx, ctx.leaseOf["chen@beta.test"], "manager@northwind.test")).status).toBe(404);
    expect((await lease(ctx, ctx.leaseOf["ben@northwind.test"], "aisyah@northwind.test")).status).toBe(404);
  });

  it("invoice status uses invoiceStatus(): unpaid, partially_paid, paid and overdue are all reachable", async () => {
    const l = await newLease(ctx, { rent: 100000, deposit: 0 });
    let r = await lease(ctx, l.id);
    expect(r.data.invoices.map((i: { status: string }) => i.status)).toEqual(["unpaid", "unpaid", "unpaid"]);
    expect((await api(`/api/leases/${l.id}/payments`, { token: ctx.tok["manager@northwind.test"], body: { amountSen: 150000, method: "cash", receivedAt: "2026-05-05T10:00:00+08:00" } })).status).toBe(201);
    r = await lease(ctx, l.id);
    expect(r.data.invoices.map((i: { status: string; paidSen: number }) => [i.paidSen, i.status])).toEqual([[100000, "paid"], [50000, "partially_paid"], [0, "unpaid"]]);
    // a past-due lease: the seeded Ben lease (2026-01..04) has unpaid invoices that are overdue by now
    const ben = await lease(ctx, ctx.leaseOf["ben@northwind.test"]);
    expect(ben.data.invoices.some((i: { status: string }) => i.status === "overdue")).toBe(true);
  });
});

describe("GET /api/leases/options (Create Lease form choices)", () => {
  type Options = { organizations: { id: string; name: string; units: { id: string; name: string; leases: { startDate: string; endDate: string }[] }[]; tenants: { id: string; email: string }[] }[] };

  it("a manager gets the units and tenants of their own organization only", async () => {
    const r = await api("/api/leases/options", { token: ctx.tok["manager@northwind.test"] });
    expect(r.status).toBe(200);
    const data = r.data as Options;
    expect(data.organizations.map((o) => o.id)).toEqual([ctx.nw]);
    const units = data.organizations[0].units;
    expect(units.map((u) => u.name)).toEqual(expect.arrayContaining(["A-12-3", "B-05-1", "C-01-7", "D-03-2"]));
    expect(units.some((u) => u.name === "KL-1")).toBe(false); // Beta's unit
    expect(data.organizations[0].tenants.map((t) => t.email)).toEqual(expect.arrayContaining(["aisyah@northwind.test", "ben@northwind.test"]));
    expect(data.organizations[0].tenants.some((t) => t.email === "chen@beta.test")).toBe(false);
    expect(units.find((u) => u.name === "A-12-3")!.leases).toEqual([{ startDate: "2026-01-31", endDate: "2026-07-15" }]); // leased ranges are shown, dates only
    expect(r.text).not.toMatch(/userId|user_id|password|phone/i);
  });

  it("the other organization's manager sees only their own organization", async () => {
    const r = await api("/api/leases/options", { token: ctx.tok["manager@beta.test"] });
    expect(r.status).toBe(200);
    const data = r.data as Options;
    expect(data.organizations.map((o) => o.id)).toEqual([ctx.beta]);
    expect(data.organizations[0].units.map((u) => u.name)).toEqual(["KL-1"]);
    expect(data.organizations[0].tenants.map((t) => t.email)).toEqual(["chen@beta.test"]);
  });

  it("staff and tenants get 403, anonymous gets 401", async () => {
    expect((await api("/api/leases/options", { token: ctx.tok["staff@northwind.test"] })).status).toBe(403);
    expect((await api("/api/leases/options", { token: ctx.tok["aisyah@northwind.test"] })).status).toBe(403);
    expect((await api("/api/leases/options")).status).toBe(401);
  });
});
