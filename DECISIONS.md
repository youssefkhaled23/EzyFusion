# DECISIONS.md

Each answer is at most 150 words. Paths and line numbers refer to the repository as submitted (checked mechanically against the files).

## 1. Two `paid=true` callbacks arrive 5 ms apart

Both pass signature verification (`src/app/api/webhooks/gateway/route.ts:33`) and call `applyGatewayCallback` (`src/server/domain/gateway.ts:56`). The pre-lookup at `:66` only fetches the bill's lease id and decides nothing. Each opens a transaction (`:70`) whose first statement is `lockLease` (`:71`), a `SELECT … FOR UPDATE` on the lease row (`src/server/domain/payments.ts:16-17`). Callback A holds the lock; B waits. A re-reads the bill under the lock (`gateway.ts:72`), sees it unpaid, creates the single payment (`:89-91`) and marks the bill paid (`:96`). B resumes after A commits, re-reads (`:72`), sees `paid`, and returns at `:85` without writing. Backstop: `UNIQUE (gateway_bill_id)` (`supabase/migrations/20261020000100_schema.sql:118`), handled at `gateway.ts:102-105`. Proven by `tests/api/gateway.test.ts:370`.

## 2. Two staff record RM 800 and RM 700 concurrently, RM 1,000 remaining

Both requests resolve access (`src/server/domain/payments.ts:73`) and enter a transaction (`:86`). Its first statement, `lockLease` (`:87`, SQL at `:16-17`), is `SELECT … FOR UPDATE` on the lease row, so the second request waits. The winner (say RM 800) computes the maximum payable, remaining minus pending (`payments.ts:88-89`, `src/lib/allocation.ts:55`), which is RM 1,000; it passes the check at `payments.ts:90`, inserts a `pending_verification` payment (`payments.ts:92`) and commits. The loser then gets the lock, and `leaseState` now counts that payment in `pendingTotalSen` (`payments.ts:32`), so its maximum is RM 200 and RM 700 fails with HTTP 422 at `payments.ts:90`. The preventing lock is the PostgreSQL row lock on `public.leases`, shared by record, approve, reject, void and the webhook (`payments.ts:12-15`). Proven by `tests/api/concurrency-reports-slips.test.ts:19`.

## 3. Where code calculates "today" or converts between a calendar date and an instant

The business timezone is Asia/Kuala_Lumpur (UTC+8, no DST): due dates, overdue status and reports are Malaysian calendar concepts.

- Today / status: `src/lib/billing.ts:23,151-165`; `src/lib/malaysia.ts:9`, used at `src/server/domain/gateway.ts:19,25` and `src/server/domain/views.ts:76,112`.
- Gateway `paid_at` (+0800) → UTC: `malaysia.ts:18-27`, used at `gateway.ts:62`.
- Reports: `src/server/domain/reports.ts:16,28-33` (SQL `at time zone`).
- UI display/input: `src/lib/format-my.ts:25-44,59-60`; `src/components/lease/payment-form.tsx:42,64,103`.
- API instants need an explicit offset: `src/server/domain/convert.ts:20-23`.

Calendar dates have no timezone, so they map to UTC midnight: `convert.ts:16,18`, `scripts/seed.mts:108`, `src/lib/format.ts:59-60`; the picker uses local date parts (`src/lib/date.ts:13-22`). Instants are `timestamptz` (`schema.sql:109`).

## 4. Everything that bypasses RLS, and what enforces authorization

- **Prisma (database owner):** `src/server/prisma.ts:5,12`, reached through `getPrisma()` in every route and page. Authorization is explicit code: verified user (`src/server/http/auth.ts:24,37`, `src/server/http/session.ts:24`), then database roles from `src/server/domain/access.ts:23,26-35,37-44` and `viewer.ts:28-29`; role checks at `payments.ts:74,111,132,152`, `leases.ts:26-40`, `reports.ts:19-20,33`, `views.ts:42,68`, `gateway.ts:17-18,116`. The webhook relies on the HMAC (`route.ts:33`).
- **Service-role key:** `src/server/domain/slips.ts:57-59` (orphan-slip cleanup, own organization and unreferenced only, guarded by `src/app/actions/slips.ts:13-19`) and the seed (`scripts/seed.mts:70-79,139`).
- **SECURITY DEFINER:** only `private.org_role` (`supabase/migrations/20261020000300_rls_and_grants.sql:16-29`), not API-exposed, executable by `authenticated` only.

Browser clients stay under RLS.

## 5. A void reopens invoices while unapplied online money exists

`voidPayment` deletes only the voided payment's allocation rows (`src/server/domain/payments.ts:160`), zeroes its own `unapplied_sen` (`:161`) and keeps the row. An invoice's paid amount is always SUM(allocations), so those invoices reopen immediately. An online payment's `unapplied_sen` (set at `src/server/domain/gateway.ts:94-95`) is untouched, and nothing re-runs allocation: it happens only when a payment is recorded, approved or settled (`payments.ts:97,122`; `gateway.ts:94`). Rationale: voiding must not reallocate other payments (`payments.ts:147-148`); silent reallocation would rewrite history and make results depend on void order. The unapplied amount stays visible to the manager (`src/components/lease/payment-table.tsx:41`). Tests: `tests/api/payments.test.ts:189`, `tests/api/gateway.test.ts:460`.

## 6. Two real mistakes by the AI assistant

**Mistake 1: guessed payment enumerations.** The first schema used methods `cash|bank_transfer|gateway`, statuses `pending|approved|rejected` and a bill status `expired` (`supabase/migrations/20261020000100_schema.sql:95,107-108`). I noticed when I supplied the exact lists (`online`, `pending_verification`, `voided`, bill `failed`). It was fixed by a forward migration (`20261020000500_payment_exact_values.sql:8-20`) and updated tests. Log (`ai-logs/session-claude-code-d6f7b928.jsonl`, JSONL lines): 2240 schema written, 2431 exact values given, 2438 migration written.

**Mistake 2: seed without allocations.** The first seed inserted approved payments directly with `unapplied_sen = amount` and no `payment_allocations`; its own comment admitted allocation was missing. Once the shared domain existed, `scripts/seed.mts:107-143` was rewritten to call `createLease`, `recordPayment` and `approvePayment`. Log: line 2279 first seed, line 2500 replacement.
