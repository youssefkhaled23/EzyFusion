-- Private bucket for payment slips. Object paths must start with "<org_id>/".
-- Only staff and managers of that organization may upload, list, read or create signed URLs.
-- Tenants, anonymous users and other organizations get nothing. There are no UPDATE/DELETE policies: slips are immutable.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('payment-slips', 'payment-slips', false, 5242880, array['image/jpeg', 'image/png', 'application/pdf'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- First path segment as an organization id, or NULL when it is not a UUID (so a malformed path never raises).
create function private.slip_org_id(p_name text) returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when split_part(p_name, '/', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and position('/' in p_name) > 0
    then split_part(p_name, '/', 1)::uuid
  end
$$;
revoke all on function private.slip_org_id(text) from public, anon;
grant execute on function private.slip_org_id(text) to authenticated;

create policy payment_slips_insert on storage.objects for insert to authenticated
with check (
  bucket_id = 'payment-slips'
  and private.org_role(private.slip_org_id(name)) in ('manager', 'staff')
);

-- SELECT covers download, listing and signed-URL creation.
create policy payment_slips_select on storage.objects for select to authenticated
using (
  bucket_id = 'payment-slips'
  and private.org_role(private.slip_org_id(name)) in ('manager', 'staff')
);
