import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateSchedule } from "../../src/lib/billing";
import { signFields } from "../../src/lib/gateway-signature";
import { malaysiaDate } from "../../src/lib/malaysia";
import { rest, rows } from "../db/helpers";
import { BASE, type Account, type Ctx, api, freshUnit, lease, pay, rid, sessionCookie, setup, teardown } from "./helpers";

const run = promisify(execFile);
const KEY = process.env.GATEWAY_X_SIGNATURE_KEY!;
let ctx: Ctx;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => {
  await teardown(ctx);
});

const MGR: Account = "manager@northwind.test";
const BEN: Account = "ben@northwind.test";
const AISYAH: Account = "aisyah@northwind.test";
const PAID_AT = "2026-04-01 00:30:12 +0800";

const today = () => malaysiaDate(new Date());
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** A lease whose first invoices are already due: starts `daysAgo` days ago (Malaysia date). */
async function dueLease(o: { tenant?: Account; daysAgo?: number; days?: number; rent?: number; deposit?: number } = {}) {
  const start = addDays(today(), -(o.daysAgo ?? 40));
  const end = addDays(start, o.days ?? 400);
  const tenantEmail = o.tenant ?? BEN;
  const body = { unitId: await freshUnit(ctx), tenantId: ctx.tenant[tenantEmail], startDate: start, endDate: end, monthlyRentSen: o.rent ?? 100000, depositSen: o.deposit ?? 50000 };
  const r = await api("/api/leases", { token: ctx.tok[MGR], body });
  if (r.status !== 201) throw new Error(`lease: ${r.status} ${r.text}`);
  ctx.created.leases.push(r.data.id);
  const schedule = generateSchedule({ startDate: start, endDate: end, monthlyRentSen: body.monthlyRentSen, depositSen: body.depositSen });
  const dueNow = schedule.filter((s) => s.dueDate <= today()).reduce((sum, s) => sum + s.amountSen, 0);
  return { id: r.data.id as string, tenant: tenantEmail, start, end, schedule, dueNow, totalSen: schedule.reduce((s, i) => s + i.amountSen, 0) };
}

const createBill = (leaseId: string, who: Account | null = BEN, body?: unknown) => api(`/api/leases/${leaseId}/gateway-bills`, { token: who ? ctx.tok[who] : undefined, body: body ?? {} });
async function newBill(l: Awaited<ReturnType<typeof dueLease>>) {
  const r = await createBill(l.id, l.tenant);
  if (r.status !== 201) throw new Error(`bill: ${r.status} ${r.text}`);
  return r.data as { billId: string; amountSen: number };
}

type Fields = Record<string, string>;
const cb = (billId: string, amountSen: number | string, paid = true, extra: Fields = {}, paidAt = PAID_AT): Fields => ({
  id: billId,
  paid: String(paid),
  paid_amount: String(amountSen),
  paid_at: paidAt,
  transaction_id: `TX-${rid().slice(0, 8)}`,
  transaction_status: paid ? "completed" : "failed",
  ...extra,
});
const signed = (fields: Fields, key = KEY): Fields => ({ ...fields, x_signature: signFields(fields, key) });
const hook = (fields: Fields, o: { contentType?: string; raw?: string } = {}) =>
  api("/api/webhooks/gateway", { rawBody: o.raw ?? new URLSearchParams(fields).toString(), headers: { "content-type": o.contentType ?? "application/x-www-form-urlencoded" } });
const send = (billId: string, amountSen: number | string, paid = true, extra: Fields = {}, paidAt = PAID_AT) => hook(signed(cb(billId, amountSen, paid, extra, paidAt)));

const q = async (sql: string, params: unknown[] = []) => (await ctx.db.query(sql, params)).rows;
const billStatus = async (id: string) => (await q("select status from gateway_bills where id = $1", [id]))[0].status as string;
const snapshot = async (leaseId: string) => ({
  payments: await q("select id, status, amount_sen::text, unapplied_sen::text, received_at from payments where lease_id = $1 order by id", [leaseId]),
  allocations: await q("select a.payment_id, a.invoice_id, a.amount_sen::text from payment_allocations a join payments p on p.id = a.payment_id where p.lease_id = $1 order by 1, 2", [leaseId]),
  bills: await q("select id, status from gateway_bills where lease_id = $1 order by id", [leaseId]),
});
const onlinePayments = (billId: string) => q("select id, status, method, amount_sen::text, unapplied_sen::text, received_at, gateway_bill_id from payments where gateway_bill_id = $1", [billId]);
const allocSum = async (paymentId: string) => Number((await q("select coalesce(sum(amount_sen), 0)::text s from payment_allocations where payment_id = $1", [paymentId]))[0].s);

