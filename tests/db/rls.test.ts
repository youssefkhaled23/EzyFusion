import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TABLES, ownerClient, rest, rows, signIn, type Table } from "./helpers";

// Real seeded Supabase Auth tokens, direct PostgREST requests. Requires: supabase start, db reset, npm run seed.

let owner: pg.Client;
const tokens: Record<string, string> = {};
const ids = {} as {
  nw: string;
  beta: string;
  tenant: Record<string, string>;
  lease: Record<string, string>;
};
const fixtures: { bills: string[]; allocations: string[]; payments: string[] } = { bills: [], allocations: [], payments: [] };

const ACCOUNTS = ["manager@northwind.test", "staff@northwind.test", "aisyah@northwind.test", "ben@northwind.test", "probe@northwind.test", "manager@beta.test", "chen@beta.test"];

const q = async <T = Record<string, string>>(sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows as T[];
const idsOf = (list: Record<string, unknown>[], key = "id") => list.map((r) => String(r[key])).sort();
const sorted = (list: string[]) => [...list].sort();

beforeAll(async () => {
  owner = await ownerClient();
  for (const email of ACCOUNTS) tokens[email] = await signIn(email);

  const orgs = await q<{ id: string; name: string }>("select id, name from organizations");
  ids.nw = orgs.find((o) => o.name === "Northwind Properties")!.id;
  ids.beta = orgs.find((o) => o.name === "Beta Realty")!.id;
  ids.tenant = Object.fromEntries((await q<{ email: string; id: string }>("select email, id from tenants")).map((t) => [t.email, t.id]));
  ids.lease = Object.fromEntries((await q<{ email: string; id: string }>("select t.email, l.id from leases l join tenants t on t.id = l.tenant_id")).map((t) => [t.email, t.id]));

  // Fixtures for tables the seed leaves empty (gateway bills, allocations) so their policies are really exercised.
  const bill = async (org: string, lease: string) => {
    const id = randomUUID();
    await owner.query("insert into gateway_bills (id, org_id, lease_id, amount_sen, status) values ($1, $2, $3, 5000, 'pending')", [id, org, lease]);
    fixtures.bills.push(id);
  };
  await bill(ids.nw, ids.lease["aisyah@northwind.test"]);
  await bill(ids.nw, ids.lease["ben@northwind.test"]);
  await bill(ids.beta, ids.lease["chen@beta.test"]);

  const benPayment = randomUUID();
  await owner.query(
    "insert into payments (id, org_id, lease_id, amount_sen, unapplied_sen, method, status, received_at) values ($1, $2, $3, 100000, 0, 'cash', 'approved', now())",
    [benPayment, ids.nw, ids.lease["ben@northwind.test"]],
  );
  fixtures.payments.push(benPayment);
  const alloc = async (org: string, payment: string, invoice: string, amount: number) => {
    const id = randomUUID();
    await owner.query("insert into payment_allocations (id, org_id, payment_id, invoice_id, amount_sen) values ($1, $2, $3, $4, $5)", [id, org, payment, invoice, amount]);
    fixtures.allocations.push(id);
  };
    const aisyahTransfer = (await q<{ id: string }>("select id from payments where lease_id = $1 and method = 'bank_transfer'", [ids.lease["aisyah@northwind.test"]]))[0].id;
  const aisyahRent2 = (await q<{ id: string }>("select id from invoices where lease_id = $1 and period_index = 2", [ids.lease["aisyah@northwind.test"]]))[0].id;
  const benInvoice = (await q<{ id: string }>("select id from invoices where lease_id = $1 and period_index = 0", [ids.lease["ben@northwind.test"]]))[0].id;
  await alloc(ids.nw, aisyahTransfer, aisyahRent2, 1000); // an extra fixture allocation on top of the seeded ones
  await alloc(ids.nw, benPayment, benInvoice, 1000);
});

afterAll(async () => {
  if (!owner) return;
  await owner.query("delete from payment_allocations where id = any($1)", [fixtures.allocations]);
  await owner.query("delete from payments where id = any($1)", [fixtures.payments]);
  await owner.query("delete from gateway_bills where id = any($1)", [fixtures.bills]);
  await owner.end();
});

// memberships has no id column (composite primary key user_id + org_id)
const keyCol = (table: Table) => (table === "memberships" ? "user_id" : "id");
const sampleRow = (table: Table, org: string) => (table === "memberships" ? { user_id: randomUUID(), org_id: org, role: "staff" } : { id: randomUUID() });

describe("anonymous access: no table is readable or writable", () => {
  it.each(TABLES)("anon cannot SELECT %s", async (table) => {
    const r = await rest(`${table}?select=*`);
    expect(r.status).toBe(401);
    expect(r.data.code).toBe("42501");
  });

  it.each(TABLES)("anon cannot INSERT/UPDATE/DELETE %s", async (table) => {
    for (const [method, body, path] of [
      ["POST", sampleRow(table, randomUUID()), table],
      ["PATCH", sampleRow(table, randomUUID()), `${table}?${keyCol(table)}=eq.${randomUUID()}`],
      ["DELETE", undefined, `${table}?${keyCol(table)}=eq.${randomUUID()}`],
    ] as const) {
      const r = await rest(path, { method, body });
      expect([401, 403], `${method} ${table}`).toContain(r.status);
    }
  });
});

describe("reads are scoped by role and organization", () => {
  const expectedIds = async (table: Table, who: string): Promise<string[] | "none"> => {
    const nwOrg = who.endsWith("northwind.test") ? ids.nw : ids.beta;
    const isStaff = who.startsWith("manager@") || who.startsWith("staff@");
    const isManager = who.startsWith("manager@");
    if (isStaff) {
      if (table === "audit_log" && !isManager) return "none";
      if (table === "memberships") return sorted((await q<{ user_id: string }>("select user_id from memberships where org_id = $1", [nwOrg])).map((r) => r.user_id));
      return sorted((await q<{ id: string }>(`select id from ${table} where ${table === "organizations" ? "id" : "org_id"} = $1`, [nwOrg])).map((r) => r.id));
    }
    // tenant
    const tenantId = ids.tenant[who];
    if (table === "memberships" || table === "audit_log") return "none";
    const lease = `(select id from leases where tenant_id = '${tenantId}')`;
    const sql: Record<string, string> = {
      organizations: `select id from organizations where id = '${nwOrg}'`,
      units: `select unit_id as id from leases where tenant_id = '${tenantId}'`,
      tenants: `select id from tenants where id = '${tenantId}'`,
      leases: `select id from leases where tenant_id = '${tenantId}'`,
      invoices: `select id from invoices where lease_id in ${lease}`,
      payments: `select id from payments where lease_id in ${lease}`,
      gateway_bills: `select id from gateway_bills where lease_id in ${lease}`,
      payment_allocations: `select a.id from payment_allocations a join payments p on p.id = a.payment_id where p.lease_id in ${lease}`,
    };
    return sorted((await q<{ id: string }>(sql[table])).map((r) => r.id));
  };

  const rowKey = (table: Table) => (table === "memberships" ? "user_id" : "id");

  for (const who of ACCOUNTS) {
    it(`${who} sees exactly the rows its role and organization allow`, async () => {
      for (const table of TABLES) {
        const actual = idsOf(await rows(tokens[who], table), rowKey(table));
        const expected = await expectedIds(table, who);
        expect(actual, `${who} -> ${table}`).toEqual(expected === "none" ? [] : expected);
      }
    });
  }

  it("spot checks with absolute numbers (seed + fixtures)", async () => {
    const aisyah = tokens["aisyah@northwind.test"];
    expect((await rows(aisyah, "organizations")).map((r) => r.name)).toEqual(["Northwind Properties"]);
    expect((await rows(aisyah, "units")).map((r) => r.name)).toEqual(["A-12-3"]);
    expect(await rows(aisyah, "tenants", "select=full_name")).toEqual([{ full_name: "Aisyah Rahman" }]);
    expect(await rows(aisyah, "leases")).toHaveLength(1);
    expect(await rows(aisyah, "invoices")).toHaveLength(7); // 1 deposit + 6 rent
    expect(await rows(aisyah, "payments")).toHaveLength(2);
    expect(await rows(aisyah, "payment_allocations")).toHaveLength(4); // 3 seeded (deposit, rent 0, rent 1) + 1 fixture
    expect(await rows(aisyah, "gateway_bills")).toHaveLength(1);
    expect(await rows(aisyah, "memberships")).toEqual([]);
    expect(await rows(aisyah, "audit_log")).toEqual([]);

    expect((await rows(tokens["staff@northwind.test"], "units")).map((r) => r.name).sort()).toEqual(["A-12-3", "B-05-1", "C-01-7", "D-03-2"]);
    expect(await rows(tokens["staff@northwind.test"], "audit_log")).toEqual([]);
    expect((await rows(tokens["manager@northwind.test"], "audit_log")).length).toBeGreaterThan(0);
    expect((await rows(tokens["manager@northwind.test"], "memberships")).map((r) => r.role).sort()).toEqual(["manager", "staff"]);
  });

  it("cross-organization: nobody can read the other organization's rows by id", async () => {
    const otherOrg = { nw: ids.beta, beta: ids.nw };
    for (const [who, org] of [
      ["manager@northwind.test", "nw"],
      ["staff@northwind.test", "nw"],
      ["aisyah@northwind.test", "nw"],
      ["manager@beta.test", "beta"],
      ["chen@beta.test", "beta"],
    ] as const) {
      for (const table of TABLES) {
        const col = table === "organizations" ? "id" : "org_id";
        const foreign = await rows(tokens[who], table, `select=*&${col}=eq.${otherOrg[org]}`);
        expect(foreign, `${who} -> ${table} of the other organization`).toEqual([]);
      }
    }
  });

  it("tenants cannot read other tenants in the same organization (by id and by filter)", async () => {
    const aisyah = tokens["aisyah@northwind.test"];
    const ben = ids.tenant["ben@northwind.test"];
    expect(await rows(aisyah, "tenants", `select=*&id=eq.${ben}`)).toEqual([]);
    expect(await rows(aisyah, "leases", `select=*&tenant_id=eq.${ben}`)).toEqual([]);
    const benInvoices = await q<{ id: string }>("select id from invoices where lease_id = $1", [ids.lease["ben@northwind.test"]]);
    expect(await rows(aisyah, "invoices", `select=*&id=in.(${benInvoices.map((i) => i.id).join(",")})`)).toEqual([]);
    expect(await rows(aisyah, "tenants", "select=*&email=like.*northwind.test")).toHaveLength(1);
  });
});

describe("writes through the Data API", () => {
  const writers = ["manager@northwind.test", "staff@northwind.test", "aisyah@northwind.test", "chen@beta.test"] as const;

  it.each(TABLES)("INSERT and DELETE are denied on %s for every authenticated role", async (table) => {
    for (const who of writers) {
      const ins = await rest(table, { token: tokens[who], method: "POST", body: sampleRow(table, ids.nw) });
      expect(ins.status, `INSERT ${table} as ${who}`).toBe(403);
      expect(ins.data.code).toBe("42501");
      const del = await rest(`${table}?${keyCol(table)}=eq.${randomUUID()}`, { token: tokens[who], method: "DELETE" });
      expect(del.status, `DELETE ${table} as ${who}`).toBe(403);
    }
  });

  it.each(TABLES.filter((t) => t !== "tenants"))("UPDATE is denied on %s for every authenticated role", async (table) => {
    for (const who of writers) {
      const col = table === "organizations" ? "name" : table === "memberships" ? "role" : "org_id";
      const r = await rest(`${table}?${table === "memberships" ? "role=eq.staff" : "id=eq." + randomUUID()}`, { token: tokens[who], method: "PATCH", body: { [col]: col === "role" ? "manager" : col === "name" ? "x" : randomUUID() } });
      expect(r.status, `UPDATE ${table} as ${who}`).toBe(403);
    }
  });

  it("a tenant can update ONLY their own phone number", async () => {
    const aisyah = tokens["aisyah@northwind.test"];
    const own = ids.tenant["aisyah@northwind.test"];
    const before = (await q<{ phone: string }>("select phone from tenants where id = $1", [own]))[0].phone;
    try {
      const ok = await rest(`tenants?id=eq.${own}`, { token: aisyah, method: "PATCH", body: { phone: "+60111222333" }, headers: { Prefer: "return=representation" } });
      expect(ok.status).toBe(200);
      expect(ok.data).toHaveLength(1);
      expect(ok.data[0].phone).toBe("+60111222333");

      // every other column is blocked by the column-level grant
      for (const body of [{ full_name: "Mallory" }, { email: "mallory@x.test" }, { org_id: ids.beta }, { user_id: randomUUID() }, { id: randomUUID() }, { phone: "+60", full_name: "Mallory" }]) {
        const r = await rest(`tenants?id=eq.${own}`, { token: aisyah, method: "PATCH", body });
        expect(r.status, JSON.stringify(body)).toBe(403);
        expect(r.data.code).toBe("42501");
      }
      expect((await q<{ full_name: string }>("select full_name from tenants where id = $1", [own]))[0].full_name).toBe("Aisyah Rahman");

      // RLS: another tenant's row is not updatable, even for the permitted column
      const ben = ids.tenant["ben@northwind.test"];
      const benBefore = (await q<{ phone: string }>("select phone from tenants where id = $1", [ben]))[0].phone;
      const other = await rest(`tenants?id=eq.${ben}`, { token: aisyah, method: "PATCH", body: { phone: "+60999999999" }, headers: { Prefer: "return=representation" } });
      expect(other.status).toBe(200);
      expect(other.data).toEqual([]);
      expect((await q<{ phone: string }>("select phone from tenants where id = $1", [ben]))[0].phone).toBe(benBefore);
      const crossOrg = await rest(`tenants?id=eq.${ids.tenant["chen@beta.test"]}`, { token: aisyah, method: "PATCH", body: { phone: "+60999999999" }, headers: { Prefer: "return=representation" } });
      expect(crossOrg.data).toEqual([]);
    } finally {
      // restore everything, so a failing assertion (or a broken grant) cannot leave the seed data altered
      await owner.query("update tenants set phone = $2, full_name = 'Aisyah Rahman', email = 'aisyah@northwind.test' where id = $1", [own, before]);
    }
  });

  it("staff and managers cannot update tenant phones either (column grant is not enough without the own-row policy)", async () => {
    for (const who of ["staff@northwind.test", "manager@northwind.test"] as const) {
      const target = ids.tenant["ben@northwind.test"];
      const before = (await q<{ phone: string }>("select phone from tenants where id = $1", [target]))[0].phone;
      const r = await rest(`tenants?id=eq.${target}`, { token: tokens[who], method: "PATCH", body: { phone: "+60888888888" }, headers: { Prefer: "return=representation" } });
      expect(r.data, who).toEqual([]);
      expect((await q<{ phone: string }>("select phone from tenants where id = $1", [target]))[0].phone).toBe(before);
    }
  });

  it("a tenant cannot assign themselves another tenant's phone-row (WITH CHECK) or hijack a row via user_id", async () => {
    const r = await rest(`tenants?id=eq.${ids.tenant["aisyah@northwind.test"]}`, { token: tokens["aisyah@northwind.test"], method: "PATCH", body: { user_id: randomUUID() } });
    expect(r.status).toBe(403);
  });
});

describe("roles come from memberships / tenants, never from user_metadata", () => {
  it("a tenant whose user_metadata claims manager still has tenant access only", async () => {
    const aisyahUser = (await q<{ user_id: string }>("select user_id from tenants where email = 'aisyah@northwind.test'"))[0].user_id;
    const adminHeaders = { apikey: process.env.SUPABASE_SECRET_KEY!, authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY!}`, "content-type": "application/json" };
    const set = (meta: object) =>
      fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/admin/users/${aisyahUser}`, { method: "PUT", headers: adminHeaders, body: JSON.stringify({ user_metadata: meta }) });
    try {
      expect((await set({ role: "manager", org_id: ids.nw, user_role: "manager", full_name: "Aisyah Rahman" })).status).toBe(200);
      const token = await signIn("aisyah@northwind.test");
      const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
      expect(payload.user_metadata.role).toBe("manager"); // the claim really is in the token...
      expect(await rows(token, "audit_log")).toEqual([]); // ...and changes nothing
      expect(await rows(token, "memberships")).toEqual([]);
      expect(await rows(token, "tenants")).toHaveLength(1);
      expect(await rows(token, "units")).toHaveLength(1);
      expect((await rows(token, "invoices")).length).toBe(7);
    } finally {
      await set({ full_name: "Aisyah Rahman" });
    }
  });
});

