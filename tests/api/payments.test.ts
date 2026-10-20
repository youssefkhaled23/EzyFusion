import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Ctx, api, freshYear, lease, newLease, pay, rid, setup, teardown } from "./helpers";

let ctx: Ctx;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => {
  await teardown(ctx);
});

const MGR = "manager@northwind.test" as const;
const STAFF = "staff@northwind.test" as const;
const act = (action: "approve" | "reject" | "void", id: string, who: Parameters<typeof pay>[2], body?: unknown) =>
  api(`/api/payments/${id}/${action}`, { token: ctx.tok[who], body: body ?? {} });
const allocs = async (paymentId: string) =>
  (await ctx.db.query("select i.kind, i.period_index, a.amount_sen::text amount from payment_allocations a join invoices i on i.id = a.invoice_id where a.payment_id = $1 order by i.due_date, i.kind, i.period_index", [paymentId])).rows.map((r) => [r.kind, r.period_index, Number(r.amount)]);
const paymentRow = async (id: string) => (await ctx.db.query("select status, unapplied_sen::text, amount_sen::text, slip_path from payments where id = $1", [id])).rows[0];
const sumAlloc = async (leaseId: string) => Number((await ctx.db.query("select coalesce(sum(a.amount_sen), 0)::text s from payment_allocations a join payments p on p.id = a.payment_id where p.lease_id = $1", [leaseId])).rows[0].s);

