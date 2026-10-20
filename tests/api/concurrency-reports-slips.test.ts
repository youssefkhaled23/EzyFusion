import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PNG, type Ctx, api, freshYear, newLease, pay, rid, setup, teardown, uploadSlip } from "./helpers";
import { storage } from "../db/helpers";

let ctx: Ctx;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => {
  await teardown(ctx);
});

const MGR = "manager@northwind.test" as const;
const STAFF = "staff@northwind.test" as const;
const act = (action: "approve" | "reject" | "void", id: string, body: unknown = { reason: "valid reason" }) => api(`/api/payments/${id}/${action}`, { token: ctx.tok[MGR], body });
const count = async (sql: string, params: unknown[]) => Number((await ctx.db.query(sql, params)).rows[0].n);

describe("concurrency (per-lease row lock in PostgreSQL)", () => {
  it("concurrent STAFF payments cannot jointly exceed the cap", async () => {
    const l = await newLease(ctx); // 300000
    const results = await Promise.all(Array.from({ length: 10 }, () => pay(ctx, l.id, STAFF, 100000)));
    const codes = results.map((r) => r.status);
    expect(codes.filter((c) => c === 201)).toHaveLength(3);
    expect(codes.filter((c) => c === 422)).toHaveLength(7);
    expect(await count("select coalesce(sum(amount_sen), 0)::bigint n from payments where lease_id = $1 and status = 'pending_verification'", [l.id])).toBe(300000);
  });

  it("concurrent MANAGER payments are allocated without over-allocating any invoice", async () => {
    const l = await newLease(ctx);
    const results = await Promise.all(Array.from({ length: 10 }, () => pay(ctx, l.id, MGR, 100000)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    expect(results.filter((r) => r.status === 422)).toHaveLength(7);
    expect(await count("select coalesce(sum(a.amount_sen), 0)::bigint n from payment_allocations a join payments p on p.id = a.payment_id where p.lease_id = $1", [l.id])).toBe(300000);
    expect(await count("select count(*)::int n from invoices i where i.lease_id = $1 and (select coalesce(sum(amount_sen), 0) from payment_allocations where invoice_id = i.id) > i.amount_sen", [l.id])).toBe(0);
    expect(await count("select count(*)::int n from payments where lease_id = $1 and status = 'approved'", [l.id])).toBe(3);
  });

  it("a mix of staff and manager payments still respects one shared cap", async () => {
    const l = await newLease(ctx);
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => pay(ctx, l.id, i % 2 ? STAFF : MGR, 100000)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    expect(results.filter((r) => r.status === 422)).toHaveLength(9);
    const total = await count("select coalesce(sum(amount_sen), 0)::bigint n from payments where lease_id = $1 and status in ('approved', 'pending_verification')", [l.id]);
    expect(total).toBe(300000);
  });

  it("concurrent approval of the same payment allocates exactly once", async () => {
    const l = await newLease(ctx);
    const p = (await pay(ctx, l.id, STAFF, 250000)).data.id;
    const results = await Promise.all(Array.from({ length: 10 }, () => act("approve", p)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(9);
    expect(await count("select count(*)::int n from payment_allocations where payment_id = $1", [p])).toBe(3);
    expect(await count("select coalesce(sum(amount_sen), 0)::bigint n from payment_allocations where payment_id = $1", [p])).toBe(250000);
  });

  it("concurrent approve and reject of one payment: exactly one transition wins and the data is consistent", async () => {
    const l = await newLease(ctx);
    const p = (await pay(ctx, l.id, STAFF, 100000)).data.id;
    const results = await Promise.all([act("approve", p), act("reject", p), act("approve", p), act("reject", p)]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
    const row = (await ctx.db.query("select status from payments where id = $1", [p])).rows[0];
    const allocated = await count("select coalesce(sum(amount_sen), 0)::bigint n from payment_allocations where payment_id = $1", [p]);
    expect(allocated).toBe(row.status === "approved" ? 100000 : 0);
  });

  it("concurrent approve and void of the same payment never leaves allocations behind a voided payment", async () => {
    const l = await newLease(ctx);
    const p = (await pay(ctx, l.id, STAFF, 100000)).data.id;
    await Promise.all([act("approve", p), act("void", p), act("approve", p), act("void", p)]);
    const row = (await ctx.db.query("select status from payments where id = $1", [p])).rows[0];
    const allocated = await count("select coalesce(sum(amount_sen), 0)::bigint n from payment_allocations where payment_id = $1", [p]);
    expect(["approved", "pending_verification", "voided"]).toContain(row.status);
    expect(allocated).toBe(row.status === "approved" ? 100000 : 0);
  });

  it("concurrent payments and voids on one lease keep the books exact", async () => {
    const l = await newLease(ctx);
    const first = (await pay(ctx, l.id, MGR, 100000)).data.id;
    await Promise.all([act("void", first), ...Array.from({ length: 6 }, () => pay(ctx, l.id, MGR, 100000))]);
    const allocated = await count("select coalesce(sum(a.amount_sen), 0)::bigint n from payment_allocations a join payments p on p.id = a.payment_id where p.lease_id = $1", [l.id]);
    const approved = await count("select coalesce(sum(amount_sen), 0)::bigint n from payments where lease_id = $1 and status = 'approved'", [l.id]);
    expect(allocated).toBe(approved);
    expect(allocated).toBeLessThanOrEqual(300000);
    expect(await count("select count(*)::int n from invoices i where i.lease_id = $1 and (select coalesce(sum(amount_sen), 0) from payment_allocations where invoice_id = i.id) > i.amount_sen", [l.id])).toBe(0);
  });

  it("different leases do not block each other and keep independent caps", async () => {
    const a = await newLease(ctx);
    const b = await newLease(ctx);
    const results = await Promise.all([...Array.from({ length: 5 }, () => pay(ctx, a.id, MGR, 100000)), ...Array.from({ length: 5 }, () => pay(ctx, b.id, MGR, 100000))]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(6);
    expect(await count("select count(*)::int n from payments where lease_id = $1 and status = 'approved'", [a.id])).toBe(3);
    expect(await count("select count(*)::int n from payments where lease_id = $1 and status = 'approved'", [b.id])).toBe(3);
  });
});

describe("GET /api/reports/collections", () => {
  const report = (from: string, to: string, who: string | null = "manager@northwind.test") =>
    api(`/api/reports/collections?from=${from}&to=${to}`, { token: who ? (ctx.tok as Record<string, string>)[who] : undefined });

  it("matches the exact Northwind Jan-Mar 2026 example (Malaysia month boundaries: the 00:30 MYT transfer is March)", async () => {
    const r = await report("2026-01", "2026-03");
    expect(r.status).toBe(200);
    expect(r.data).toEqual([
      { month: "2026-01", collectedSen: 300000 },
      { month: "2026-02", collectedSen: 0 },
      { month: "2026-03", collectedSen: 200000 },
    ]);
    expect((await report("2026-01", "2026-03", "staff@northwind.test")).data).toEqual(r.data);
  });

  it("returns one entry per month including empty months, across year boundaries", async () => {
    const r = await report("2025-11", "2026-02");
    expect(r.data).toEqual([
      { month: "2025-11", collectedSen: 0 },
      { month: "2025-12", collectedSen: 0 },
      { month: "2026-01", collectedSen: 300000 },
      { month: "2026-02", collectedSen: 0 },
    ]);
    expect((await report("2026-01", "2026-12")).data).toHaveLength(12);
    expect((await report("2026-03", "2026-03")).data).toEqual([{ month: "2026-03", collectedSen: 200000 }]);
  });

  it("is scoped to the caller's organization (Beta sees none of Northwind's money)", async () => {
    expect((await report("2026-01", "2026-03", "manager@beta.test")).data).toEqual([
      { month: "2026-01", collectedSen: 0 },
      { month: "2026-02", collectedSen: 0 },
      { month: "2026-03", collectedSen: 0 },
    ]);
  });

  it("staff and managers only: tenants 403, anonymous 401", async () => {
    expect((await report("2026-01", "2026-03", "aisyah@northwind.test")).status).toBe(403);
    expect((await report("2026-01", "2026-03", "chen@beta.test")).status).toBe(403);
    expect((await report("2026-01", "2026-03", null)).status).toBe(401);
  });

  it("rejects invalid ranges and formats with 400", async () => {
    for (const [from, to] of [["2026-03", "2026-01"], ["2026-13", "2026-14"], ["2026-1", "2026-03"], ["2026-01-01", "2026-03-01"], ["abc", "2026-03"], ["", ""], ["2026-00", "2026-02"], ["1900-01", "2100-01"], ["2026-01", "2026-3"]]) {
      expect((await report(from, to)).status, `${from}..${to}`).toBe(400);
    }
    expect((await api("/api/reports/collections", { token: ctx.tok[MGR] })).status).toBe(400);
    expect((await api("/api/reports/collections?from=2026-01", { token: ctx.tok[MGR] })).status).toBe(400);
  });

  it("uses Asia/Kuala_Lumpur month boundaries and counts only approved payments", async () => {
    const y = freshYear();
    const l = await newLease(ctx, { rent: 1000000, deposit: 0, year: y }); // plenty of balance
    const at = (iso: string, who: "manager@northwind.test" | "staff@northwind.test" = MGR) => pay(ctx, l.id, who, 10000, { receivedAt: iso });
    // 23:59:59 MYT on Mar 31 and 00:00:00 MYT on Apr 1 sit one second apart; both are 15:59:59Z / 16:00:00Z on Mar 31 in UTC
    expect((await at(`${y}-03-31T23:59:59+08:00`)).status).toBe(201); // March (MYT) although it is still March 31 in UTC too
    expect((await at(`${y}-03-31T16:00:00Z`)).status).toBe(201); // = Apr 1 00:00 MYT -> APRIL, although the UTC month is March
    expect((await at(`${y}-04-30T16:00:00Z`)).status).toBe(201); // = May 1 00:00 MYT -> MAY
    expect((await at(`${y}-03-01T00:00:00+08:00`)).status).toBe(201); // = Feb 28/29 16:00Z -> MARCH although UTC says February
    expect((await at(`${y}-03-20T10:00:00+08:00`, STAFF)).status).toBe(201); // pending: must not count
    const voided = (await at(`${y}-03-15T10:00:00+08:00`)).data.id;
    expect((await act("void", voided)).status).toBe(200); // voided: must not count
    const pad = String(y).padStart(4, "0");
    const r = await report(`${pad}-02`, `${pad}-05`);
    expect(r.data).toEqual([
      { month: `${pad}-02`, collectedSen: 0 },
      { month: `${pad}-03`, collectedSen: 20000 },
      { month: `${pad}-04`, collectedSen: 10000 },
      { month: `${pad}-05`, collectedSen: 10000 },
    ]);
  });
});

describe("bank transfer slips", () => {
  const slipName = (org: string) => `${org}/test-${rid()}.png`;
  const fake = async (path: string, metadata: Record<string, unknown>) => {
    await ctx.db.query("insert into storage.objects (bucket_id, name, metadata) values ('payment-slips', $1, $2)", [path, JSON.stringify(metadata)]);
    ctx.created.slips.push(path);
  };
  const objectExists = async (path: string) => (await count("select count(*)::int n from storage.objects where bucket_id = 'payment-slips' and name = $1", [path])) === 1;
  const record = (leaseId: string, who: "manager@northwind.test" | "staff@northwind.test", slipPath: unknown, amountSen = 1000) =>
    pay(ctx, leaseId, who, amountSen, { method: "bank_transfer", slipPath });

  it("accepts a real uploaded PNG under the organization's prefix and stores the path", async () => {
    const l = await newLease(ctx);
    const path = slipName(ctx.nw);
    expect((await uploadSlip(ctx.tok[STAFF], path, ctx)).status).toBe(200);
    const r = await record(l.id, STAFF, path);
    expect(r.status).toBe(201);
    expect((await ctx.db.query("select slip_path from payments where id = $1", [r.data.id])).rows[0].slip_path).toBe(path);
  });

  it("accepts PDF and JPEG metadata up to exactly 5 MB", async () => {
    const l = await newLease(ctx);
    const pdf = slipName(ctx.nw).replace(".png", ".pdf");
    const jpg = slipName(ctx.nw).replace(".png", ".jpg");
    await fake(pdf, { size: 5 * 1024 * 1024, mimetype: "application/pdf" });
    await fake(jpg, { size: 1234, mimetype: "image/jpeg" });
    expect((await record(l.id, MGR, pdf)).status).toBe(201);
    expect((await record(l.id, MGR, jpg)).status).toBe(201);
  });

  it("rejects missing, oversized, non-image and wrong-organization slips with 400", async () => {
    const l = await newLease(ctx);
    const big = slipName(ctx.nw);
    const text = slipName(ctx.nw);
    const other = slipName(ctx.beta);
    await fake(big, { size: 5 * 1024 * 1024 + 1, mimetype: "image/png" });
    await fake(text, { size: 10, mimetype: "text/plain" });
    await fake(other, { size: 10, mimetype: "image/png" });
    for (const [label, path] of [["missing", slipName(ctx.nw)], ["oversized", big], ["text/plain", text], ["other organization", other], ["no prefix", `x-${rid()}.png`], ["traversal", `${ctx.nw}/../${ctx.beta}/a.png`], ["double slash", `${ctx.nw}//a.png`], ["empty file name", `${ctx.nw}/`], ["backslash", `${ctx.nw}\\a.png`], ["wrong org id case", `${ctx.nw.toUpperCase()}/a.png`], ["empty", ""]] as const) {
      expect((await record(l.id, MGR, path)).status, label).toBe(400);
    }
    expect(await count("select count(*)::int n from payments where lease_id = $1", [l.id])).toBe(0);
    expect(await objectExists(big)).toBe(true); // validation failures never delete anything
    expect(await objectExists(other)).toBe(true);
  });

  it("rejects a slip already attached to another payment (409) and never deletes it", async () => {
    const l = await newLease(ctx);
    const path = slipName(ctx.nw);
    await uploadSlip(ctx.tok[STAFF], path, ctx);
    expect((await record(l.id, STAFF, path)).status).toBe(201);
    const again = await record(l.id, STAFF, path);
    expect(again.status).toBe(409);
    expect(await objectExists(path)).toBe(true);
    // the seeded slip of Aisyah's transfer is referenced too: an over-cap attempt with it must not remove it
    const seeded = (await ctx.db.query("select slip_path from payments where slip_path is not null and lease_id = $1", [ctx.leaseOf["aisyah@northwind.test"]])).rows[0].slip_path;
    const over = await record(l.id, MGR, seeded, 10_000_000);
    expect([409, 422]).toContain(over.status);
    expect(await objectExists(seeded)).toBe(true);
  });

  it("cleans up an uploaded slip when recording fails (422), but only if no payment references it", async () => {
    const l = await newLease(ctx);
    const path = slipName(ctx.nw);
    await uploadSlip(ctx.tok[STAFF], path, ctx);
    expect(await objectExists(path)).toBe(true);
    const r = await record(l.id, STAFF, path, 999_999_999);
    expect(r.status).toBe(422);
    expect(await objectExists(path)).toBe(false); // orphan removed
    expect(await count("select count(*)::int n from payments where slip_path = $1", [path])).toBe(0);
  });

  it("cleanup never reaches into another organization's folder", async () => {
    const l = await newLease(ctx);
    const betaObject = slipName(ctx.beta);
    await uploadSlip(undefined, betaObject, ctx, { secret: true });
    const r = await record(l.id, MGR, betaObject, 999_999_999);
    expect(r.status).toBe(400);
    expect(await objectExists(betaObject)).toBe(true);
  });

  it("a slip is only for bank transfers", async () => {
    const l = await newLease(ctx);
    const path = slipName(ctx.nw);
    await uploadSlip(ctx.tok[STAFF], path, ctx);
    expect((await pay(ctx, l.id, MGR, 1000, { method: "cash", slipPath: path })).status).toBe(400);
    expect(await objectExists(path)).toBe(true);
  });

  it("slips of seeded payments stay unreadable for tenants (Storage RLS still applies)", async () => {
    const seeded = (await ctx.db.query("select slip_path from payments where slip_path is not null limit 1")).rows[0].slip_path;
    const r = await storage(`object/authenticated/payment-slips/${seeded}`, { token: ctx.tok["aisyah@northwind.test"] });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect((await storage(`object/authenticated/payment-slips/${seeded}`, { token: ctx.tok[STAFF] })).buf.equals(PNG)).toBe(true);
  });
});