describe("no unsafe functions and privileges", () => {
  it("RLS is enabled on every public table", async () => {
    const r = await q<{ relname: string; relrowsecurity: boolean }>(
      "select relname, relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p')",
    );
    expect(r.map((x) => x.relname).sort()).toEqual([...TABLES].sort());
    expect(r.filter((x) => !x.relrowsecurity)).toEqual([]);
  });

  it("anon has no privilege on any public table; authenticated has only SELECT plus UPDATE(phone) on tenants", async () => {
    const anon = await q<{ table_name: string }>("select table_name from information_schema.role_table_grants where grantee = 'anon' and table_schema = 'public'");
    expect(anon).toEqual([]);
    const auth = await q<{ table_name: string; privilege_type: string }>("select table_name, privilege_type from information_schema.role_table_grants where grantee = 'authenticated' and table_schema = 'public'");
    expect(auth.every((g) => g.privilege_type === "SELECT")).toBe(true);
    expect(new Set(auth.map((g) => g.table_name))).toEqual(new Set(TABLES));
    const colGrants = await q<{ table_name: string; column_name: string; privilege_type: string }>(
      "select table_name, column_name, privilege_type from information_schema.column_privileges where grantee = 'authenticated' and table_schema = 'public' and privilege_type in ('UPDATE', 'INSERT')",
    );
    expect(colGrants).toEqual([{ table_name: "tenants", column_name: "phone", privilege_type: "UPDATE" }]);
  });

  it("there are no SECURITY DEFINER functions in the exposed (public) schema", async () => {
    const r = await q("select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosecdef");
    expect(r).toEqual([]);
  });

  it("the only SECURITY DEFINER function is private.org_role, which anon and PUBLIC cannot execute", async () => {
    const defs = await q<{ nspname: string; proname: string }>("select n.nspname, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where p.prosecdef and n.nspname in ('public', 'private')");
    expect(defs).toEqual([{ nspname: "private", proname: "org_role" }]);
    const fns = await q<{ proname: string; anon: boolean; authed: boolean }>(
      "select p.proname, has_function_privilege('anon', p.oid, 'EXECUTE') as anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') as authed from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private'",
    );
    expect(fns.length).toBeGreaterThan(0);
    expect(fns.filter((f) => f.anon)).toEqual([]);
    const pub = await q<{ proname: string }>("select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0)");
    expect(pub).toEqual([]);
  });

  it("helper functions are not callable through the Data API (RPC)", async () => {
    for (const token of [undefined, tokens["aisyah@northwind.test"], tokens["manager@northwind.test"]]) {
      const viaPublic = await rest("rpc/org_role", { token, method: "POST", body: { p_org_id: ids.nw } });
      expect([401, 403, 404]).toContain(viaPublic.status);
      const viaPrivate = await rest("rpc/org_role", { token, method: "POST", body: { p_org_id: ids.nw }, headers: { "Content-Profile": "private" } });
      expect([401, 403, 404, 406]).toContain(viaPrivate.status);
      expect(JSON.stringify(viaPrivate.data)).not.toContain("manager");
    }
  });
});
