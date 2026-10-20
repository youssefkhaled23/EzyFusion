import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TABLES, ownerClient, pgError, rest, rolledBack, signIn } from "./helpers";

let c: pg.Client;
let nw: string;
let beta: string;
let managerToken: string;
let anyAuditId: string;
const one = async <T = Record<string, string>>(sql: string, params: unknown[] = []) => ((await c.query(sql, params)).rows[0] ?? {}) as T;

beforeAll(async () => {
  c = await ownerClient();
  const orgs = (await c.query("select id, name from organizations")).rows as { id: string; name: string }[];
  nw = orgs.find((o) => o.name === "Northwind Properties")!.id;
  beta = orgs.find((o) => o.name === "Beta Realty")!.id;
  anyAuditId = (await one<{ id: string }>("select id from audit_log where org_id = $1 limit 1", [nw])).id;
  managerToken = await signIn("manager@northwind.test");
});
afterAll(async () => {
  await c?.end();
});

describe("audit_log is append-only for everyone", () => {
  it("the database owner cannot UPDATE, DELETE or TRUNCATE", async () => {
    await rolledBack(c, async () => {
      for (const sql of ["update audit_log set action = 'tampered'", "delete from audit_log", "truncate audit_log", "truncate audit_log cascade", "update audit_log set org_id = org_id"]) {
        const e = await pgError(c, sql);
        expect(e.message, sql).toMatch(/append-only/);
      }
    });
    expect((await one<{ n: string }>("select count(*)::int n from audit_log where action = 'tampered'")).n).toBe(0);
  });

  it("the service role cannot UPDATE, DELETE or TRUNCATE (database role)", async () => {
    await rolledBack(c, async () => {
      await c.query("set local role service_role");
      for (const sql of ["update audit_log set action = 'tampered'", "delete from audit_log", "truncate audit_log"]) {
        const e = await pgError(c, sql);
        expect(e.code, sql).toBe("42501"); // privilege revoked and/or trigger
      }
    });
  });

  it("the service role cannot UPDATE or DELETE through the Data API either", async () => {
    const patch = await rest(`audit_log?id=eq.${anyAuditId}`, { secret: true, method: "PATCH", body: { action: "tampered" } });
    expect(patch.status).toBeGreaterThanOrEqual(400);
    const del = await rest(`audit_log?id=eq.${anyAuditId}`, { secret: true, method: "DELETE" });
    expect(del.status).toBeGreaterThanOrEqual(400);
    expect((await one<{ action: string }>("select action from audit_log where id = $1", [anyAuditId])).action).not.toBe("tampered");
  });

  it("an authenticated manager cannot UPDATE or DELETE through the Data API", async () => {
    expect((await rest(`audit_log?id=eq.${anyAuditId}`, { token: managerToken, method: "PATCH", body: { action: "x" } })).status).toBe(403);
    expect((await rest(`audit_log?id=eq.${anyAuditId}`, { token: managerToken, method: "DELETE" })).status).toBe(403);
    expect((await rest("audit_log", { token: managerToken, method: "POST", body: { org_id: nw, action: "forged" } })).status).toBe(403);
  });

  it("appending is still possible, and the new row is immediately immutable", async () => {
    await rolledBack(c, async () => {
      const id = randomUUID();
      await c.query("insert into audit_log (id, org_id, actor_id, action, details) values ($1, $2, $3, 'test.append', '{\"ok\":true}')", [id, nw, randomUUID()]);
      expect((await one<{ n: number }>("select count(*)::int n from audit_log where id = $1", [id])).n).toBe(1);
      expect((await pgError(c, "update audit_log set action = 'x' where id = $1", [id])).message).toMatch(/append-only/);
      expect((await pgError(c, "delete from audit_log where id = $1", [id])).message).toMatch(/append-only/);
    });
  });

  it("deleting a user or organization cannot erase audit history", async () => {
    await rolledBack(c, async () => {
      const e = await pgError(c, "delete from organizations where id = $1", [nw]);
      expect(e.code).toBe("23503"); // restricted by foreign keys; nothing cascades into audit_log
    });
    expect((await one<{ n: number }>("select count(*)::int n from audit_log where org_id = $1", [nw])).n).toBeGreaterThan(0);
  });
});

