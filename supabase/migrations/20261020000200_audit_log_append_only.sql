-- audit_log is append-only for EVERYONE, including the service role and the database owner.
-- Triggers fire regardless of BYPASSRLS / table ownership, so this holds even for Prisma's owner connection.
-- Limit: a superuser (or anyone able to ALTER TABLE ... DISABLE TRIGGER / DROP TRIGGER as the table owner)
-- can still remove the guard through DDL; that is a schema change, reviewed like any other migration.

create schema if not exists private;
revoke all on schema private from public;

create function private.reject_audit_log_change() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'audit_log is append-only: % is not allowed', tg_op
    using errcode = 'insufficient_privilege',
          hint = 'Insert a new audit_log row instead of changing history.';
end;
$$;
revoke all on function private.reject_audit_log_change() from public;

create trigger audit_log_no_update_delete
  before update or delete on public.audit_log
  for each row execute function private.reject_audit_log_change();

create trigger audit_log_no_truncate
  before truncate on public.audit_log
  for each statement execute function private.reject_audit_log_change();

-- Defence in depth: nobody except the owner even holds the privileges (the triggers still cover the owner).
revoke update, delete, truncate on public.audit_log from public, anon, authenticated, service_role;
