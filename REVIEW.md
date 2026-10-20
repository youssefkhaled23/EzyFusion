# REVIEW.md — Code review of the teammate's snippets (Assessment Part B)

Scope: the three snippets in the assessment document. Assumptions, as given: Prisma connects as the database owner (so it **bypasses RLS**), `createClient()` returns the request's Supabase server client, `allocate(tx, paymentId)` is correct.

**Line numbers.** All numbers below are the line numbers of the original assessment document: late fees 306–357, webhook 360–399, collections 402–416. They were derived from those three ranges. The ranges are contiguous slices of the supplied snippets: the late-fees and webhook ranges start at the first `import` and end at the final `}`; the collections range starts at its `// app/(staff)/…` comment. The path comment on the first two snippets is therefore not numbered. The original text itself was not available while writing this, so these numbers could not be checked against it directly. Every finding also quotes the code so it can be located without the numbers.

Severity scale: **Critical** = exploitable data/money loss or privilege escalation; **High** = wrong money, duplicate effects, secret disclosure or a broken endpoint; **Medium** = contract violations with a real but narrower impact; **Low** = robustness / status-code issues.

## Summary

| # | Sev | File | Lines | Issue |
|---|---|---|---|---|
| 1 | Critical | late-fees | 316–318 | Manager role read from client-writable `user_metadata` |
| 2 | Critical | late-fees | 322–326 | No organization scoping: fees on any organization's lease |
| 3 | Critical | collections | 403, 407, 411 | Public server action; client-supplied `orgId`, no authentication |
| 4 | Critical | webhook | 379–398 | Bill status checked outside the transaction, no lock: concurrent callbacks double-credit |
| 5 | High | webhook | 374 | Logs the full payload and the *valid* signature |
| 6 | High | webhook | 391 | Payment amount taken from the callback, never compared with the bill |
| 7 | High | late-fees | 332–350 | Not idempotent, no lock: every call charges the same invoice again |
| 8 | High | late-fees | 337–350, 354–357 | Lazy Prisma promises + `nextReference`: identical references; no transaction |
| 9 | High | collections | 409, 412 | Months and bounds use the database timezone, not Malaysia time |
| 10 | High | late-fees | 342, 345, 355–356 | `late_fee`, `reference`, `createdAt` do not exist in the required invoice model |
| 11 | Medium | webhook | 377 | `paid=false` ignored: bill never becomes `failed`; unknown bill not 404 |
| 12 | Medium | webhook | 373 | Signature compared with `!==` instead of `timingSafeEqual` |
| 13 | Medium | webhook | 392 | `receivedAt` is the server clock, not the gateway's `paid_at` |
| 14 | Medium | collections | 409, 413 | Months without payments are missing |
| 15 | Medium | late-fees | 335–336 | Floating-point money and a 0.5 % free pass |
| 16 | Medium | webhook | 386–394 | `unapplied_sen` (NOT NULL) is not set on the payment |
| 17 | Low | late-fees | 316–318 | Unauthenticated request answered 403 instead of 401 |
| 18 | Low | all | 321–323, 366, 407–412 | Unvalidated input becomes a 500 |

---

## 1. Critical — manager role comes from `user_metadata` (late-fees, L316–318)

```ts
const { data: { user } } = await supabase.auth.getUser()                 // L316
if (user?.user_metadata.role !== 'manager') {                            // L317
  return NextResponse.json({ error: 'Forbidden' }, { status: 403 })      // L318
}
```
**Failure.** `user_metadata` is writable by the user themselves. Any signed-in tenant runs `supabase.auth.updateUser({ data: { role: 'manager' } })` in the browser and passes this check. The assessment rule is that roles come from `memberships` (and tenants from `tenants.user_id`), never from user metadata.
**Fix.** Use only the verified `user.id`, then load the role from the database: `prisma.membership.findUnique({ where: { userId_orgId: { userId: user.id, orgId: lease.orgId } } })` and require `role === 'manager'`.

## 2. Critical — no organization scoping on the lease (late-fees, L322–326)

```ts
const lease = await prisma.lease.findUnique({ where: { id: leaseId }, include: {...} })   // L322-L325 (404 at L326)
```
**Failure.** Prisma runs as the owner, so RLS does not help. Any caller who passes check #1 (including a manager of organization A) can POST to a lease id of organization B and create fees on it. The 404 vs 200 difference also confirms which lease ids exist.
**Fix.** Scope the lookup by the caller's organizations: `findFirst({ where: { id: leaseId, orgId: { in: managerOrgIds } } })`, where `managerOrgIds` comes from the caller's `manager` memberships; return 404 otherwise. Never trust ids from the request for authorization.

## 3. Critical — public server action with a client-supplied `orgId` (collections, L403, L407, L411)

```ts
'use server'                                                              // L403
export async function getCollections(orgId: string, from: string, to: string) {   // L407
  ... WHERE org_id = ${orgId}::uuid AND status = 'approved'               // L411
```
**Failure.** A `'use server'` export is a public POST endpoint. Nothing here authenticates the caller or checks membership, and Prisma bypasses RLS. Anyone (even without a session) can call it with another organization's UUID and read that organization's monthly revenue.
**Fix.** Authenticate with `supabase.auth.getUser()`, resolve the caller's staff/manager organizations from `memberships`, ignore (or verify) the client `orgId`, and return 401/403 otherwise.

