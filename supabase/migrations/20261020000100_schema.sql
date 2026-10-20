-- EzyFusion core schema. Supabase SQL migrations are the ONLY source of schema changes (never Prisma Migrate).
--
-- Conventions
--   money            bigint, integer sen (never float / numeric)
--   calendar dates   date            (lease dates, period dates, due dates)
--   instants         timestamptz     (received_at, created_at)
--   tenancy          every org-owned row carries org_id; cross-organization references are made impossible
--                    by composite foreign keys (child_id, org_id) -> parent (id, org_id).
--   enumerations     text + CHECK (portable and easy to evolve in SQL migrations)

create extension if not exists btree_gist with schema extensions;

-- ---------------------------------------------------------------------------------------------------------------------
create table public.organizations (
  id   uuid primary key default gen_random_uuid(),
  name text not null check (btrim(name) <> '')
);

create table public.memberships (
  user_id uuid not null references auth.users (id) on delete cascade,
  org_id  uuid not null references public.organizations (id),
  role    text not null check (role in ('manager', 'staff')),
  primary key (user_id, org_id)
);
create index memberships_org_id_idx on public.memberships (org_id);

create table public.units (
  id     uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),
  name   text not null check (btrim(name) <> ''),
  unique (id, org_id),    -- target of composite foreign keys
  unique (org_id, name)
);

create table public.tenants (
  id        uuid primary key default gen_random_uuid(),
  org_id    uuid not null references public.organizations (id),
  user_id   uuid references auth.users (id) on delete set null,
  full_name text not null check (btrim(full_name) <> ''),
  email     text not null check (position('@' in email) > 1),
  phone     text check (phone is null or char_length(phone) between 1 and 32),
  unique (id, org_id),
  unique (org_id, email),
  unique (org_id, user_id)
);
create index tenants_user_id_idx on public.tenants (user_id);

create table public.leases (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations (id),
  unit_id          uuid not null,
  tenant_id        uuid not null,
  start_date       date not null,
  end_date         date not null,
  monthly_rent_sen bigint not null check (monthly_rent_sen > 0),
  deposit_sen      bigint not null default 0 check (deposit_sen >= 0),
  constraint leases_dates_check check (end_date >= start_date),
  constraint leases_unit_org_fk   foreign key (unit_id, org_id)   references public.units (id, org_id),
  constraint leases_tenant_org_fk foreign key (tenant_id, org_id) references public.tenants (id, org_id),
  unique (id, org_id),
  -- a unit cannot be leased to two leases for overlapping (inclusive) date ranges
  constraint leases_unit_no_overlap exclude using gist (unit_id with =, daterange(start_date, end_date, '[]') with &&)
);
create index leases_org_id_idx    on public.leases (org_id);
create index leases_tenant_id_idx on public.leases (tenant_id);
create index leases_unit_id_idx   on public.leases (unit_id);

create table public.invoices (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations (id),
  lease_id     uuid not null,
  kind         text not null check (kind in ('deposit', 'rent')),
  period_index integer,
  period_start date,
  period_end   date,
  due_date     date not null,
  amount_sen   bigint not null check (amount_sen >= 0),
  constraint invoices_lease_org_fk foreign key (lease_id, org_id) references public.leases (id, org_id),
  constraint invoices_kind_shape_check check (
    (kind = 'deposit' and period_index is null and period_start is null and period_end is null)
    or
    (kind = 'rent' and period_index >= 0 and period_start is not null and period_end is not null and period_end >= period_start)
  ),
  unique (id, org_id),
  unique (lease_id, period_index)              -- one rent invoice per period (deposit rows have NULL index)
);
create unique index invoices_one_deposit_per_lease on public.invoices (lease_id) where kind = 'deposit';
create index invoices_org_due_idx on public.invoices (org_id, due_date);

create table public.gateway_bills (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations (id),
  lease_id   uuid not null,
  amount_sen bigint not null check (amount_sen > 0),
  status     text not null check (status in ('pending', 'paid', 'failed', 'expired')),
  constraint gateway_bills_lease_org_fk foreign key (lease_id, org_id) references public.leases (id, org_id),
  unique (id, org_id)
);
create index gateway_bills_lease_id_idx on public.gateway_bills (lease_id);

create table public.payments (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations (id),
  lease_id        uuid not null,
  amount_sen      bigint not null check (amount_sen > 0),
  unapplied_sen   bigint not null check (unapplied_sen >= 0),
  method          text not null check (method in ('cash', 'bank_transfer', 'gateway')),
  status          text not null check (status in ('pending', 'approved', 'rejected')),
  received_at     timestamptz not null,
  slip_path       text,
  gateway_bill_id uuid,
  constraint payments_unapplied_within_amount check (unapplied_sen <= amount_sen),
  -- slips live under "<org_id>/..." in the private payment-slips bucket
  constraint payments_slip_path_org_prefix check (slip_path is null or slip_path like org_id::text || '/%'),
  constraint payments_lease_org_fk        foreign key (lease_id, org_id)        references public.leases (id, org_id),
  constraint payments_gateway_bill_org_fk foreign key (gateway_bill_id, org_id) references public.gateway_bills (id, org_id),
  unique (id, org_id),
  unique (gateway_bill_id)                       -- a bill settles at most one payment
);
create index payments_lease_id_idx on public.payments (lease_id);
create index payments_org_received_idx on public.payments (org_id, received_at);

create table public.payment_allocations (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations (id),
  payment_id uuid not null,
  invoice_id uuid not null,
  amount_sen bigint not null check (amount_sen > 0),
  constraint payment_allocations_payment_org_fk foreign key (payment_id, org_id) references public.payments (id, org_id),
  constraint payment_allocations_invoice_org_fk foreign key (invoice_id, org_id) references public.invoices (id, org_id),
  unique (payment_id, invoice_id)
);
create index payment_allocations_invoice_id_idx on public.payment_allocations (invoice_id);

-- actor_id has no foreign key on purpose: audit rows must survive deletion of users (and the table is append-only).
create table public.audit_log (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations (id),
  actor_id   uuid,
  action     text not null check (btrim(action) <> ''),
  entity_id  uuid,
  details    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_log_org_created_idx on public.audit_log (org_id, created_at);