describe("schema shape and column types", () => {
  const spec: Record<string, string[]> = {
    organizations: ["id", "name"],
    memberships: ["user_id", "org_id", "role"],
    units: ["id", "org_id", "name"],
    tenants: ["id", "org_id", "user_id", "full_name", "email", "phone"],
    leases: ["id", "org_id", "unit_id", "tenant_id", "start_date", "end_date", "monthly_rent_sen", "deposit_sen"],
    invoices: ["id", "org_id", "lease_id", "kind", "period_index", "period_start", "period_end", "due_date", "amount_sen"],
    payments: ["id", "org_id", "lease_id", "amount_sen", "unapplied_sen", "method", "status", "received_at", "slip_path", "gateway_bill_id"],
    payment_allocations: ["id", "org_id", "payment_id", "invoice_id", "amount_sen"],
    gateway_bills: ["id", "org_id", "lease_id", "amount_sen", "status"],
    audit_log: ["id", "org_id", "actor_id", "action", "entity_id", "details", "created_at"],
  };

  it("has exactly the ten required tables with exactly the required columns", async () => {
    const r = (await c.query("select table_name, column_name from information_schema.columns where table_schema = 'public'")).rows as { table_name: string; column_name: string }[];
    expect([...new Set(r.map((x) => x.table_name))].sort()).toEqual(Object.keys(spec).sort());
    for (const [table, columns] of Object.entries(spec)) {
      expect(r.filter((x) => x.table_name === table).map((x) => x.column_name).sort(), table).toEqual([...columns].sort());
    }
  });

  it("money is bigint, calendar dates are date, instants are timestamptz", async () => {
    const r = (await c.query("select table_name, column_name, data_type from information_schema.columns where table_schema = 'public'")).rows as { table_name: string; column_name: string; data_type: string }[];
    for (const col of r) {
      if (col.column_name.endsWith("_sen")) expect(col.data_type, `${col.table_name}.${col.column_name}`).toBe("bigint");
      if (/_date$/.test(col.column_name) || ["period_start", "period_end"].includes(col.column_name)) expect(col.data_type, `${col.table_name}.${col.column_name}`).toBe("date");
      if (["received_at", "created_at"].includes(col.column_name)) expect(col.data_type, `${col.table_name}.${col.column_name}`).toBe("timestamp with time zone");
    }
  });

  it("every org-owned child table has a composite (id, org_id) foreign key to its parent", async () => {
    const fks = (await c.query(
      `select c.conrelid::regclass::text as tbl, c.confrelid::regclass::text as parent, array_agg(a.attname::text order by k.ord) as cols
       from pg_constraint c join lateral unnest(c.conkey) with ordinality k(attnum, ord) on true
       join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
       where c.contype = 'f' and c.connamespace = 'public'::regnamespace group by c.oid, c.conrelid, c.confrelid`,
    )).rows as { tbl: string; parent: string; cols: string[] }[];
    const composite = (tbl: string, parent: string, col: string) => fks.some((f) => f.tbl === tbl && f.parent === parent && f.cols.join() === `${col},org_id`);
    expect(composite("leases", "units", "unit_id")).toBe(true);
    expect(composite("leases", "tenants", "tenant_id")).toBe(true);
    expect(composite("invoices", "leases", "lease_id")).toBe(true);
    expect(composite("payments", "leases", "lease_id")).toBe(true);
    expect(composite("payments", "gateway_bills", "gateway_bill_id")).toBe(true);
    expect(composite("gateway_bills", "leases", "lease_id")).toBe(true);
    expect(composite("payment_allocations", "payments", "payment_id")).toBe(true);
    expect(composite("payment_allocations", "invoices", "invoice_id")).toBe(true);
    for (const t of TABLES.filter((t) => !["organizations", "memberships"].includes(t))) {
      expect(fks.some((f) => f.tbl === t && f.parent === "organizations" && f.cols.join() === "org_id"), `${t}.org_id -> organizations`).toBe(true);
    }
  });
});

