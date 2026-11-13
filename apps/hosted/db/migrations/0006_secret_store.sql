-- 0006: secrets an organisation gives us (V-01): notification webhook URLs (X67) and chat signing
-- secrets (X69). The value lives in Supabase Vault (encrypted at rest); this schema keeps only a pointer.
-- Only the worker's role (service_role) reaches a value, and only through the three functions below.
-- Nobody signed in can select a value, a Vault row or the Vault id. Run as the schema owner ("postgres").
-- Never stored here: per-site CMS tokens and the GitHub App key (the customer's own CI and worker hold
-- them; docs/hosted/secrets.md).

-- Vault must be there. This migration does not create the extension: the owner enables supabase_vault on
-- the project first (docs/hosted/secrets.md), and the tests load a stand-in with the same names.
do $$
begin
  if pg_catalog.to_regprocedure('vault.create_secret(text, text, text, uuid)') is null
     or pg_catalog.to_regprocedure('vault.update_secret(uuid, text, text, text, uuid)') is null
     or pg_catalog.to_regclass('vault.decrypted_secrets') is null
     or pg_catalog.to_regclass('vault.secrets') is null then
    raise exception 'Supabase Vault is not enabled on this database (no vault.create_secret)'
      using hint = 'Enable the supabase_vault extension on the project (docs/hosted/secrets.md), then migrate again.';
  end if;
end
$$;

-- One row per secret: whose it is, its name and kind, and where Vault keeps it. Never the value.
create table private.secret_refs (
  org_id uuid not null references public.organisations (org_id) on delete cascade,
  name text not null check (name ~ '^[a-z][a-z0-9_.-]{0,62}$'),
  kind text not null check (kind in ('webhook_url', 'signing_secret')),
  vault_secret_id uuid not null unique,
  created_at timestamptz not null default now(),
  rotated_at timestamptz,
  primary key (org_id, name)
);

-- Who created, rotated or deleted which secret, when. Append-only, and kept after the organisation goes.
create table private.secret_events (
  id bigint generated always as identity primary key,
  org_id uuid not null,
  name text not null,
  kind text not null,
  action text not null check (action in ('created', 'rotated', 'deleted')),
  at timestamptz not null default now()
);
create trigger secret_events_append_only before update or delete on private.secret_events
  for each row execute function private.refuse_change();
create trigger secret_events_no_truncate before truncate on private.secret_events
  for each statement execute function private.refuse_change();

alter table private.secret_refs enable row level security;
alter table private.secret_events enable row level security;

-- A pointer row going away (delete_secret, or the organisation's cascade) takes the Vault row with it.
create function private.secret_refs_drop_vault() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  delete from vault.secrets s where s.id = old.vault_secret_id;
  insert into private.secret_events (org_id, name, kind, action)
    values (old.org_id, old.name, old.kind, 'deleted');
  return old;
end
$$;
create trigger secret_refs_drop_vault after delete on private.secret_refs
  for each row execute function private.secret_refs_drop_vault();

-- Store or replace a secret. Returns 'created' or 'rotated'. Errors name the problem, never the value.
create function private.put_secret(p_org uuid, p_name text, p_kind text, p_value text) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_ref private.secret_refs;
begin
  if p_name is null or p_name !~ '^[a-z][a-z0-9_.-]{0,62}$' then
    raise exception 'secret name must be 1 to 63 of a-z 0-9 _ . - starting with a letter'
      using errcode = '22023';
  end if;
  if p_kind is null or p_kind not in ('webhook_url', 'signing_secret') then
    raise exception 'secret kind must be webhook_url or signing_secret' using errcode = '22023';
  end if;
  if p_value is null or pg_catalog.octet_length(p_value) not between 1 and 4096 then
    raise exception 'secret value must be 1 to 4096 bytes' using errcode = '22023';
  end if;
  if not exists (select 1 from public.organisations o where o.org_id = p_org) then
    raise exception 'organisation not found' using errcode = '23503';
  end if;
  -- Two puts of one name at once: the second waits, then rotates what the first created.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('secret:' || p_org::text || ':' || p_name, 0));
  select * into v_ref from private.secret_refs r where r.org_id = p_org and r.name = p_name;
  if found then
    if v_ref.kind <> p_kind then
      raise exception 'a secret keeps its kind: delete it first' using errcode = '22023';
    end if;
    perform vault.update_secret(v_ref.vault_secret_id, p_value);
    update private.secret_refs r set rotated_at = now() where r.org_id = p_org and r.name = p_name;
    insert into private.secret_events (org_id, name, kind, action) values (p_org, p_name, p_kind, 'rotated');
    return 'rotated';
  end if;
  insert into private.secret_refs (org_id, name, kind, vault_secret_id)
    values (p_org, p_name, p_kind, vault.create_secret(p_value, null, 'gaugeline'));
  insert into private.secret_events (org_id, name, kind, action) values (p_org, p_name, p_kind, 'created');
  return 'created';
end
$$;

-- The value, or null when this organisation has no secret by that name.
create function private.get_secret(p_org uuid, p_name text) returns text
language sql stable security definer set search_path = ''
as $$
  select d.decrypted_secret from private.secret_refs r
  join vault.decrypted_secrets d on d.id = r.vault_secret_id
  where r.org_id = p_org and r.name = p_name
$$;

-- True when a secret was deleted, false when there was none.
create function private.delete_secret(p_org uuid, p_name text) returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  delete from private.secret_refs r where r.org_id = p_org and r.name = p_name;
  return found;
end
$$;

-- Grants. The functions: the worker's role only. The tables: nothing but the metadata columns, and for a
-- signed-in person only their own organisation's, when they are an owner or admin (a settings page can
-- say "Slack connected, rotated 3 days ago"). Nobody but the owner sees the Vault id.
revoke all on function private.put_secret(uuid, text, text, text), private.get_secret(uuid, text),
  private.delete_secret(uuid, text), private.secret_refs_drop_vault()
  from public, anon, authenticated, service_role, gaugeline_agent;
grant usage on schema private to service_role;
grant execute on function private.put_secret(uuid, text, text, text), private.get_secret(uuid, text),
  private.delete_secret(uuid, text) to service_role;

revoke all on private.secret_refs, private.secret_events
  from public, anon, authenticated, service_role, gaugeline_agent;
grant select (org_id, name, kind, created_at, rotated_at) on private.secret_refs
  to authenticated, service_role;
create policy secret_refs_select on private.secret_refs for select to authenticated
  using (org_id in (select private.admin_org_ids()));

-- Vault itself: only through the functions above. If the platform granted its API roles anything on
-- Vault, take it back. A role that cannot revoke (the objects belong to the platform) gets a warning,
-- not a failed deploy; docs/hosted/secrets.md lists the check to run on a real project.
do $$
begin
  revoke all on all tables in schema vault from anon, authenticated, service_role;
  revoke all on function vault.create_secret(text, text, text, uuid),
    vault.update_secret(uuid, text, text, text, uuid) from anon, authenticated, service_role;
  revoke usage on schema vault from anon, authenticated, service_role;
exception when insufficient_privilege then
  raise warning 'could not revoke Vault privileges from the API roles: check them by hand (docs/hosted/secrets.md)';
end
$$;
