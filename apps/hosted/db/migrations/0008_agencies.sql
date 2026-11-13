-- Agencies (X66): sites grouped by client, invites as data, and the weekly client update with its send record.
-- Run as the schema owner ("postgres" on Supabase). The file takes the next free number when it merges (the
-- migrator refuses gaps and repeats), so nothing else refers to it by number.
--
-- Tenancy, in one place:
--   clients, weekly_updates      staff of the organisation only (owner, admin, member)
--   invites                      owners and admins of the organisation only; the token hash is never readable
--   weekly_update_sends          staff, and a client viewer when every site the update covers is their site
-- A client viewer is still bound to one site (members, 0001); nothing here widens what they can read.

-- A client of the agency: one business, which may have several sites. A site belongs to at most one client.
create table public.clients (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organisations (org_id) on delete cascade,
  name text not null check (length(name) between 1 and 200),
  created_at timestamptz not null default now(),
  unique (id, org_id),
  unique (org_id, name)
);

-- The composite key keeps a site and its client in one organisation. A client with sites cannot be deleted:
-- move its sites first, so no site is grouped under a client that has gone.
alter table public.sites add column client_id uuid;
alter table public.sites add constraint sites_client_fk
  foreign key (client_id, org_id) references public.clients (id, org_id) on delete restrict;
create index sites_client_idx on public.sites (client_id);