## 4. Critical — webhook checks the bill status outside the transaction, with no lock (webhook, L379–398)

```ts
const bill = await prisma.gatewayBill.findUnique(...)                     // L379
if (bill.status === 'paid') return NextResponse.json({ ok: true })        // L381
await prisma.$transaction(async (tx) => { ...                             // L383
  await tx.gatewayBill.update(... status: 'paid')                         // L384
  const payment = await tx.payment.create(...)                            // L385
  await allocate(tx, payment.id)                                          // L396
```
**Failure.** Two `paid=true` callbacks 5 ms apart (the gateway retries) both read `pending` at L379–381 before either commits. Both enter the transaction: the bill is "paid" twice and **two approved online payments** are created and allocated, so the tenant is credited twice. If `UNIQUE(payments.gateway_bill_id)` exists, the second transaction instead fails with an unhandled unique violation → HTTP 500 → the gateway retries again. The webhook also races with manual payments: no per-lease lock is taken before `allocate`.
**Fix.** In one transaction: take the same per-lease row lock manual payments use (`SELECT … FROM leases WHERE id = … FOR UPDATE`) first, re-read the bill **inside** the lock, return 200 if it is already `paid`, create exactly one payment, and keep `UNIQUE(gateway_bill_id)` as the last line of defence (handle its violation as "already paid").

## 5. High — logs the full callback and the valid signature (webhook, L374)

```ts
console.error('Invalid signature', { fields, expected })                  // L374
```
**Failure.** `expected` is the correct HMAC **for the attacker-supplied fields**. Anyone who can read the logs (log aggregator, support staff, a leaked log bucket) can submit a callback with the fields they want, read `expected` from the log, and resend it with that signature: a forged "paid" callback. The log line also stores payment/customer data from `fields`.
**Fix.** Never log the secret, the expected signature or the payload. Log only a constant reason and a request id.

## 6. High — payment amount comes from the callback (webhook, L391)

```ts
amountSen: BigInt(fields.paid_amount),                                    // L391
```
**Failure.** The amount is never compared with `bill.amount_sen`. A callback for a RM 10 bill with `paid_amount=99999999` (validly signed by a gateway fault or a leaked key) credits RM 999,999.99; a short payment settles the whole bill. `BigInt('abc')`, `BigInt('10.5')` or an empty value throws `SyntaxError` → 500 and endless gateway retries; zero or negative values reach the database.
**Fix.** Require `paid_amount` to equal the canonical string of `bill.amountSen` (otherwise 422, no changes) and create the payment from `bill.amountSen`.

## 7. High — fee creation is not idempotent and not serialized (late-fees, L332–350)

```ts
for (const invoice of lease.invoices) { ... fees.push(prisma.invoice.create(...)) }   // L332-L350
```
**Failure.** Nothing records that an invoice already received a late fee. Every POST (double-click, client retry, a scheduled job) creates another fee for every still-unpaid invoice, so the same arrears are charged repeatedly. Two concurrent POSTs both read the same state and both create fees; no per-lease lock is used.
**Fix.** Link each fee to its source invoice with a unique constraint (one fee per source invoice), or skip invoices that already have one, and do the read-and-create in one transaction under the per-lease lock.

## 8. High — lazy Prisma promises make `nextReference` return the same value (late-fees, L337–350, L354–357)

```ts
fees.push(prisma.invoice.create({ data: { ..., reference: await nextReference(lease.orgId) } }))   // L337-L349
await Promise.all(fees)                                                                              // L350
async function nextReference(orgId) { const last = await prisma.invoice.findFirst(...); return `INV-${...+ 1}` }   // L354-L357
```
**Failure.** Prisma queries are lazy: `prisma.invoice.create(...)` does not execute until it is awaited or `.then` is called, which happens only in `Promise.all` at L350. Every `await nextReference()` in the loop therefore sees the same "last" invoice, so all fees in one request get the **same reference** (a duplicate, or a unique-constraint failure that leaves some fees created). Two concurrent requests collide the same way. `Promise.all` is not a transaction, so one failure leaves a partial set. `parseInt(last.reference.slice(4))` yields `NaN` for any non-`INV-` reference.
**Fix.** Generate references atomically (a per-organization counter row updated with `UPDATE … RETURNING`, or a sequence) and create all fees inside a single `prisma.$transaction`.

## 9. High — collections use the database timezone (collections, L409, L412)

```sql
to_char(date_trunc('month', received_at), 'YYYY-MM')                                   -- L409
AND received_at >= ${from}::date AND received_at < ${to}::date + interval '1 month'    -- L412
```
**Failure.** `date_trunc` on a `timestamptz` and the `::date` bounds use the session timezone (normally UTC). A payment received at 2026-03-01 00:30 Malaysia time is 2026-02-28 16:30Z, so it is counted in **February** and falls outside a March report. The assessment requires Asia/Kuala_Lumpur month boundaries.
**Fix.** Key months on `received_at AT TIME ZONE 'Asia/Kuala_Lumpur'` and use explicit Malaysia bounds (`make_timestamptz(y, m, 1, 0, 0, 0, 'Asia/Kuala_Lumpur')`).