describe("recording payments", () => {
  it("manager-recorded manual payments are approved immediately and allocated (deposit first, then rent)", async () => {
    const l = await newLease(ctx, { rent: 100000, deposit: 50000 }); // total 350000
    const r = await pay(ctx, l.id, MGR, 120000);
    expect(r.status).toBe(201);
    expect(Object.keys(r.data).sort()).toEqual(["id", "status"]);
    expect(r.data.status).toBe("approved");
    expect(await allocs(r.data.id)).toEqual([["deposit", null, 50000], ["rent", 0, 70000]]);
    expect(await paymentRow(r.data.id)).toMatchObject({ status: "approved", unapplied_sen: "0" });
    const g = await lease(ctx, l.id);
    expect(g.data.invoices.map((i: { paidSen: number }) => i.paidSen)).toEqual([50000, 70000, 0, 0]);
    expect(g.data.payments[0]).toMatchObject({ amountSen: 120000, unappliedSen: 0, method: "cash", status: "approved" });
  });

  it("staff-recorded payments wait as pending_verification and allocate nothing", async () => {
    const l = await newLease(ctx);
    const r = await pay(ctx, l.id, STAFF, 100000);
    expect(r.status).toBe(201);
    expect(r.data.status).toBe("pending_verification");
    expect(await allocs(r.data.id)).toEqual([]);
    expect(await sumAlloc(l.id)).toBe(0);
    expect((await lease(ctx, l.id)).data.invoices.every((i: { paidSen: number }) => i.paidSen === 0)).toBe(true);
  });

  it("stores receivedAt as the exact instant (Malaysia offset honoured) and never produces unapplied funds", async () => {
    const l = await newLease(ctx);
    const stamp = `${l.year}-03-01T00:30:00+08:00`; // far-future year: must not leak into the seeded 2026 collections report
    const r = await pay(ctx, l.id, MGR, 10000, { receivedAt: stamp });
    const g = await lease(ctx, l.id);
    expect(g.data.payments[0].receivedAt).toBe(new Date(stamp).toISOString());
    expect(g.data.payments[0].receivedAt.endsWith("T16:30:00.000Z")).toBe(true);
    expect(g.data.payments[0].unappliedSen).toBe(0);
    expect(r.status).toBe(201);
  });

  it("cap: amount <= remainingBalance - pendingTotal (422 above it, accepted at exactly it)", async () => {
    const l = await newLease(ctx, { rent: 100000, deposit: 50000 }); // 350000
    expect((await pay(ctx, l.id, MGR, 100000)).status).toBe(201); // remaining 250000
    expect((await pay(ctx, l.id, STAFF, 100000)).status).toBe(201); // pending 100000 -> max 150000
    expect((await pay(ctx, l.id, STAFF, 150001)).status).toBe(422);
    expect((await pay(ctx, l.id, MGR, 150001)).status).toBe(422);
    const ok = await pay(ctx, l.id, STAFF, 150000);
    expect(ok.status).toBe(201);
    expect((await pay(ctx, l.id, STAFF, 1)).status).toBe(422); // pending now covers the whole remaining balance
    expect((await pay(ctx, l.id, MGR, 1)).status).toBe(422);
    expect(await sumAlloc(l.id)).toBe(100000);
  });

  it("a rejected pending payment frees its share of the cap", async () => {
    const l = await newLease(ctx);
    const p = await pay(ctx, l.id, STAFF, 300000);
    expect(p.status).toBe(201);
    expect((await pay(ctx, l.id, MGR, 1)).status).toBe(422);
    expect((await act("reject", p.data.id, MGR, { reason: "wrong amount" })).status).toBe(200);
    expect((await pay(ctx, l.id, MGR, 300000)).status).toBe(201);
  });

  it("validation errors are 400", async () => {
    const l = await newLease(ctx);
    const base = { amountSen: 1000, method: "cash", receivedAt: "2026-05-05T10:00:00+08:00" };
    const bad: Record<string, unknown>[] = [
      { amountSen: 0 }, { amountSen: -5 }, { amountSen: 1.5 }, { amountSen: "1000" }, { amountSen: null }, { amountSen: Number.MAX_SAFE_INTEGER + 2 }, { amountSen: undefined },
      { method: "online" }, { method: "card" }, { method: "" }, { method: undefined },
      { receivedAt: "2026-05-05" }, { receivedAt: "2026-05-05T10:00:00" }, { receivedAt: "yesterday" }, { receivedAt: 1717000000 }, { receivedAt: "2026-13-05T10:00:00Z" }, { receivedAt: undefined },
      { slipPath: 42 }, { method: "cash", slipPath: `${ctx.nw}/x.png` },
      { method: "bank_transfer" }, // a bank transfer needs a slip
    ];
    for (const over of bad) expect((await api(`/api/leases/${l.id}/payments`, { token: ctx.tok[MGR], body: { ...base, ...over } })).status, JSON.stringify(over)).toBe(400);
    expect((await api(`/api/leases/${l.id}/payments`, { token: ctx.tok[MGR], rawBody: "{oops", headers: { "content-type": "application/json" } })).status).toBe(400);
    expect((await ctx.db.query("select count(*)::int n from payments where lease_id = $1", [l.id])).rows[0].n).toBe(0);
  });

  it("access: tenants 403 on their own lease; other tenants and other organizations 404; anonymous 401", async () => {
    const seeded = ctx.leaseOf["aisyah@northwind.test"];
    const body = { amountSen: 1, method: "cash", receivedAt: "2026-05-05T10:00:00+08:00" };
    expect((await api(`/api/leases/${seeded}/payments`, { token: ctx.tok["aisyah@northwind.test"], body })).status).toBe(403);
    expect((await api(`/api/leases/${seeded}/payments`, { token: ctx.tok["ben@northwind.test"], body })).status).toBe(404);
    expect((await api(`/api/leases/${seeded}/payments`, { token: ctx.tok["manager@beta.test"], body })).status).toBe(404);
    expect((await api(`/api/leases/${seeded}/payments`, { body })).status).toBe(401);
    expect((await api(`/api/leases/${rid()}/payments`, { token: ctx.tok[MGR], body })).status).toBe(404);
    expect((await api(`/api/leases/${seeded}/payments`, { token: ctx.tok["aisyah@northwind.test"], body: { nonsense: true } })).status).toBe(403); // 403 wins over 400
    expect((await ctx.db.query("select count(*)::int n from payments where lease_id = $1", [seeded])).rows[0].n).toBe(2);
  });

  it("client-supplied org/status/unapplied/allocation fields are ignored", async () => {
    const l = await newLease(ctx);
    const r = await pay(ctx, l.id, STAFF, 1000, { orgId: ctx.beta, status: "approved", unappliedSen: 999, id: rid(), allocations: [{ invoiceId: rid(), amountSen: 5 }] });
    expect(r.status).toBe(201);
    expect(r.data.status).toBe("pending_verification");
    expect((await ctx.db.query("select org_id, unapplied_sen::text from payments where id = $1", [r.data.id])).rows[0]).toEqual({ org_id: ctx.nw, unapplied_sen: "0" });
  });
});