-- An invitation into an organisation, as data: the app shows the link once and nothing here sends an email.
-- The token is never stored, only its SHA-256. A client invite names the one site the viewer will see.
create table public.invites (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organisations (org_id) on delete cascade,
  email text not null check (length(email) between 3 and 320 and email = lower(email)
    and email ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  role text not null check (role in ('owner', 'admin', 'member', 'client')),
  site_id uuid,
  invited_by uuid not null,
  token_sha256 text not null unique check (token_sha256 ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null default now() + interval '7 days',
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  accepted_by uuid,
  accepted_at timestamptz,
  foreign key (site_id, org_id) references public.sites (id, org_id) on delete cascade,
  check ((role = 'client') = (site_id is not null)),
  check ((accepted_by is null) = (accepted_at is null))
);
create index invites_org_idx on public.invites (org_id, created_at desc);

-- The weekly update drafted for one client (Friday, from that week's runs). The text is the draft the
-- agency approves in the inbox (G37, kind "email"); site_ids is the snapshot of the client's sites that
-- week, so moving a site to another client later does not move its old updates. Append-only.
create table public.weekly_updates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  client_id uuid not null,
  week_start date not null check (extract(isodow from week_start) = 1),
  -- Never empty: an empty array is contained in every array, and the viewer policy below tests containment.
  site_ids uuid[] not null check (cardinality(site_ids) between 1 and 200
    and array_ndims(site_ids) = 1 and array_lower(site_ids, 1) = 1),
  subject text not null check (length(subject) between 1 and 200),
  body text not null check (length(body) <= 20000),
  draft_id uuid not null unique,
  created_at timestamptz not null default now(),
  unique (id, org_id),
  unique (client_id, week_start),
  foreign key (client_id, org_id) references public.clients (id, org_id) on delete restrict,
  foreign key (draft_id, org_id) references public.drafts (id, org_id) on delete restrict
);

-- What was sent, once per update, and only after a person approved it. subject, body, site_ids and
-- client_id are filled by the trigger from the approval and the update; nobody supplies them. Append-only.
create table public.weekly_update_sends (
  id bigint generated always as identity primary key,
  org_id uuid not null,
  update_id uuid not null unique,
  decision_id bigint not null references public.decisions (id) on delete restrict,
  client_id uuid,
  site_ids uuid[],
  subject text,
  body text,
  sent_at timestamptz not null default now(),
  foreign key (update_id, org_id) references public.weekly_updates (id, org_id) on delete restrict
);

-- Row-level security on every new table.
alter table public.clients enable row level security;
alter table public.invites enable row level security;
alter table public.weekly_updates enable row level security;
alter table public.weekly_update_sends enable row level security;

create policy clients_select on public.clients for select to authenticated
  using (org_id in (select private.staff_org_ids()));
create policy clients_insert on public.clients for insert to authenticated
  with check (org_id in (select private.admin_org_ids()));
create policy clients_update on public.clients for update to authenticated
  using (org_id in (select private.admin_org_ids()))
  with check (org_id in (select private.admin_org_ids()));
create policy clients_delete on public.clients for delete to authenticated
  using (org_id in (select private.admin_org_ids()));

-- Invites mirror members_insert: owners and admins invite, in their own name, and only an owner invites
-- an owner. So nobody can invite a role above their own: a member or a client viewer cannot invite at all.
create policy invites_select on public.invites for select to authenticated
  using (org_id in (select private.admin_org_ids()));
create policy invites_insert on public.invites for insert to authenticated
  with check (org_id in (select private.admin_org_ids()) and invited_by = (select auth.uid())
    and (role <> 'owner' or org_id in (select private.owner_org_ids())));
create policy invites_update on public.invites for update to authenticated
  using (org_id in (select private.admin_org_ids())
    and (role <> 'owner' or org_id in (select private.owner_org_ids())))
  with check (org_id in (select private.admin_org_ids()));

create policy weekly_updates_select on public.weekly_updates for select to authenticated
  using (org_id in (select private.staff_org_ids()));

create policy weekly_update_sends_select on public.weekly_update_sends for select to authenticated
  using (org_id in (select private.staff_org_ids())
    or (org_id in (select private.member_org_ids())
        and site_ids <@ array(select private.client_site_ids())));

-- Grants: take back the defaults, then name the columns. No id, time, token-derived or trigger-filled
-- column is writable by anyone but the owner.
revoke all on public.clients, public.invites, public.weekly_updates, public.weekly_update_sends
  from public, anon, authenticated, service_role;
grant select, delete on public.clients to authenticated, service_role;
grant insert (org_id, name) on public.clients to authenticated, service_role;
grant update (name) on public.clients to authenticated, service_role;
grant select (id, org_id, email, role, site_id, invited_by, expires_at, created_at, revoked_at,
  accepted_by, accepted_at) on public.invites to authenticated;
grant insert (org_id, email, role, site_id, invited_by, token_sha256) on public.invites
  to authenticated, service_role;
grant update (revoked_at) on public.invites to authenticated, service_role;
grant select on public.invites to service_role;
grant select on public.weekly_updates, public.weekly_update_sends to authenticated, service_role;
grant insert (org_id, client_id, week_start, site_ids, subject, body, draft_id) on public.weekly_updates
  to service_role;
grant insert (org_id, update_id, decision_id) on public.weekly_update_sends to service_role;

create trigger weekly_updates_append_only before update or delete on public.weekly_updates
  for each row execute function private.refuse_change();
create trigger weekly_updates_no_truncate before truncate on public.weekly_updates
  for each statement execute function private.refuse_change();
create trigger weekly_update_sends_append_only before update or delete on public.weekly_update_sends
  for each row execute function private.refuse_change();
create trigger weekly_update_sends_no_truncate before truncate on public.weekly_update_sends
  for each statement execute function private.refuse_change();

-- An invite changes once: revoked, or accepted (by private.accept_invite only). Neither is undone.
create function private.invites_one_way() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if old.accepted_at is not null or old.revoked_at is not null then
    raise exception 'an invite that was accepted or revoked cannot change' using errcode = '42501';
  end if;
  if new.revoked_at is not null and new.accepted_at is not null then
    raise exception 'an invite is either accepted or revoked' using errcode = '42501';
  end if;
  return new;
end
$$;
revoke all on function private.invites_one_way() from public;
create trigger invites_one_way before update on public.invites
  for each row execute function private.invites_one_way();

-- A weekly update's sites all belong to its client in its organisation, and its draft is an email draft of
-- the same organisation, for one of those sites, carrying exactly this subject and body.
create function private.weekly_update_check() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if coalesce(cardinality(new.site_ids), 0) = 0 then
    raise exception 'a weekly update covers at least one site' using errcode = '23514';
  end if;
  if (select count(*) from public.sites s
      where s.id = any(new.site_ids) and s.org_id = new.org_id and s.client_id = new.client_id)
     <> cardinality(array(select distinct pg_catalog.unnest(new.site_ids))) then
    raise exception 'every site in a weekly update must belong to its client' using errcode = '23514';
  end if;
  if not exists (select 1 from public.drafts d
                 where d.id = new.draft_id and d.org_id = new.org_id and d.kind = 'email'
                   and d.site_id = any(new.site_ids)
                   and d.payload = pg_catalog.jsonb_build_object('subject', new.subject, 'body', new.body)) then
    raise exception 'a weekly update needs its own email draft with the same subject and body'
      using errcode = '23514';
  end if;
  return new;
end
$$;
revoke all on function private.weekly_update_check() from public;
create trigger weekly_update_check before insert on public.weekly_updates
  for each row execute function private.weekly_update_check();

-- Nothing is recorded as sent unless a person approved (or edited and approved) the update's draft. The
-- text recorded is the text approved: the draft's for "approved", the edit for "edited".
create function private.weekly_update_send_fill() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_update public.weekly_updates;
  v_payload jsonb;
begin
  select * into v_update from public.weekly_updates u where u.id = new.update_id and u.org_id = new.org_id;
  if not found then
    raise exception 'weekly update not found' using errcode = '23503';
  end if;
  select case when x.decision = 'approved' then d.payload else x.edited_payload end into v_payload
    from public.decisions x join public.drafts d on d.id = x.draft_id
    where x.id = new.decision_id and x.draft_id = v_update.draft_id and x.org_id = new.org_id
      and x.decision in ('approved', 'edited');
  if v_payload is null then
    raise exception 'a weekly update is sent only after a person approves it' using errcode = '42501';
  end if;
  new.client_id := v_update.client_id;
  new.site_ids := v_update.site_ids;
  new.subject := v_payload ->> 'subject';
  new.body := v_payload ->> 'body';
  return new;
end
$$;
revoke all on function private.weekly_update_send_fill() from public;
create trigger weekly_update_send_fill before insert on public.weekly_update_sends
  for each row execute function private.weekly_update_send_fill();

-- Accept an invite as the signed-in person. SECURITY DEFINER (it inserts the member row past the policies),
-- so it checks everything itself: the token by its hash, not expired, revoked or used, the signed-in email
-- is the invited one, and the person who invited still holds a role that may grant this one. Every refusal
-- about the token reads the same, so the function does not say which tokens exist.
create function private.accept_invite(p_token text) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_email text := lower((select auth.jwt()) ->> 'email');
  v_invite public.invites;
begin
  if v_uid is null then
    raise exception 'sign in to accept an invite' using errcode = '28000';
  end if;
  if p_token is null or length(p_token) < 32 or length(p_token) > 200 then
    raise exception 'invite not recognised or no longer valid' using errcode = '28000';
  end if;
  select * into v_invite from public.invites i
    where i.token_sha256 = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_token, 'UTF8')), 'hex')
    for update;
  if not found or v_invite.revoked_at is not null or v_invite.accepted_at is not null
     or v_invite.expires_at <= now() or v_email is null or v_email <> v_invite.email then
    raise exception 'invite not recognised or no longer valid' using errcode = '28000';
  end if;
  if not exists (select 1 from public.members m
                 where m.org_id = v_invite.org_id and m.user_id = v_invite.invited_by
                   and (m.role = 'owner' or (m.role = 'admin' and v_invite.role <> 'owner'))) then
    raise exception 'the person who sent this invite can no longer grant that role' using errcode = '42501';
  end if;
  if exists (select 1 from public.members m where m.org_id = v_invite.org_id and m.user_id = v_uid) then
    raise exception 'you are already in this organisation' using errcode = '23505';
  end if;
  insert into public.members (org_id, user_id, role, site_id)
    values (v_invite.org_id, v_uid, v_invite.role, v_invite.site_id);
  update public.invites set accepted_by = v_uid, accepted_at = now() where id = v_invite.id;
  return v_invite.org_id;
end
$$;
revoke all on function private.accept_invite(text) from public, anon, authenticated, service_role;
grant execute on function private.accept_invite(text) to authenticated;
