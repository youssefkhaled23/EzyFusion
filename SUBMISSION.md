# Submission summary

**Test account:** `manager@northwind.test`. Every seeded account shares the password `Passw0rd!local` (see `.env.example`, `SEED_PASSWORD`). All other accounts are listed in `README.md`.

**Environment variables:** the local values are in `.env.example` (copy to `.env.local`): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `DATABASE_URL`, `DIRECT_URL`, `GATEWAY_X_SIGNATURE_KEY`, `SEED_PASSWORD`. The Supabase values are the local stack's public defaults.

## What works
- **Billing (`src/lib/billing.ts`):** `generateSchedule`, `invoiceStatus`, `parseRinggitToSen`; pure and timezone independent; 55 direct tests, run under UTC, Asia/Kuala_Lumpur and America/New_York.
- **Access control:** RLS on every table with the required Data API matrix, anonymous access denied, append-only `audit_log` (triggers), private `payment-slips` bucket with organization-scoped policies and signed URLs. Server code authenticates with `getUser()` (Bearer token or cookie), roles come from `memberships` / `tenants.user_id`, 401/403/404 as specified.
- **Payments:** record (manager approved immediately, staff pending), cap, approve with re-check, reject, void, allocation order, collections report, slip cleanup on failure. A per-lease row lock keeps concurrent requests correct.
- **Webhook:** HMAC-SHA256 signature, every response in the brief's table, idempotent and concurrency-safe (one payment per bill, ever), no secrets or payloads logged. `gateway-sim.mjs` included.
- **Online payment:** Pay now creates an unguessable (UUID) bill; `/payments/return` only displays the stored status.
- **UI:** dark dashboard (overdue count, six-month collections chart), leases list, lease detail, payment form with slip upload, manager approve/reject/void with reasons, create-lease form, tenant portal with Pay now and phone editing. Malaysia time everywhere, without hydration warnings.
- **Seed:** creates exactly the specified data through the real lease and payment code.
- **Part B / Part C:** `REVIEW.md` (18 findings) and `DECISIONS.md` (6 answers, each at most 150 words, with checked citations).

## What does not work / known gaps
- No UI to create tenants or units; no registration or password reset.
- No rate limiting; cookie-authenticated API calls do not refresh expired tokens.
- The create-lease form has no live schedule preview.
- No realtime updates on the tenant portal, and no search or pagination on the leases list.
- `REVIEW.md` line numbers are mapped from the line ranges given for the three snippets; they could not be checked against the original numbered file.
- Some tests depend on today's Malaysia date, and the browser tests need Google Chrome.

## What was skipped
The optional bonus items listed above (live preview, realtime, search and pagination). Everything else in the brief was implemented.

See `README.md` for setup, tests and next steps.