## 10. High — `late_fee`, `reference` and `createdAt` are not part of the invoice model (late-fees, L342, L345, L355–356)

**Failure.** The required invoice model has kinds `deposit` and `rent` only (`kind` is a CHECK-constrained enum), no `reference` and no `createdAt`. `orderBy: { createdAt: 'desc' }` (L355) makes Prisma throw, and even without it `kind: 'late_fee'` (L342) violates the CHECK; the endpoint returns 500 on the first qualifying invoice (after earlier fees may already have been created, see #8). If the constraints were loosened, `late_fee` rows would also break the invoice contract (`periodIndex`/`periodStart`/`periodEnd` rules, allocation order, schedule).
**Fix.** Model fees outside the invoice contract (a separate table added through a new SQL migration) or follow the rules for new invoice kinds; do not add columns/kinds ad hoc in code.

## 11. Medium — `paid=false` is ignored; unknown bills are not 404 (webhook, L377)

```ts
if (fields.paid !== 'true') return NextResponse.json({ ok: true })        // L377
```
**Failure.** A failure callback returns 200 before any bill lookup, so a pending bill never becomes `failed`, and a failure callback for an unknown bill id answers 200 instead of 404. The contract: `paid=false` on a pending bill → `failed`; on a failed bill → no change; on a paid bill → no change (paid is terminal); unknown bill → 404.
**Fix.** Look up the bill under the lock first, then branch on `paid`.

## 12. Medium — non-constant-time signature comparison (webhook, L373)

```ts
if (expected !== fields.x_signature) {                                    // L373
```
**Failure.** String `!==` returns at the first differing character, a timing side channel on the HMAC. A missing `x_signature` and a wrong-length value also flow through the same comparison without validation. The contract requires `timingSafeEqual` on lowercase hex.
**Fix.** Validate that the signature is 64 lowercase hex characters, then compare the two buffers with `crypto.timingSafeEqual` (equal lengths).

## 13. Medium — `receivedAt` is the server clock (webhook, L392)

```ts
receivedAt: new Date(),                                                   // L392
```
**Failure.** The payment's `received_at` must come from the gateway's `paid_at` (`YYYY-MM-DD HH:mm:ss +0800`). A delayed or retried callback is recorded at the wrong moment, and a payment made at 00:10 on the 1st can land in the wrong collections month.
**Fix.** Parse `paid_at` strictly with the `+0800` offset, reject anything else (400), store the UTC instant.

## 14. Medium — months without payments are missing (collections, L409, L413)

**Failure.** `GROUP BY 1` returns rows only for months that have payments. The report must return one entry per calendar month including zero months, so consumers get gaps (e.g. February missing between January and March).
**Fix.** Generate the month series (`generate_series` LEFT JOIN, or fill the gaps in code) and return `0` for empty months.

## 15. Medium — floating-point money and a 0.5 % free pass (late-fees, L335–336)

```ts
if (Number(paid) / Number(invoice.amountSen) >= 0.995) continue           // L335
const fee = Math.round((Number(invoice.amountSen - paid) * 2) / 100)      // L336
```
**Failure.** An invoice that is 99.5 % paid is skipped, so a tenant can leave up to 0.5 % unpaid (RM 7.50 of a RM 1,500 rent) without ever being charged. Money is converted to `Number`, which loses precision above 2^53 and breaks the "integer sen, no floating point" rule.
**Fix.** Use `bigint` sen throughout with an explicit, tested rounding rule (e.g. `(unpaid * 2n + 50n) / 100n`), and decide eligibility on `paid < amount`.

## 16. Medium — `unapplied_sen` is not set (webhook, L386–394)

**Failure.** `payments.unapplied_sen` is `NOT NULL` with no default. The `create` data (L386–394) omits it, so the insert fails and the whole transaction (including the bill update) rolls back; every paid callback ends in a 500. `allocate` cannot help because the row must already exist.
**Fix.** Create the payment with `unappliedSen: 0n` (or the full amount) and update it from the allocation result in the same transaction.

## 17. Low — unauthenticated requests get 403 (late-fees, L316–318)

**Failure.** If `getUser()` returns no user (or an error, which is ignored), `user?.user_metadata.role` is `undefined` and the handler answers 403. An unauthenticated request must be 401; clients cannot tell "log in again" from "not allowed".
**Fix.** Return 401 when there is no verified user; 403 only for an authenticated user without the role.

## 18. Low — unvalidated input becomes a 500 (late-fees L321–323, webhook L366, collections L407–412)

**Failure.** A non-UUID `leaseId` makes Prisma throw (500) instead of 404. `formData()` throws for a non-form body. In `getCollections`, `from`/`to` are interpolated into `::date` casts, so a bad string raises a database error, and there is no `from <= to` check or range cap (a very wide range scans the whole payments table).
**Fix.** Validate ids, content type and `YYYY-MM` ranges up front (400) and cap the range.