describe("constraints reject bad data (every statement runs in a rolled-back transaction)", () => {
  const leaseOf = async (email: string) => (await one<{ id: string }>("select l.id from leases l join tenants t on t.id = l.tenant_id where t.email = $1", [email])).id;
  const failing = async (sql: string, params: unknown[], code: string) => {
    await rolledBack(c, async () => {
      expect((await pgError(c, sql, params)).code, sql).toBe(code);
    });
  };

  it("cross-organization relationships are impossible", async () => {
    const betaUnit = (await one<{ id: string }>("select id from units where org_id = $1 limit 1", [beta])).id;
    const nwTenant = (await one<{ id: string }>("select t.id from tenants t where t.email = 'ben@northwind.test'")).id;
    const betaTenant = (await one<{ id: string }>("select id from tenants where org_id = $1 limit 1", [beta])).id;
    const nwUnit = (await one<{ id: string }>("select id from units where name = 'D-03-2'")).id;
    // a Northwind lease pointing at a Beta unit / Beta tenant
    await failing("insert into leases (org_id, unit_id, tenant_id, start_date, end_date, monthly_rent_sen) values ($1, $2, $3, '2030-01-01', '2030-12-31', 100)", [nw, betaUnit, nwTenant], "23503");
    await failing("insert into leases (org_id, unit_id, tenant_id, start_date, end_date, monthly_rent_sen) values ($1, $2, $3, '2030-01-01', '2030-12-31', 100)", [nw, nwUnit, betaTenant], "23503");
    // an invoice / payment / bill for a Northwind lease claiming the Beta organization
    const aisyahLease = await leaseOf("aisyah@northwind.test");
    await failing("insert into invoices (org_id, lease_id, kind, period_index, period_start, period_end, due_date, amount_sen) values ($1, $2, 'rent', 99, '2031-01-01', '2031-01-31', '2031-01-01', 1)", [beta, aisyahLease], "23503");
    await failing("insert into payments (org_id, lease_id, amount_sen, unapplied_sen, method, status, received_at) values ($1, $2, 1, 0, 'cash', 'pending_verification', now())", [beta, aisyahLease], "23503");
    await failing("insert into gateway_bills (org_id, lease_id, amount_sen, status) values ($1, $2, 1, 'pending')", [beta, aisyahLease], "23503");
    // an allocation joining a Northwind payment to a Beta invoice
    const nwPayment = (await one<{ id: string }>("select id from payments limit 1")).id;
    const betaInvoice = (await one<{ id: string }>("select id from invoices where org_id = $1 limit 1", [beta])).id;
    await failing("insert into payment_allocations (org_id, payment_id, invoice_id, amount_sen) values ($1, $2, $3, 1)", [nw, nwPayment, betaInvoice], "23503");
    await failing("insert into payment_allocations (org_id, payment_id, invoice_id, amount_sen) values ($1, $2, $3, 1)", [beta, nwPayment, betaInvoice], "23503");
    // a membership / tenant / unit for a missing organization
    await failing("insert into units (org_id, name) values ($1, 'ghost')", [randomUUID()], "23503");
  });

  it("a payment can reference only a gateway bill of its own organization", async () => {
    await rolledBack(c, async () => {
      const betaLease = await leaseOf("chen@beta.test");
      const billId = randomUUID();
      await c.query("insert into gateway_bills (id, org_id, lease_id, amount_sen, status) values ($1, $2, $3, 10, 'pending')", [billId, beta, betaLease]);
      const e = await pgError(
        c,
        "insert into payments (org_id, lease_id, amount_sen, unapplied_sen, method, status, received_at, gateway_bill_id) values ($1, $2, 10, 0, 'online', 'pending_verification', now(), $3)",
        [nw, await leaseOf("aisyah@northwind.test"), billId],
      );
      expect(e.code).toBe("23503");
    });
  });

  it("money and date CHECK constraints", async () => {
    const lease = await leaseOf("aisyah@northwind.test");
    const nwUnit = (await one<{ id: string }>("select id from units where name = 'D-03-2'")).id;
    const tenant = (await one<{ id: string }>("select id from tenants where email = 'probe@northwind.test'")).id;
    const insLease = (rent: number, dep: number, s: string, e: string) => [`insert into leases (org_id, unit_id, tenant_id, start_date, end_date, monthly_rent_sen, deposit_sen) values ($1, $2, $3, $4, $5, $6, $7)`, [nw, nwUnit, tenant, s, e, rent, dep]] as const;
    for (const [sql, params] of [insLease(0, 0, "2030-01-01", "2030-12-31"), insLease(-5, 0, "2030-01-01", "2030-12-31"), insLease(100, -1, "2030-01-01", "2030-12-31"), insLease(100, 0, "2030-12-31", "2030-01-01")]) await failing(sql, [...params], "23514");
    await failing("insert into invoices (org_id, lease_id, kind, due_date, amount_sen) values ($1, $2, 'deposit', '2030-01-01', -1)", [nw, lease], "23514");
    await failing("insert into payments (org_id, lease_id, amount_sen, unapplied_sen, method, status, received_at) values ($1, $2, 0, 0, 'cash', 'pending_verification', now())", [nw, lease], "23514");
    await failing("insert into payments (org_id, lease_id, amount_sen, unapplied_sen, method, status, received_at) values ($1, $2, 100, 101, 'online', 'pending_verification', now())", [nw, lease], "23514");
    await failing("insert into payments (org_id, lease_id, amount_sen, unapplied_sen, method, status, received_at) values ($1, $2, 100, -1, 'online', 'pending_verification', now())", [nw, lease], "23514");
    await failing("insert into gateway_bills (org_id, lease_id, amount_sen, status) values ($1, $2, 0, 'pending')", [nw, lease], "23514");
    const pay = (await one<{ id: string }>("select id from payments limit 1")).id;
    const inv = (await one<{ id: string }>("select id from invoices where lease_id = $1 and period_index = 1", [lease])).id;
    await failing("insert into payment_allocations (org_id, payment_id, invoice_id, amount_sen) values ($1, $2, $3, 0)", [nw, pay, inv], "23514");
  });

  it("enumerations, invoice shape and slip path CHECK constraints", async () => {
    const lease = await leaseOf("aisyah@northwind.test");
    await failing("insert into invoices (org_id, lease_id, kind, due_date, amount_sen) values ($1, $2, 'fee', '2030-01-01', 1)", [nw, lease], "23514");
    await failing("insert into invoices (org_id, lease_id, kind, period_index, period_start, period_end, due_date, amount_sen) values ($1, $2, 'deposit', 0, '2030-01-01', '2030-01-31', '2030-01-01', 1)", [nw, lease], "23514");
    await failing("insert into invoices (org_id, lease_id, kind, due_date, amount_sen) values ($1, $2, 'rent', '2030-01-01', 1)", [nw, lease], "23514");
    await failing("insert into invoices (org_id, lease_id, kind, period_index, period_start, period_end, due_date, amount_sen) values ($1, $2, 'rent', 50, '2030-02-01', '2030-01-01', '2030-02-01', 1)", [nw, lease], "23514");
    await failing("insert into payments (org_id, lease_id, amount_sen, unapplied_sen, method, status, received_at) values ($1, $2, 1, 1, 'crypto', 'pending_verification', now())", [nw, lease], "23514");
    await failing("insert into payments (org_id, lease_id, amount_sen, unapplied_sen, method, status, received_at) values ($1, $2, 1, 0, 'cash', 'settled', now())", [nw, lease], "23514");
    await failing("insert into payments (org_id, lease_id, amount_sen, unapplied_sen, method, status, received_at, slip_path) values ($1, $2, 1, 0, 'cash', 'pending_verification', now(), $3)", [nw, lease, `${beta}/slip.png`], "23514");
    await failing("insert into memberships (user_id, org_id, role) values ($1, $2, 'tenant')", [randomUUID(), nw], "23514");
    await failing("insert into gateway_bills (org_id, lease_id, amount_sen, status) values ($1, $2, 1, 'refunded')", [nw, lease], "23514");
  });

  it("unique constraints: one deposit and one rent invoice per period, no double leasing of a unit", async () => {
    const lease = await leaseOf("aisyah@northwind.test");
    await failing("insert into invoices (org_id, lease_id, kind, due_date, amount_sen) values ($1, $2, 'deposit', '2030-01-01', 1)", [nw, lease], "23505");
    await failing("insert into invoices (org_id, lease_id, kind, period_index, period_start, period_end, due_date, amount_sen) values ($1, $2, 'rent', 0, '2030-01-01', '2030-01-31', '2030-01-01', 1)", [nw, lease], "23505");
    await failing("insert into tenants (org_id, full_name, email) values ($1, 'Dup', 'ben@northwind.test')", [nw], "23505");
    const aisyahUnit = (await one<{ id: string }>("select unit_id as id from leases where id = $1", [lease])).id;
    const tenant = (await one<{ id: string }>("select id from tenants where email = 'probe@northwind.test'")).id;
    // overlapping with Aisyah's 2026-01-31..2026-07-15 lease on A-12-3
    await failing("insert into leases (org_id, unit_id, tenant_id, start_date, end_date, monthly_rent_sen) values ($1, $2, $3, '2026-07-15', '2026-12-31', 100)", [nw, aisyahUnit, tenant], "23P01");
    // the day after the lease ends is allowed (positive control)
    await rolledBack(c, async () => {
      await c.query("insert into leases (org_id, unit_id, tenant_id, start_date, end_date, monthly_rent_sen) values ($1, $2, $3, '2026-07-16', '2026-12-31', 100)", [nw, aisyahUnit, tenant]);
    });
    // one allocation per (payment, invoice)
    await rolledBack(c, async () => {
      const pay = (await one<{ id: string }>("select id from payments where method = 'cash' limit 1")).id;
      const inv = (await one<{ id: string }>("select id from invoices where lease_id = $1 and period_index = 4", [lease])).id;
      await c.query("insert into payment_allocations (org_id, payment_id, invoice_id, amount_sen) values ($1, $2, $3, 1)", [nw, pay, inv]);
      expect((await pgError(c, "insert into payment_allocations (org_id, payment_id, invoice_id, amount_sen) values ($1, $2, $3, 1)", [nw, pay, inv])).code).toBe("23505");
    });
  });

  it("seeded invoices equal generateSchedule() output for the worked example lease", async () => {
    const r = (await c.query(
      "select kind, period_index, period_start::text, period_end::text, due_date::text, amount_sen::text from invoices i join leases l on l.id = i.lease_id join tenants t on t.id = l.tenant_id where t.email = 'aisyah@northwind.test' order by period_index nulls first",
    )).rows;
    expect(r.map((x) => [x.kind, x.period_index, x.period_start, x.period_end, x.due_date, x.amount_sen])).toEqual([
      ["deposit", null, null, null, "2026-01-31", "300000"],
      ["rent", 0, "2026-01-31", "2026-02-27", "2026-01-31", "150000"],
      ["rent", 1, "2026-02-28", "2026-03-30", "2026-02-28", "150000"],
      ["rent", 2, "2026-03-31", "2026-04-29", "2026-03-31", "150000"],
      ["rent", 3, "2026-04-30", "2026-05-30", "2026-04-30", "150000"],
      ["rent", 4, "2026-05-31", "2026-06-29", "2026-05-31", "150000"],
      ["rent", 5, "2026-06-30", "2026-07-15", "2026-06-30", "77419"],
    ]);
  });
});