describe("POST /api/leases/:id/gateway-bills", () => {
  it("creates a pending bill for exactly the unpaid amount due on or before today (Malaysia date)", async () => {
    const l = await dueLease();
    expect(l.dueNow).toBeGreaterThan(0);
    expect(l.dueNow).toBeLessThan(l.totalSen); // some invoices are still in the future
    const r = await createBill(l.id);
    expect(r.status).toBe(201);
    expect(Object.keys(r.data).sort()).toEqual(["amountSen", "billId"]);
    expect(r.data.amountSen).toBe(l.dueNow);
    expect(await billStatus(r.data.billId)).toBe("pending");
    const row = (await q("select org_id, lease_id, amount_sen::text from gateway_bills where id = $1", [r.data.billId]))[0];
    expect(row).toEqual({ org_id: ctx.nw, lease_id: l.id, amount_sen: String(l.dueNow) });
    expect((await q("select action, actor_id from audit_log where entity_id = $1", [r.data.billId]))[0]).toEqual({ action: "gateway_bill.created", actor_id: ctx.userId[BEN] });
  });

  it("only counts what is still unpaid on due invoices (manual payments reduce the bill)", async () => {
    const l = await dueLease();
    expect((await pay(ctx, l.id, MGR, 60000)).status).toBe(201);
    const r = await createBill(l.id);
    expect(r.status).toBe(201);
    expect(r.data.amountSen).toBe(l.dueNow - 60000);
  });

  it("an invoice due today is included; one due tomorrow is not", async () => {
    const t = await dueLease({ daysAgo: 0, deposit: 0, rent: 120000 }); // starts today: rent 0 due today
    expect((await createBill(t.id)).data.amountSen).toBe(t.schedule[0].amountSen);
    const f = await dueLease({ daysAgo: -1, deposit: 50000 }); // starts tomorrow: nothing due
    expect((await createBill(f.id)).status).toBe(422);
  });

  it("422 when nothing is due (all due invoices already paid) and no bill row is written", async () => {
    const l = await dueLease({ daysAgo: 0, deposit: 0 });
    expect((await pay(ctx, l.id, MGR, l.dueNow)).status).toBe(201);
    const r = await createBill(l.id);
    expect(r.status).toBe(422);
    expect(await q("select id from gateway_bills where lease_id = $1", [l.id])).toEqual([]);
  });

  it("ignores any amount or tenant in the request body", async () => {
    const l = await dueLease();
    const r = await createBill(l.id, BEN, { amountSen: 1, amount: 1, tenantId: ctx.tenant[AISYAH], leaseId: rid(), orgId: ctx.beta, status: "paid", billId: "chosen-by-client" });
    expect(r.status).toBe(201);
    expect(r.data.amountSen).toBe(l.dueNow);
    expect(r.data.billId).not.toBe("chosen-by-client");
    expect(await billStatus(r.data.billId)).toBe("pending");
  });

  it("bill ids are unpredictable (random UUID v4, no collisions)", async () => {
    const l = await dueLease();
    const ids = await Promise.all(Array.from({ length: 20 }, () => createBill(l.id).then((r) => r.data.billId as string)));
    expect(new Set(ids).size).toBe(20);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("only the tenant who owns the lease: staff/managers 403, other tenants and other organizations 404, anonymous 401", async () => {
    const l = await dueLease();
    expect((await createBill(l.id, MGR)).status).toBe(403);
    expect((await createBill(l.id, "staff@northwind.test")).status).toBe(403);
    expect((await createBill(l.id, AISYAH)).status).toBe(404);
    expect((await createBill(l.id, "probe@northwind.test")).status).toBe(404);
    expect((await createBill(l.id, "manager@beta.test")).status).toBe(404);
    expect((await createBill(l.id, "chen@beta.test")).status).toBe(404);
    expect((await createBill(l.id, null)).status).toBe(401);
    expect((await createBill(rid(), BEN)).status).toBe(404);
    expect((await createBill("not-a-uuid", BEN)).status).toBe(404);
    expect(await q("select id from gateway_bills where lease_id = $1", [l.id])).toEqual([]);
  });

  it("works with an SSR session cookie as well as a Bearer token (cookie writes need a same-origin Origin)", async () => {
    const l = await dueLease();
    const cookie = await sessionCookie(BEN);
    expect((await api(`/api/leases/${l.id}/gateway-bills`, { cookie, method: "POST" })).status).toBe(403); // no Origin
    expect((await api(`/api/leases/${l.id}/gateway-bills`, { cookie, method: "POST", headers: { origin: new URL(BASE).origin } })).status).toBe(201);
  });
});

describe("POST /api/webhooks/gateway: signature", () => {
  it("a wrong key (including the published test key), missing, empty, malformed or forged signature is 401 and changes nothing", async () => {
    const l = await dueLease();
    const bill = await newBill(l);
    const before = await snapshot(l.id);
    const good = cb(bill.billId, bill.amountSen);
    const attempts: [string, Fields][] = [
      ["test vector key", signed(good, "test_x_signature_key")],
      ["no signature", good],
      ["empty signature", { ...good, x_signature: "" }],
      ["short signature", { ...good, x_signature: "abc123" }],
      ["non-hex signature", { ...good, x_signature: "z".repeat(64) }],
      ["signature of other fields", { ...good, x_signature: signFields({ ...good, paid_amount: "1" }, KEY) }],
      ["amount changed after signing", { ...signed(good), paid_amount: String(bill.amountSen - 1) }],
      ["paid flipped after signing", { ...signed(cb(bill.billId, bill.amountSen, false)), paid: "true" }],
      ["unsigned extra field added", { ...signed(good), injected: "1" }],
      ["signed field removed", (() => { const s = signed(good); delete (s as Record<string, string>).transaction_id; return s; })()],
      ["bill id swapped", { ...signed(good), id: rid() }],
    ];
    for (const [label, fields] of attempts) {
      const r = await hook(fields);
      expect(r.status, label).toBe(401);
      expect(r.text, label).not.toContain(signFields(good, KEY));
    }
    expect(await snapshot(l.id)).toEqual(before);
  });

  it("duplicate field names are rejected (ambiguous canonical string)", async () => {
    const l = await dueLease();
    const bill = await newBill(l);
    const body = new URLSearchParams(signed(cb(bill.billId, bill.amountSen))).toString() + "&paid=false";
    expect((await hook({}, { raw: body })).status).toBe(401);
    expect(await billStatus(bill.billId)).toBe("pending");
  });

  it("accepts a valid signature in any field order, and additional signed gateway fields", async () => {
    const l = await dueLease();
    const bill = await newBill(l);
    const fields = signed(cb(bill.billId, bill.amountSen, true, { bank_ref: "A B|C", currency: "MYR", "zz extra": "1" }));
    const reversed = Object.fromEntries(Object.entries(fields).reverse());
    const r = await hook(reversed);
    expect(r.status).toBe(200);
    expect(await billStatus(bill.billId)).toBe("paid");
  });

  it("requires form-urlencoded; JSON or missing bodies are rejected without changes", async () => {
    const l = await dueLease();
    const bill = await newBill(l);
    const fields = signed(cb(bill.billId, bill.amountSen));
    expect((await api("/api/webhooks/gateway", { body: fields })).status).toBe(400);
    expect((await hook(fields, { contentType: "text/plain" })).status).toBe(400);
    expect((await hook({}, { raw: "" })).status).toBe(401);
    expect(await billStatus(bill.billId)).toBe("pending");
  });

  it("a valid signature over an incomplete or malformed payload is 400, not a state change", async () => {
    const l = await dueLease();
    const bill = await newBill(l);
    for (const name of ["id", "paid", "paid_amount", "paid_at", "transaction_id", "transaction_status"]) {
      const f = cb(bill.billId, bill.amountSen);
      delete (f as Record<string, string>)[name];
      expect((await hook(signed(f))).status, name).toBe(400);
    }
    expect((await send(bill.billId, bill.amountSen, true, { paid: "yes" })).status).toBe(400);
    expect((await hook(signed({ ...cb(bill.billId, bill.amountSen), paid: "TRUE" }))).status).toBe(400);
    expect((await hook(signed({ ...cb(bill.billId, bill.amountSen), transaction_id: "" }))).status).toBe(400);
    expect(await billStatus(bill.billId)).toBe("pending");
    expect(await onlinePayments(bill.billId)).toEqual([]);
  });
});

describe("POST /api/webhooks/gateway: states", () => {
  it("unknown bill is 404 and changes nothing", async () => {
    const l = await dueLease();
    const before = await snapshot(l.id);
    expect((await send(rid(), 1000)).status).toBe(404);
    expect((await send("bill_8f3a2c", 210050)).status).toBe(404);
    expect((await send("", 1000)).status).toBe(404);
    expect((await send(rid(), 1000, false)).status).toBe(404);
    expect(await snapshot(l.id)).toEqual(before);
  });

  it("paid=true with an amount that is not exactly the bill amount is 422 and changes nothing", async () => {
    const l = await dueLease();
    const bill = await newBill(l);
    const before = await snapshot(l.id);
    for (const amount of [bill.amountSen - 1, bill.amountSen + 1, 0, 1, `${bill.amountSen}.00`, `0${bill.amountSen}`, ` ${bill.amountSen}`, `-${bill.amountSen}`, "", "abc", `${bill.amountSen}e0`, "1e5"]) {
      expect((await send(bill.billId, amount)).status, String(amount)).toBe(422);
    }
    expect(await snapshot(l.id)).toEqual(before);
    expect(await billStatus(bill.billId)).toBe("pending");
  });

  it("an amount mismatch is 422 even for an already-paid bill", async () => {
    const l = await dueLease();
    const bill = await newBill(l);
    expect((await send(bill.billId, bill.amountSen)).status).toBe(200);
    expect((await send(bill.billId, bill.amountSen + 5)).status).toBe(422);
    expect((await onlinePayments(bill.billId)).length).toBe(1);
  });

  it("pending -> paid: exactly one approved online payment of the bill amount, received_at from paid_at, allocated in order", async () => {
    const l = await dueLease();
    const bill = await newBill(l);
    const r = await send(bill.billId, bill.amountSen, true, {}, "2026-04-01 00:30:12 +0800");
    expect(r.status).toBe(200);
    expect(await billStatus(bill.billId)).toBe("paid");
    const pays = await onlinePayments(bill.billId);
    expect(pays).toHaveLength(1);
    expect(pays[0]).toMatchObject({ status: "approved", method: "online", amount_sen: String(bill.amountSen), unapplied_sen: "0", gateway_bill_id: bill.billId });
    expect(new Date(pays[0].received_at).toISOString()).toBe("2026-03-31T16:30:12.000Z");
    expect(await allocSum(pays[0].id)).toBe(bill.amountSen);
    // allocated by the normal rules: deposit first, then rent by period
    const order = (await q("select i.kind, i.period_index from payment_allocations a join invoices i on i.id = a.invoice_id where a.payment_id = $1 order by i.due_date, i.kind, i.period_index", [pays[0].id])).map((x) => [x.kind, x.period_index]);
    expect(order[0]).toEqual(["deposit", null]);
    const g = await lease(ctx, l.id, MGR);
    expect(g.data.payments).toHaveLength(1);
    expect(g.data.payments[0]).toMatchObject({ amountSen: bill.amountSen, unappliedSen: 0, method: "online", status: "approved", receivedAt: "2026-03-31T16:30:12.000Z" });
    expect(g.data.invoices.reduce((s: number, i: { paidSen: number }) => s + i.paidSen, 0)).toBe(bill.amountSen);
  });

  it("converts paid_at from Malaysia time to the exact UTC instant", async () => {
    const cases: [string, string][] = [
      ["2026-04-01 00:30:12 +0800", "2026-03-31T16:30:12.000Z"],
      ["2026-01-01 07:59:59 +0800", "2025-12-31T23:59:59.000Z"],
      ["2026-06-15 08:00:00 +0800", "2026-06-15T00:00:00.000Z"],
      ["2028-02-29 23:59:59 +0800", "2028-02-29T15:59:59.000Z"],
    ];
    for (const [paidAt, utc] of cases) {
      const l = await dueLease({ daysAgo: 0, deposit: 0 });
      const bill = await newBill(l);
      expect((await send(bill.billId, bill.amountSen, true, {}, paidAt)).status).toBe(200);
      expect(new Date((await onlinePayments(bill.billId))[0].received_at).toISOString(), paidAt).toBe(utc);
    }
  });

  it("rejects paid_at values that are not a real Malaysia instant (400, nothing changes)", async () => {
    const l = await dueLease();
    const bill = await newBill(l);
    for (const paidAt of ["", "2026-04-01 00:30:12", "2026-04-01 00:30:12 +0000", "2026-04-01 00:30:12 +08:00", "2026-04-01T00:30:12+0800", "2026-04-01 00:30:12 +0900", "2026-02-30 10:00:00 +0800", "2026-04-01 24:00:00 +0800", "yesterday", "2026-04-01"]) {
      expect((await send(bill.billId, bill.amountSen, true, {}, paidAt)).status, JSON.stringify(paidAt)).toBe(400);
    }
    expect(await billStatus(bill.billId)).toBe("pending");
    expect(await onlinePayments(bill.billId)).toEqual([]);
  });

  it("a failed callback needs no valid paid_at", async () => {
    const l = await dueLease();
    const bill = await newBill(l);
    expect((await send(bill.billId, bill.amountSen, false, {}, "")).status).toBe(200);
    expect(await billStatus(bill.billId)).toBe("failed");
  });

  it("pending -> failed, and failed stays failed (no payment)", async () => {
    const l = await dueLease();
    const bill = await newBill(l);
    expect((await send(bill.billId, bill.amountSen, false)).status).toBe(200);
    expect(await billStatus(bill.billId)).toBe("failed");
    expect((await send(bill.billId, bill.amountSen, false)).status).toBe(200);
    expect(await billStatus(bill.billId)).toBe("failed");
    expect(await onlinePayments(bill.billId)).toEqual([]);
  });

  it("paid=false ignores the callback amount (the gateway reports a failed attempt)", async () => {
    const l = await dueLease();
    const bill = await newBill(l);
    expect((await send(bill.billId, 1, false)).status).toBe(200);
    expect(await billStatus(bill.billId)).toBe("failed");
  });

  it("failed -> paid is allowed (a later valid paid callback settles the bill)", async () => {
    const l = await dueLease();
    const bill = await newBill(l);
    await send(bill.billId, bill.amountSen, false);
    expect(await billStatus(bill.billId)).toBe("failed");
    expect((await send(bill.billId, bill.amountSen, true)).status).toBe(200);
    expect(await billStatus(bill.billId)).toBe("paid");
    expect(await onlinePayments(bill.billId)).toHaveLength(1);
  });

  it("paid is terminal: duplicate paid callbacks create nothing; failed callbacks never downgrade", async () => {
    const l = await dueLease();
    const bill = await newBill(l);
    expect((await send(bill.billId, bill.amountSen)).status).toBe(200);
    const settled = await snapshot(l.id);
    expect((await send(bill.billId, bill.amountSen)).status).toBe(200);
    expect((await send(bill.billId, bill.amountSen, true, {}, "2026-05-05 10:00:00 +0800")).status).toBe(200);
    expect((await send(bill.billId, bill.amountSen, false)).status).toBe(200);
    expect((await send(bill.billId, 1, false)).status).toBe(200);
    expect(await snapshot(l.id)).toEqual(settled);
    expect(await billStatus(bill.billId)).toBe("paid");
  });

  it("out-of-order callbacks: failed-after-paid keeps paid; paid-after-failed settles", async () => {
    const a = await newBill(await dueLease());
    await send(a.billId, a.amountSen, true);
    await send(a.billId, a.amountSen, false);
    expect(await billStatus(a.billId)).toBe("paid");
    const b = await newBill(await dueLease());
    await send(b.billId, b.amountSen, false);
    await send(b.billId, b.amountSen, false);
    await send(b.billId, b.amountSen, true);
    await send(b.billId, b.amountSen, false);
    expect(await billStatus(b.billId)).toBe("paid");
    expect(await onlinePayments(b.billId)).toHaveLength(1);
  });

  it("each bill settles independently: two bills on one lease create two payments (not the same one twice)", async () => {
    const l = await dueLease();
    const b1 = await newBill(l);
    const b2 = await newBill(l); // same amount: nothing has been paid yet
    expect(b2.amountSen).toBe(b1.amountSen);
    expect((await send(b1.billId, b1.amountSen)).status).toBe(200);
    expect((await send(b2.billId, b2.amountSen)).status).toBe(200);
    expect(await onlinePayments(b1.billId)).toHaveLength(1);
    expect(await onlinePayments(b2.billId)).toHaveLength(1);
  });
});

describe("concurrency and idempotency", () => {
  it("12 concurrent paid callbacks for one bill: all 200, exactly one payment, allocated exactly once", async () => {
    const l = await dueLease();
    const bill = await newBill(l);
    const results = await Promise.all(Array.from({ length: 12 }, () => send(bill.billId, bill.amountSen)));
    expect(results.map((r) => r.status)).toEqual(Array(12).fill(200));
    const pays = await onlinePayments(bill.billId);
    expect(pays).toHaveLength(1);
    expect(await allocSum(pays[0].id)).toBe(bill.amountSen);
    expect(await billStatus(bill.billId)).toBe("paid");
    expect(await q("select count(*)::int n from payments where lease_id = $1", [l.id])).toEqual([{ n: 1 }]);
  });

  it("concurrent paid and failed callbacks: the bill always ends paid, with one payment", async () => {
    for (let round = 0; round < 3; round++) {
      const l = await dueLease();
      const bill = await newBill(l);
      const calls = Array.from({ length: 12 }, (_, i) => send(bill.billId, bill.amountSen, i % 3 === 0));
      const results = await Promise.all(calls);
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(await billStatus(bill.billId)).toBe("paid");
      expect(await onlinePayments(bill.billId)).toHaveLength(1);
    }
  });

  it("concurrent failed callbacks only fail the bill once and create nothing", async () => {
    const l = await dueLease();
    const bill = await newBill(l);
    const results = await Promise.all(Array.from({ length: 10 }, () => send(bill.billId, bill.amountSen, false)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await billStatus(bill.billId)).toBe("failed");
    expect((await snapshot(l.id)).payments).toEqual([]);
  });

  it("webhooks for different bills of one lease and manual payments share the lease lock: the books stay exact", async () => {
    const l = await dueLease({ daysAgo: 100, rent: 100000, deposit: 0, days: 600 });
    const bills = await Promise.all(Array.from({ length: 4 }, () => newBill(l)));
    const results = await Promise.all([
      ...bills.map((b) => send(b.billId, b.amountSen)),
      ...Array.from({ length: 6 }, () => pay(ctx, l.id, MGR, 50000)),
      ...bills.map((b) => send(b.billId, b.amountSen)),
    ]);
    expect(results.filter((r) => r.status >= 500)).toEqual([]);
    for (const b of bills) expect(await onlinePayments(b.billId)).toHaveLength(1);
    expect((await q("select count(*)::int n from invoices i where i.lease_id = $1 and (select coalesce(sum(amount_sen), 0) from payment_allocations where invoice_id = i.id) > i.amount_sen", [l.id]))[0].n).toBe(0);
    const bad = await q("select p.id from payments p where p.lease_id = $1 and p.status = 'approved' and (select coalesce(sum(amount_sen), 0) from payment_allocations where payment_id = p.id) + p.unapplied_sen <> p.amount_sen", [l.id]);
    expect(bad).toEqual([]);
  });
});

describe("balances change before the webhook arrives; unapplied funds", () => {
  it("manual payments that settle part of the bill do not block the gateway payment: it fills what is left, incl. future invoices", async () => {
    const l = await dueLease();
    const bill = await newBill(l);
    expect((await pay(ctx, l.id, MGR, 60000)).status).toBe(201); // pays part of the deposit before the webhook
    expect((await send(bill.billId, bill.amountSen)).status).toBe(200);
    const online = (await onlinePayments(bill.billId))[0];
    expect(online.unapplied_sen).toBe("0"); // there was enough unpaid balance, including future invoices
    expect(await allocSum(online.id)).toBe(bill.amountSen);
    const g = await lease(ctx, l.id, MGR);
    const total = g.data.invoices.reduce((s: number, i: { paidSen: number }) => s + i.paidSen, 0);
    expect(total).toBe(60000 + bill.amountSen);
    const future = g.data.invoices.filter((i: { dueDate: string }) => i.dueDate > today());
    expect(future.some((i: { paidSen: number }) => i.paidSen > 0)).toBe(true); // spilled into future invoices
  });

  it("when everything is already paid the legitimate payment is accepted and fully unapplied", async () => {
    const l = await dueLease({ daysAgo: 0, deposit: 0, days: 60 }); // short lease, total known
    const bill = await newBill(l);
    expect((await pay(ctx, l.id, MGR, l.totalSen)).status).toBe(201); // settle the WHOLE lease manually
    expect((await send(bill.billId, bill.amountSen)).status).toBe(200);
    const online = (await onlinePayments(bill.billId))[0];
    expect(online).toMatchObject({ status: "approved", method: "online", amount_sen: String(bill.amountSen), unapplied_sen: String(bill.amountSen) });
    expect(await allocSum(online.id)).toBe(0);
    const g = await lease(ctx, l.id, MGR);
    expect(g.data.payments.find((p: { method: string }) => p.method === "online")).toMatchObject({ amountSen: bill.amountSen, unappliedSen: bill.amountSen });
    expect(await billStatus(bill.billId)).toBe("paid");
  });

  it("a partial overlap stores exactly the leftover as unapplied_sen", async () => {
    const l = await dueLease({ daysAgo: 0, deposit: 0, rent: 100000, days: 60 }); // invoices: 100000 (due today), 100000 (+1 month)
    const bill = await newBill(l); // 100000
    expect(l.totalSen).toBeGreaterThan(bill.amountSen);
    const leftover = l.totalSen - 40000;
    expect((await pay(ctx, l.id, MGR, leftover)).status).toBe(201); // only 40000 of balance remains
    expect((await send(bill.billId, bill.amountSen)).status).toBe(200);
    const online = (await onlinePayments(bill.billId))[0];
    expect(online.unapplied_sen).toBe(String(bill.amountSen - 40000));
    expect(await allocSum(online.id)).toBe(40000);
  });

  it("existing payments are never reallocated: voiding another payment later leaves the online allocations alone", async () => {
    const l = await dueLease();
    const manual = (await pay(ctx, l.id, MGR, 30000)).data.id;
    const bill = await newBill(l);
    await send(bill.billId, bill.amountSen);
    const online = (await onlinePayments(bill.billId))[0].id;
    const before = await q("select invoice_id, amount_sen::text from payment_allocations where payment_id = $1 order by invoice_id", [online]);
    expect((await api(`/api/payments/${manual}/void`, { token: ctx.tok[MGR], body: { reason: "bounced cheque" } })).status).toBe(200);
    expect(await q("select invoice_id, amount_sen::text from payment_allocations where payment_id = $1 order by invoice_id", [online])).toEqual(before);
    expect(await allocSum(manual)).toBe(0);
  });

  it("online money reduces what a pending manual payment can claim on approval (existing 422 recheck)", async () => {
    const l = await dueLease({ daysAgo: 0, deposit: 0, days: 60 });
    const bill = await newBill(l);
    const pending = (await pay(ctx, l.id, "staff@northwind.test", l.totalSen - bill.amountSen)).data.id; // fits now
    expect((await send(bill.billId, bill.amountSen)).status).toBe(200);
    expect((await pay(ctx, l.id, MGR, 1)).status).toBe(422); // remaining - pending = 0
    expect((await api(`/api/payments/${pending}/approve`, { token: ctx.tok[MGR], body: {} })).status).toBe(200); // still fits exactly
  });
});

describe("tenant isolation and the Data API", () => {
  it("the tenant sees their own bills through the Data API; others do not (RLS)", async () => {
    const l = await dueLease();
    const bill = await newBill(l);
    expect((await rows(ctx.tok[BEN], "gateway_bills", `select=id&id=eq.${bill.billId}`))).toEqual([{ id: bill.billId }]);
    for (const who of [AISYAH, "probe@northwind.test", "chen@beta.test", "manager@beta.test"] as Account[]) expect(await rows(ctx.tok[who], "gateway_bills", `select=id&id=eq.${bill.billId}`), who).toEqual([]);
    expect((await rows(ctx.tok[MGR], "gateway_bills", `select=id&id=eq.${bill.billId}`)).length).toBe(1);
    expect((await rest(`gateway_bills?select=id&id=eq.${bill.billId}`)).status).toBe(401); // anonymous
  });

  it("nobody can insert, update or delete bills, payments or allocations through the Data API", async () => {
    const l = await dueLease();
    const bill = await newBill(l);
    for (const who of [BEN, AISYAH, "staff@northwind.test", MGR, "manager@beta.test"] as Account[]) {
      const token = ctx.tok[who];
      expect((await rest("gateway_bills", { token, method: "POST", body: { org_id: ctx.nw, lease_id: l.id, amount_sen: 1, status: "paid" } })).status, `${who} insert bill`).toBe(403);
      expect((await rest(`gateway_bills?id=eq.${bill.billId}`, { token, method: "PATCH", body: { status: "paid" } })).status, `${who} mark paid`).toBe(403);
      expect((await rest(`gateway_bills?id=eq.${bill.billId}`, { token, method: "PATCH", body: { amount_sen: 1 } })).status, `${who} change amount`).toBe(403);
      expect((await rest(`gateway_bills?id=eq.${bill.billId}`, { token, method: "DELETE" })).status, `${who} delete bill`).toBe(403);
      expect((await rest("payments", { token, method: "POST", body: { org_id: ctx.nw, lease_id: l.id, amount_sen: 100, unapplied_sen: 0, method: "online", status: "approved", received_at: new Date().toISOString(), gateway_bill_id: bill.billId } })).status, `${who} insert payment`).toBe(403);
      expect((await rest("payment_allocations", { token, method: "POST", body: { org_id: ctx.nw, payment_id: rid(), invoice_id: rid(), amount_sen: 1 } })).status, `${who} insert allocation`).toBe(403);
    }
    expect(await billStatus(bill.billId)).toBe("pending");
    expect((await snapshot(l.id)).payments).toEqual([]);
  });

  it("the database enforces UNIQUE(payments.gateway_bill_id)", async () => {
    const l = await dueLease();
    const bill = await newBill(l);
    await send(bill.billId, bill.amountSen);
    await expect(
      ctx.db.query("insert into payments (org_id, lease_id, amount_sen, unapplied_sen, method, status, received_at, gateway_bill_id) values ($1, $2, 1, 0, 'online', 'approved', now(), $3)", [ctx.nw, l.id, bill.billId]),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("the secret and the signature never appear in responses", async () => {
    const l = await dueLease();
    const bill = await newBill(l);
    const f = signed(cb(bill.billId, bill.amountSen));
    const r = await hook(f);
    expect(r.text).not.toContain(KEY);
    expect(r.text).not.toContain(f.x_signature);
    const bad = await hook({ ...f, paid_amount: "1" });
    expect(bad.text).not.toContain(KEY);
    expect(bad.text).not.toContain(f.x_signature);
  });
});

describe("/payments/return", () => {
  const view = async (billId: string, query = "paid=true", cookie?: string) => {
    const res = await fetch(`${BASE}/payments/return?bill_id=${billId}${query ? `&${query}` : ""}`, { headers: cookie ? { cookie } : {} });
    const html = await res.text();
    return { status: res.status, html, state: /data-state="([^"]+)"/.exec(html)?.[1], billStatus: /data-bill-status="([^"]+)"/.exec(html)?.[1] };
  };

  it("shows the persisted status, not the query string: a forged paid=true on a pending bill stays pending and changes nothing", async () => {
    const l = await dueLease();
    const bill = await newBill(l);
    const cookie = await sessionCookie(BEN);
    const before = await snapshot(l.id);
    for (const query of ["paid=true", "paid=1", "paid=true&status=paid&transaction_status=completed&x_signature=abc", ""]) {
      const v = await view(bill.billId, query, cookie);
      expect(v.state, query).toBe("bill");
      expect(v.billStatus, query).toBe("pending");
    }
    expect(await snapshot(l.id)).toEqual(before);
    expect(await billStatus(bill.billId)).toBe("pending");
  });

  it("follows the real status: paid after the webhook (even with paid=false in the URL), failed after a failure", async () => {
    const l = await dueLease();
    const paidBill = await newBill(l);
    const failedBill = await newBill(l);
    const cookie = await sessionCookie(BEN);
    await send(paidBill.billId, paidBill.amountSen, true);
    await send(failedBill.billId, failedBill.amountSen, false);
    expect((await view(paidBill.billId, "paid=false", cookie)).billStatus).toBe("paid");
    expect((await view(failedBill.billId, "paid=true", cookie)).billStatus).toBe("failed");
  });

  it("enforces ownership: other tenants, staff, managers of other organizations and anonymous visitors see no details", async () => {
    const l = await dueLease();
    const bill = await newBill(l);
    for (const who of [AISYAH, "probe@northwind.test", "chen@beta.test", "manager@beta.test", MGR, "staff@northwind.test"] as Account[]) {
      const v = await view(bill.billId, "paid=true", await sessionCookie(who));
      expect(v.state, who).toBe("not-found");
      expect(v.billStatus, who).toBeUndefined();
      expect(v.html).not.toContain(String(bill.amountSen));
    }
    const anon = await view(bill.billId);
    expect(anon.state).toBe("signin");
    expect(anon.billStatus).toBeUndefined();
    expect((await view(rid(), "paid=true", await sessionCookie(BEN))).state).toBe("not-found");
    expect((await view("not-a-uuid", "paid=true", await sessionCookie(BEN))).state).toBe("not-found");
    expect((await view("x' or '1'='1", "paid=true", await sessionCookie(BEN))).state).toBe("not-found");
    expect((await fetch(`${BASE}/payments/return?paid=true`, { headers: { cookie: await sessionCookie(BEN) } })).status).toBe(200);
    expect(await billStatus(bill.billId)).toBe("pending");
  });
});

describe("gateway-sim.mjs", () => {
  const sim = (args: string[], env: Record<string, string> = {}) =>
    run("node", ["gateway-sim.mjs", ...args], { env: { ...process.env, WEBHOOK_URL: `${BASE}/api/webhooks/gateway`, ...env } }).then(
      (r) => ({ code: 0, out: r.stdout }),
      (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, out: e.stdout + e.stderr }),
    );

  it("settles a bill with a signed callback (default paid=true)", async () => {
    const l = await dueLease();
    const bill = await newBill(l);
    const r = await sim([bill.billId, String(bill.amountSen)]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^200 /);
    expect(await billStatus(bill.billId)).toBe("paid");
    const payment = (await onlinePayments(bill.billId))[0];
    expect(Math.abs(new Date(payment.received_at).getTime() - Date.now())).toBeLessThan(120_000); // "now" in Malaysia time, converted correctly
  });

  it("sends paid=false, reports wrong amounts and bad keys as non-zero exits", async () => {
    const l = await dueLease();
    const bill = await newBill(l);
    expect((await sim([bill.billId, String(bill.amountSen), "false"])).code).toBe(0);
    expect(await billStatus(bill.billId)).toBe("failed");
    const wrong = await sim([bill.billId, String(bill.amountSen + 1), "true"]);
    expect(wrong.code).toBe(1);
    expect(wrong.out).toMatch(/^422 /);
    const badKey = await sim([bill.billId, String(bill.amountSen), "true"], { GATEWAY_X_SIGNATURE_KEY: "not-the-key" });
    expect(badKey.code).toBe(1);
    expect(badKey.out).toMatch(/^401 /);
    expect((await sim([])).code).toBe(2);
    expect((await sim([bill.billId, "abc"])).code).toBe(2);
    expect(await billStatus(bill.billId)).toBe("failed");
  });
});
