-- 0002: tenancy enforced by the database (G34).
--
-- Roles (Supabase's own; a stand-in creates them in tests):
--   anon           not signed in: no access to any table
--   authenticated  a signed-in person: row-level security limits every row to their organisations,
--                  and a client viewer to their one site, read-only
--   service_role   the server and the worker: bypasses row-level security, but decisions and
--                  site_consents are still insert-and-read only, and a trigger refuses any change
-- Run as the schema owner ("postgres" on Supabase).

-- Helpers the policies call. SECURITY DEFINER so a policy on members can read members without
-- recursing into its own policy; search_path is empty so nothing can be substituted for a table.
create schema if not exists private;
revoke all on schema private from public;

create function private.member_org_ids() returns setof uuid
language sql stable security definer set search_path = ''
as $$ select m.org_id from public.members m where m.user_id = (select auth.uid()) $$;

create function private.staff_org_ids() returns setof uuid
language sql stable security definer set search_path = ''
as $$ select m.org_id from public.members m
      where m.user_id = (select auth.uid()) and m.role in ('owner', 'admin', 'member') $$;

create function private.admin_org_ids() returns setof uuid
language sql stable security definer set search_path = ''
as $$ select m.org_id from public.members m
      where m.user_id = (select auth.uid()) and m.role in ('owner', 'admin') $$;

create function private.owner_org_ids() returns setof uuid
language sql stable security definer set search_path = ''
as $$ select m.org_id from public.members m
      where m.user_id = (select auth.uid()) and m.role = 'owner' $$;

create function private.client_site_ids() returns setof uuid
language sql stable security definer set search_path = ''
as $$ select m.site_id from public.members m
      where m.user_id = (select auth.uid()) and m.role = 'client' $$;

revoke all on all functions in schema private from public, anon, authenticated, service_role;
grant usage on schema private to authenticated;
grant execute on function private.member_org_ids(), private.staff_org_ids(),
  private.admin_org_ids(), private.owner_org_ids(), private.client_site_ids() to authenticated;

-- Row-level security on every table. A table without it is a test failure (db/audit.ts).
alter table public.organisations enable row level security;
alter table public.members enable row level security;
alter table public.sites enable row level security;
alter table public.runs enable row level security;
alter table public.findings enable row level security;
alter table public.drafts enable row level security;
alter table public.decisions enable row level security;
alter table public.site_consents enable row level security;

-- organisations: members read their own; owners and admins rename. Created by the server (service_role).
create policy organisations_select on public.organisations for select to authenticated
  using (org_id in (select private.member_org_ids()));
create policy organisations_update on public.organisations for update to authenticated
  using (org_id in (select private.admin_org_ids()))
  with check (org_id in (select private.admin_org_ids()));

-- members: you see your own rows; staff see their organisation; owners and admins manage it. Only an
-- owner adds, changes or removes an owner row (an admin cannot promote anyone, themselves included, nor
-- remove an owner); the trigger further down keeps at least one owner.
create policy members_select on public.members for select to authenticated
  using (user_id = (select auth.uid()) or org_id in (select private.staff_org_ids()));
create policy members_insert on public.members for insert to authenticated
  with check (org_id in (select private.admin_org_ids())
    and (role <> 'owner' or org_id in (select private.owner_org_ids())));
create policy members_update on public.members for update to authenticated
  using (org_id in (select private.admin_org_ids())
    and (role <> 'owner' or org_id in (select private.owner_org_ids())))
  with check (org_id in (select private.admin_org_ids())
    and (role <> 'owner' or org_id in (select private.owner_org_ids())));
create policy members_delete on public.members for delete to authenticated
  using (org_id in (select private.admin_org_ids())
    and (role <> 'owner' or org_id in (select private.owner_org_ids())));

-- sites: staff see their organisation's; a client viewer sees their one site; owners and admins manage.
create policy sites_select on public.sites for select to authenticated
  using (org_id in (select private.staff_org_ids()) or id in (select private.client_site_ids()));
create policy sites_insert on public.sites for insert to authenticated
  with check (org_id in (select private.admin_org_ids()));
create policy sites_update on public.sites for update to authenticated
  using (org_id in (select private.admin_org_ids()))
  with check (org_id in (select private.admin_org_ids()));
create policy sites_delete on public.sites for delete to authenticated
  using (org_id in (select private.admin_org_ids()));

-- runs and findings: read like sites. Nobody signed in writes them: runs arrive through the runs API
-- with a per-site token and are inserted by the server as service_role (G35), so a person cannot
-- invent a run or a finding.
create policy runs_select on public.runs for select to authenticated
  using (org_id in (select private.staff_org_ids()) or site_id in (select private.client_site_ids()));
create policy findings_select on public.findings for select to authenticated
  using (org_id in (select private.staff_org_ids()) or site_id in (select private.client_site_ids()));

-- drafts: staff only; a client viewer does not see proposed changes.
create policy drafts_select on public.drafts for select to authenticated
  using (org_id in (select private.staff_org_ids()));
create policy drafts_insert on public.drafts for insert to authenticated
  with check (org_id in (select private.staff_org_ids()) and created_by = (select auth.uid()));

-- decisions: staff read and decide, and only in their own name.
create policy decisions_select on public.decisions for select to authenticated
  using (org_id in (select private.staff_org_ids()));
create policy decisions_insert on public.decisions for insert to authenticated
  with check (org_id in (select private.staff_org_ids()) and decided_by = (select auth.uid()));

-- site_consents: staff and the site's client viewer read; owners and admins record, in their own name.
create policy site_consents_select on public.site_consents for select to authenticated
  using (org_id in (select private.staff_org_ids()) or site_id in (select private.client_site_ids()));
create policy site_consents_insert on public.site_consents for insert to authenticated
  with check (org_id in (select private.admin_org_ids()) and recorded_by = (select auth.uid()));

-- Grants. A Supabase project grants every new table in public to anon and authenticated by default;
-- take all of that back, then grant exactly what the policies above expect.
-- The same goes for sequences: nobody but the owner may call nextval or setval on the shared identity
-- sequences (inserting into an identity column does not need a sequence privilege).
-- Note: ALTER DEFAULT PRIVILEGES without FOR ROLE changes only objects the running role creates later.
revoke all on all tables in schema public from public, anon, authenticated, service_role;
revoke all on all sequences in schema public from public, anon, authenticated, service_role;
alter default privileges in schema public revoke all on tables from anon, authenticated, service_role;
alter default privileges in schema public revoke all on sequences from anon, authenticated, service_role;
alter default privileges in schema public revoke all on functions from anon, authenticated, service_role;

grant select on public.organisations, public.members, public.sites, public.runs, public.findings,
  public.drafts, public.decisions, public.site_consents to authenticated;
grant update (name) on public.organisations to authenticated;
grant insert, update, delete on public.members, public.sites to authenticated;

-- The logs: INSERT on named columns only. id and the time column are left out, so nobody but the
-- owner chooses an id (OVERRIDING SYSTEM VALUE) or backdates a row: the log's order is the order rows
-- arrived, and the views' "latest" (highest id) cannot be forged.
grant insert (org_id, site_id, kind, payload, finding_ids, created_by) on public.drafts
  to authenticated, service_role;
grant insert (org_id, draft_id, decision, edited_payload, reason, decided_by) on public.decisions
  to authenticated, service_role;
grant insert (org_id, site_id, action, wording_version, recorded_by) on public.site_consents
  to authenticated, service_role;

grant select, insert, update, delete on public.organisations, public.members, public.sites,
  public.runs, public.findings to service_role;
grant select on public.drafts, public.decisions, public.site_consents to service_role;

-- Append-only: drafts, decisions and site_consents. The grants above leave out UPDATE and DELETE; the
-- trigger also refuses UPDATE, DELETE and TRUNCATE for roles that do hold them. A draft never changes
-- after it is written, so an approval always refers to the payload that was shown; an edit is a decision
-- of kind "edited" carrying the new payload.
-- Limit: the table owner ("postgres" on Supabase) can still disable or drop these triggers, and a
-- superuser can set session_replication_role = replica. That is why migrations are applied only after
-- review and the owner role is never used by the app (db/audit.ts connectionSkipsRls).
create function private.refuse_change() returns trigger
language plpgsql set search_path = ''
as $$
begin
  raise exception '% is append-only: % is not allowed', tg_table_name, tg_op
    using hint = 'Insert a new row instead (a later decision, a withdrawal).';
end
$$;
revoke all on function private.refuse_change() from public;

create trigger decisions_append_only before update or delete on public.decisions
  for each row execute function private.refuse_change();
create trigger decisions_no_truncate before truncate on public.decisions
  for each statement execute function private.refuse_change();
create trigger drafts_append_only before update or delete on public.drafts
  for each row execute function private.refuse_change();
create trigger drafts_no_truncate before truncate on public.drafts
  for each statement execute function private.refuse_change();
create trigger site_consents_append_only before update or delete on public.site_consents
  for each row execute function private.refuse_change();
create trigger site_consents_no_truncate before truncate on public.site_consents
  for each statement execute function private.refuse_change();

-- Current state is a query over the log. security_invoker: the view reads as the caller, so the
-- policies above still apply (a view normally runs with its owner's rights and would skip them).
create view public.draft_state with (security_invoker = true) as
  select d.id as draft_id, d.org_id, d.site_id,
    coalesce(last.decision, 'pending') as decision, last.decided_by, last.decided_at
  from public.drafts d
  left join lateral (
    select x.decision, x.decided_by, x.decided_at from public.decisions x
    where x.draft_id = d.id order by x.id desc limit 1
  ) last on true;

create view public.site_consent_current with (security_invoker = true) as
  select site_id, org_id, wording_version, recorded_by, recorded_at
  from (
    select distinct on (c.site_id) c.* from public.site_consents c order by c.site_id, c.id desc
  ) latest
  where action = 'granted';

revoke all on public.draft_state, public.site_consent_current
  from public, anon, authenticated, service_role;
grant select on public.draft_state, public.site_consent_current to authenticated, service_role;

-- Every organisation keeps at least one owner. Runs as the owner of the function so it sees every
-- member row; skipped when the organisation itself is being deleted. The organisation row is written
-- before counting, so concurrent removals of two different owners cannot both pass at any isolation level.
create function private.keep_an_owner() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if old.role <> 'owner' or (tg_op = 'UPDATE' and new.role = 'owner' and new.org_id = old.org_id) then
    return coalesce(new, old);
  end if;
  -- Write the organisation row (a no-op update) before counting, so two sessions removing two
  -- different owners at once conflict on it. READ COMMITTED: the second waits, then counts after the
  -- first has committed and fails with "last owner". REPEATABLE READ or SERIALIZABLE: the second fails
  -- with a serialization error. The update takes FOR NO KEY UPDATE, which does not block foreign-key
  -- checks (FOR KEY SHARE) from other writes to the organisation. organisations has no triggers.
  -- No row means the organisation itself is being deleted (a cascade), which is allowed.
  update public.organisations o set name = o.name where o.org_id = old.org_id;
  if not found then
    return coalesce(new, old);
  end if;
  if not exists (select 1 from public.members m
                 where m.org_id = old.org_id and m.role = 'owner' and m.user_id <> old.user_id)
  then
    raise exception 'the last owner of an organisation cannot leave or step down'
      using hint = 'Make another member an owner first.';
  end if;
  return coalesce(new, old);
end
$$;
revoke all on function private.keep_an_owner() from public;

create trigger members_keep_an_owner before update or delete on public.members
  for each row execute function private.keep_an_owner();
