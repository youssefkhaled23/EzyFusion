-- Forward migration (earlier migrations are NOT rewritten): the assessment's exact enumerations.
--   payments.method          cash | bank_transfer | online
--   payments.status          pending_verification | approved | rejected | voided
--   gateway_bills.status     pending | paid | failed
-- plus: manual payments never carry unapplied funds (only online payments may).

alter table public.payments
  drop constraint payments_method_check,
  drop constraint payments_status_check;

alter table public.payments
  add constraint payments_method_check check (method in ('cash', 'bank_transfer', 'online')),
  add constraint payments_status_check check (status in ('pending_verification', 'approved', 'rejected', 'voided')),
  add constraint payments_manual_no_unapplied check (method = 'online' or unapplied_sen = 0);

alter table public.gateway_bills
  drop constraint gateway_bills_status_check;

alter table public.gateway_bills
  add constraint gateway_bills_status_check check (status in ('pending', 'paid', 'failed'));

-- A payment slip object can back at most one payment (also makes "referenced slip" checks race-free).
create unique index payments_slip_path_key on public.payments (slip_path) where slip_path is not null;