describe("approve / reject / void", () => {
  it("approve: managers only; staff 403; tenants 403; other org 404; unknown 404; anonymous 401", async () => {
    const l = await newLease(ctx);
    const p = (await pay(ctx, l.id, STAFF, 100000)).data.id;
    expect((await act("approve", p, STAFF)).status).toBe(403);
    expect((await act("approve", p, "ben@northwind.test")).status).toBe(403); // Ben is the lease's tenant: the payment is visible to him
    expect((await act("approve", p, "aisyah@northwind.test")).status).toBe(404); // another tenant cannot even see it
    expect((await act("approve", p, "manager@beta.test")).status).toBe(404);
    expect((await act("approve", rid(), MGR)).status).toBe(404);
    expect((await act("approve", "not-a-uuid", MGR)).status).toBe(404);
    expect((await api(`/api/payments/${p}/approve`, { body: {} })).status).toBe(401);
    expect((await paymentRow(p)).status).toBe("pending_verification");
  });

  it("approve allocates in order, exactly once; a second approval is 409", async () => {
    const l = await newLease(ctx, { rent: 100000, deposit: 50000 });
    const p = (await pay(ctx, l.id, STAFF, 200000)).data.id;
    const r = await act("approve", p, MGR);
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ status: "approved" });
    expect(await allocs(p)).toEqual([["deposit", null, 50000], ["rent", 0, 100000], ["rent", 1, 50000]]);
    expect(await paymentRow(p)).toMatchObject({ status: "approved", unapplied_sen: "0" });
    expect((await act("approve", p, MGR)).status).toBe(409);
    expect(await sumAlloc(l.id)).toBe(200000);
  });

  it("approval re-checks against the remaining balance (422) when other funds were applied meanwhile", async () => {
    const l = await newLease(ctx); // total 300000
    const p = (await pay(ctx, l.id, STAFF, 100000)).data.id; // pending 100000
    // 250000 arrives through another channel (an approved online payment) and takes most of the balance
    const online = rid();
    await ctx.db.query("insert into payments (id, org_id, lease_id, amount_sen, unapplied_sen, method, status, received_at) values ($1, $2, $3, 250000, 0, 'online', 'approved', now())", [online, ctx.nw, l.id]);
    const invs = (await ctx.db.query("select id, amount_sen from invoices where lease_id = $1 order by due_date", [l.id])).rows;
    await ctx.db.query("insert into payment_allocations (org_id, payment_id, invoice_id, amount_sen) values ($1, $2, $3, 100000), ($1, $2, $4, 100000), ($1, $2, $5, 50000)", [ctx.nw, online, invs[0].id, invs[1].id, invs[2].id]);
    expect((await act("approve", p, MGR)).status).toBe(422);
    expect((await paymentRow(p)).status).toBe("pending_verification");
    expect(await allocs(p)).toEqual([]);
  });

  it("reject: reason of at least 5 characters, managers only, pending payments only", async () => {
    const l = await newLease(ctx);
    const p = (await pay(ctx, l.id, STAFF, 100000)).data.id;
    expect((await act("reject", p, STAFF, { reason: "valid reason" })).status).toBe(403);
    expect((await act("reject", p, "manager@beta.test", { reason: "valid reason" })).status).toBe(404);
    for (const body of [{}, { reason: "" }, { reason: "four" }, { reason: "     " }, { reason: 12345 }, { reason: null }]) expect((await act("reject", p, MGR, body)).status, JSON.stringify(body)).toBe(400);
    expect((await api(`/api/payments/${p}/reject`, { token: ctx.tok[MGR], rawBody: "garbage", headers: { "content-type": "application/json" } })).status).toBe(400);
    const ok = await act("reject", p, MGR, { reason: "slip is unreadable" });
    expect(ok.status).toBe(200);
    expect(ok.data).toEqual({ status: "rejected" });
    expect(await allocs(p)).toEqual([]);
    expect((await act("reject", p, MGR, { reason: "again please" })).status).toBe(409);
    expect((await act("approve", p, MGR)).status).toBe(409);
    expect((await act("void", p, MGR, { reason: "not approved yet" })).status).toBe(409);
    const audit = (await ctx.db.query("select details from audit_log where entity_id = $1 and action = 'payment.rejected'", [p])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].details.reason).toBe("slip is unreadable");
  });

  it("reject cannot touch an approved payment", async () => {
    const l = await newLease(ctx);
    const p = (await pay(ctx, l.id, MGR, 100000)).data.id;
    expect((await act("reject", p, MGR, { reason: "too late now" })).status).toBe(409);
    expect((await paymentRow(p)).status).toBe("approved");
  });

  it("void: only approved payments, reason required, managers only", async () => {
    const l = await newLease(ctx);
    const pending = (await pay(ctx, l.id, STAFF, 50000)).data.id;
    const approved = (await pay(ctx, l.id, MGR, 100000)).data.id;
    expect((await act("void", pending, MGR, { reason: "valid reason" })).status).toBe(409); // pending cannot be voided
    expect((await act("void", approved, STAFF, { reason: "valid reason" })).status).toBe(403);
    expect((await act("void", approved, "manager@beta.test", { reason: "valid reason" })).status).toBe(404);
    for (const body of [{}, { reason: "abcd" }, { reason: " abc " }]) expect((await act("void", approved, MGR, body)).status, JSON.stringify(body)).toBe(400);
    expect((await paymentRow(approved)).status).toBe("approved");
  });

  it("void removes ONLY that payment's allocations, keeps the payment row, and does not reallocate other payments", async () => {
    const l = await newLease(ctx, { rent: 100000, deposit: 0 });
    const a = (await pay(ctx, l.id, MGR, 100000)).data.id; // fills rent 0
    const b = (await pay(ctx, l.id, MGR, 150000)).data.id; // rent 1 (full) + 50000 of rent 2
    expect(await allocs(a)).toEqual([["rent", 0, 100000]]);
    expect(await allocs(b)).toEqual([["rent", 1, 100000], ["rent", 2, 50000]]);
    const r = await act("void", a, MGR, { reason: "bounced cheque" });
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ status: "voided" });
    expect(await allocs(a)).toEqual([]);
    expect(await allocs(b)).toEqual([["rent", 1, 100000], ["rent", 2, 50000]]); // untouched, not moved into rent 0
    expect(await paymentRow(a)).toMatchObject({ status: "voided", unapplied_sen: "0", amount_sen: "100000" }); // row kept
    const g = await lease(ctx, l.id);
    expect(g.data.invoices.map((i: { paidSen: number; status: string }) => [i.paidSen, i.status])).toEqual([[0, "unpaid"], [100000, "paid"], [50000, "partially_paid"]]);
    expect(g.data.payments.map((p: { status: string }) => p.status).sort()).toEqual(["approved", "voided"]);
    expect(g.data.payments).toHaveLength(2);
    expect((await act("void", a, MGR, { reason: "second attempt" })).status).toBe(409);
    const audit = (await ctx.db.query("select details from audit_log where entity_id = $1 and action = 'payment.voided'", [a])).rows[0].details;
    expect(audit).toMatchObject({ reason: "bounced cheque", allocationsRemoved: 1 });
  });

  it("voiding frees capacity so the balance can be paid again", async () => {
    const l = await newLease(ctx);
    const p = (await pay(ctx, l.id, MGR, 300000)).data.id;
    expect((await pay(ctx, l.id, MGR, 1)).status).toBe(422);
    expect((await act("void", p, MGR, { reason: "paid by mistake" })).status).toBe(200);
    expect((await pay(ctx, l.id, MGR, 300000)).status).toBe(201);
  });
});