describe("exact payment and gateway-bill values (forward migration 20261020000500)", () => {
  const insertPayment = (method: string, status: string, unapplied = 0, lease?: string) =>
    c.query("insert into payments (org_id, lease_id, amount_sen, unapplied_sen, method, status, received_at) values ($1, $2, 100, $3, $4, $5, now())", [nw, lease, unapplied, method, status]);
  const aisyah = async () => (await one<{ id: string }>("select l.id from leases l join tenants t on t.id = l.tenant_id where t.email = 'aisyah@northwind.test'")).id;

  it("accepts exactly cash | bank_transfer | online and pending_verification | approved | rejected | voided", async () => {
    const lease = await aisyah();
    await rolledBack(c, async () => {
      for (const method of ["cash", "bank_transfer", "online"]) for (const status of ["pending_verification", "approved", "rejected", "voided"]) await insertPayment(method, status, 0, lease);
    });
    for (const [method, status] of [["gateway", "approved"], ["card", "approved"], ["cash", "pending"], ["cash", "settled"], ["cash", "void"], ["Cash", "approved"]]) {
      await rolledBack(c, async () => {
        const e = await pgError(c, "insert into payments (org_id, lease_id, amount_sen, unapplied_sen, method, status, received_at) values ($1, $2, 100, 0, $3, $4, now())", [nw, lease, method, status]);
        expect(e.code, `${method}/${status}`).toBe("23514");
      });
    }
  });

  it("gateway bills accept exactly pending | paid | failed", async () => {
    const lease = await aisyah();
    await rolledBack(c, async () => {
      for (const status of ["pending", "paid", "failed"]) await c.query("insert into gateway_bills (org_id, lease_id, amount_sen, status) values ($1, $2, 100, $3)", [nw, lease, status]);
    });
    for (const status of ["expired", "refunded", "PAID", ""]) {
      await rolledBack(c, async () => {
        expect((await pgError(c, "insert into gateway_bills (org_id, lease_id, amount_sen, status) values ($1, $2, 100, $3)", [nw, lease, status])).code, status).toBe("23514");
      });
    }
  });

  it("only online payments may carry unapplied funds; manual payments may not", async () => {
    const lease = await aisyah();
    await rolledBack(c, async () => {
      await insertPayment("online", "approved", 50, lease);
      for (const method of ["cash", "bank_transfer"]) expect((await pgError(c, "insert into payments (org_id, lease_id, amount_sen, unapplied_sen, method, status, received_at) values ($1, $2, 100, 1, $3, 'approved', now())", [nw, lease, method])).code, method).toBe("23514");
    });
  });

  it("a slip object can back at most one payment", async () => {
    const lease = await aisyah();
    const existing = (await one<{ slip_path: string }>("select slip_path from payments where slip_path is not null limit 1")).slip_path;
    await rolledBack(c, async () => {
      const e = await pgError(c, "insert into payments (org_id, lease_id, amount_sen, unapplied_sen, method, status, received_at, slip_path) values ($1, $2, 1, 0, 'bank_transfer', 'pending_verification', now(), $3)", [nw, lease, existing]);
      expect(e.code).toBe("23505");
    });
  });

  it("the seeded payments are approved and were allocated by the domain (no unapplied funds)", async () => {
    const r = (await c.query("select method, status, amount_sen::text, unapplied_sen::text, (select coalesce(sum(amount_sen), 0)::text from payment_allocations where payment_id = p.id) allocated from payments p order by received_at")).rows;
    expect(r).toEqual([
      { method: "cash", status: "approved", amount_sen: "300000", unapplied_sen: "0", allocated: "300000" },
      { method: "bank_transfer", status: "approved", amount_sen: "200000", unapplied_sen: "0", allocated: "200000" },
    ]);
  });
});

