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

create function private.client_site_ids() returns setof uuid
language sql stable security definer set search_path = ''
as $$ select m.site_id from public.members m
      where m.user_id = (select auth.uid()) and m.role = 'client' $$;

revoke all on all functions in schema private from public, anon, authenticated, service_role;
grant usage on schema private to authenticated;
grant execute on function private.member_org_ids(), private.staff_org_ids(),
  private.admin_org_ids(), private.client_site_ids() to authenticated;

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

-- members: you see your own rows; staff see their organisation; owners and admins manage it.
create policy members_select on public.members for select to authenticated
  using (user_id = (select auth.uid()) or org_id in (select private.staff_org_ids()));
create policy members_insert on public.members for insert to authenticated
  with check (org_id in (select private.admin_org_ids()));
create policy members_update on public.members for update to authenticated
  using (org_id in (select private.admin_org_ids()))
  with check (org_id in (select private.admin_org_ids()));
create policy members_delete on public.members for delete to authenticated
  using (org_id in (select private.admin_org_ids()));

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

-- runs and findings: read like sites; staff may insert for their organisation (uploads normally come
-- through the API as service_role, G35). History is never edited by a person.
create policy runs_select on public.runs for select to authenticated
  using (org_id in (select private.staff_org_ids()) or site_id in (select private.client_site_ids()));
create policy runs_insert on public.runs for insert to authenticated
  with check (org_id in (select private.staff_org_ids()));
create policy findings_select on public.findings for select to authenticated
  using (org_id in (select private.staff_org_ids()) or site_id in (select private.client_site_ids()));
create policy findings_insert on public.findings for insert to authenticated
  with check (org_id in (select private.staff_org_ids()));

-- drafts: staff only; a client viewer does not see proposed changes.
create policy drafts_select on public.drafts for select to authenticated
  using (org_id in (select private.staff_org_ids()));
create policy drafts_insert on public.drafts for insert to authenticated
  with check (org_id in (select private.staff_org_ids()));

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
revoke all on all tables in schema public from public, anon, authenticated, service_role;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;

grant select on public.organisations, public.members, public.sites, public.runs, public.findings,
  public.drafts, public.decisions, public.site_consents to authenticated;
grant update (name) on public.organisations to authenticated;
grant insert, update, delete on public.members, public.sites to authenticated;
grant insert on public.runs, public.findings, public.drafts, public.decisions, public.site_consents
  to authenticated;

grant select, insert, update, delete on public.organisations, public.members, public.sites,
  public.runs, public.findings, public.drafts to service_role;
grant select, insert on public.decisions, public.site_consents to service_role;

-- Append-only: decisions and site_consents. The grants above already leave out UPDATE and DELETE; the
-- trigger refuses them for every role, the table owner and the service role included, and TRUNCATE too.
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

grant select on public.draft_state, public.site_consent_current to authenticated, service_role;