describe("allocation order", () => {
  it("due_date ASC, deposit before rent, rent by period; each invoice is filled before the next; future invoices included", async () => {
    const y = freshYear();
    const l = await newLease(ctx, { start: `${y}-01-31`, end: `${y}-07-15`, rent: 150000, deposit: 300000 });
    // the worked-example lease: deposit 300000, rent 0..4 at 150000, rent 5 at 77419
    const seen: Record<string, number>[] = [];
    for (const amount of [100000, 200000, 250000, 300000]) {
      const r = await pay(ctx, l.id, MGR, amount);
      expect(r.status).toBe(201);
      seen.push(Object.fromEntries((await allocs(r.data.id)).map(([k, i, a]) => [`${k}${i ?? ""}`, a as number])));
    }
    expect(seen).toEqual([
      { deposit: 100000 },
      { deposit: 200000 },
      { rent0: 150000, rent1: 100000 },
      { rent1: 50000, rent2: 150000, rent3: 100000 },
    ]);
    const g = await lease(ctx, l.id);
    expect(g.data.invoices.map((i: { paidSen: number }) => i.paidSen)).toEqual([300000, 150000, 150000, 150000, 100000, 0, 0]);
    for (const i of g.data.invoices) expect(i.paidSen).toBeLessThanOrEqual(i.amountSen);
  });

  it("pays the whole lease off, including the shortened final period, and every invoice becomes paid", async () => {
    const y = freshYear();
    const l = await newLease(ctx, { start: `${y}-01-31`, end: `${y}-07-15`, rent: 150000, deposit: 300000 });
    const total = 300000 + 5 * 150000 + 77419;
    expect((await pay(ctx, l.id, MGR, total)).status).toBe(201);
    const g = await lease(ctx, l.id);
    expect(g.data.invoices.map((i: { status: string }) => i.status)).toEqual(Array(7).fill("paid"));
    expect((await pay(ctx, l.id, MGR, 1)).status).toBe(422); // nothing left to pay
  });
});
