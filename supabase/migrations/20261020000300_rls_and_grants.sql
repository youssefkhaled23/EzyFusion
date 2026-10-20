-- Row Level Security and privileges for the Supabase Data API (PostgREST).
--
-- Principles
--   * RLS is enabled on EVERY public table. The anonymous role gets no privileges and no policies.
--   * Roles come from public.memberships (staff / manager) and public.tenants.user_id (tenant). NEVER from user_metadata.
--   * Nobody can INSERT or DELETE through the Data API. The only UPDATE is a tenant changing their own phone,
--     enforced twice: a column-level UPDATE grant (phone only) AND an RLS policy (own row only).
--   * Writes happen server-side (Prisma as the database owner, which bypasses RLS and therefore needs its own
--     application-level authorization).
--   * The only SECURITY DEFINER code is private.org_role(), in a schema that PostgREST does not expose, executable
--     by `authenticated` only. It exists to avoid infinite RLS recursion when policies on memberships need
--     memberships.

-- ---- helper (not exposed through the API) ---------------------------------------------------------------------------------
-- Role of the calling user in an organization: 'manager', 'staff' or NULL. auth.uid() comes from the verified JWT.
create function private.org_role(p_org_id uuid) returns text
language sql
stable
security definer
set search_path = ''
as $$
  select m.role
  from public.memberships m
  where m.user_id = (select auth.uid()) and m.org_id = p_org_id
  limit 1
$$;
revoke all on function private.org_role(uuid) from public, anon;
grant usage on schema private to authenticated;
grant execute on function private.org_role(uuid) to authenticated;

-- ---- default privileges: new objects get nothing for API roles ---------------------------------------------------------------
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke execute on functions from public, anon, authenticated;
alter default privileges for role postgres in schema private revoke execute on functions from public, anon, authenticated;

-- ---- table privileges -------------------------------------------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;

grant select on
  public.organizations, public.memberships, public.units, public.tenants, public.leases, public.invoices,
  public.payments, public.payment_allocations, public.gateway_bills, public.audit_log
to authenticated;

-- The one permitted write through the Data API: a tenant's own phone number.
grant update (phone) on public.tenants to authenticated;

-- ---- enable RLS everywhere ----------------------------------------------------------------------------------------------------------
alter table public.organizations       enable row level security;
alter table public.memberships         enable row level security;
alter table public.units               enable row level security;
alter table public.tenants             enable row level security;
alter table public.leases              enable row level security;
alter table public.invoices            enable row level security;
alter table public.payments            enable row level security;
alter table public.payment_allocations enable row level security;
alter table public.gateway_bills       enable row level security;
alter table public.audit_log           enable row level security;

-- ---- policies (all TO authenticated; there is deliberately no policy for anon) -------------------------------------------------
-- "staff of this org" = private.org_role(org_id) is not null (memberships only hold 'manager' and 'staff').
-- "tenant of this lease" = tenants.user_id = auth.uid() through leases.tenant_id.

create policy organizations_select on public.organizations for select to authenticated
using (
  private.org_role(id) is not null
  or exists (select 1 from public.tenants t where t.org_id = organizations.id and t.user_id = (select auth.uid()))
);

create policy memberships_select on public.memberships for select to authenticated
using (private.org_role(org_id) is not null);

create policy units_select on public.units for select to authenticated
using (
  private.org_role(org_id) is not null
  or exists (
    select 1 from public.leases l join public.tenants t on t.id = l.tenant_id
    where l.unit_id = units.id and t.user_id = (select auth.uid())
  )
);

create policy tenants_select on public.tenants for select to authenticated
using (private.org_role(org_id) is not null or user_id = (select auth.uid()));

create policy tenants_update_own_phone on public.tenants for update to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

create policy leases_select on public.leases for select to authenticated
using (
  private.org_role(org_id) is not null
  or exists (select 1 from public.tenants t where t.id = leases.tenant_id and t.user_id = (select auth.uid()))
);

create policy invoices_select on public.invoices for select to authenticated
using (
  private.org_role(org_id) is not null
  or exists (
    select 1 from public.leases l join public.tenants t on t.id = l.tenant_id
    where l.id = invoices.lease_id and t.user_id = (select auth.uid())
  )
);

create policy payments_select on public.payments for select to authenticated
using (
  private.org_role(org_id) is not null
  or exists (
    select 1 from public.leases l join public.tenants t on t.id = l.tenant_id
    where l.id = payments.lease_id and t.user_id = (select auth.uid())
  )
);

create policy payment_allocations_select on public.payment_allocations for select to authenticated
using (
  private.org_role(org_id) is not null
  or exists (
    select 1
    from public.payments p
    join public.leases l on l.id = p.lease_id
    join public.tenants t on t.id = l.tenant_id
    where p.id = payment_allocations.payment_id and t.user_id = (select auth.uid())
  )
);

create policy gateway_bills_select on public.gateway_bills for select to authenticated
using (
  private.org_role(org_id) is not null
  or exists (
    select 1 from public.leases l join public.tenants t on t.id = l.tenant_id
    where l.id = gateway_bills.lease_id and t.user_id = (select auth.uid())
  )
);

-- audit_log: managers of the organization only.
create policy audit_log_select on public.audit_log for select to authenticated
using (private.org_role(org_id) = 'manager');
