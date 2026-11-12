-- The drafts inbox (G37): registered draft kinds, the agent's one way in, one decision per draft, and
-- the hash of the exact payload each approval approved. Run as the schema owner ("postgres" on Supabase).
-- Precondition: no organisation has used drafts yet (the hosted app is unreleased). The kind check and the
-- unique index below fail on a database that already holds an unregistered kind or two choices for one
-- draft; such a database needs those rows resolved by hand first.

-- Only the kinds the writer knows (ADR-0010): a pull request, a mailbox draft, a Sanity draft document.
-- This holds for everyone who inserts a draft, the agent, a person and the server alike.
alter table public.drafts drop constraint drafts_kind_check;
alter table public.drafts add constraint drafts_kind_check
  check (kind in ('pull_request', 'email', 'sanity_draft'));

-- An edit is held to the same size as the draft it edits.
alter table public.decisions add constraint decisions_edited_payload_size
  check (edited_payload is null or octet_length(edited_payload::text) <= 16384);

-- The agent. An agent proposes and never decides. Its role holds no privilege on any table or view: it
-- cannot read drafts, insert a decision or change anything. Its one way in is private.agent_insert_draft,
-- which takes the organisation from the agent's token, never from anything the session can set (request
-- claims are the caller's to choose). Roles are per server, so creating it tolerates an earlier database.
do $$ begin create role gaugeline_agent nologin noinherit;
exception when duplicate_object or unique_violation then null; end $$;

-- One row per agent token: its organisation and the SHA-256 of the token, never the token. The server
-- (G35's token code) creates one per organisation and shows the token once; revoking sets revoked_at.
create table private.agent_tokens (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.organisations (org_id) on delete cascade,
  token_sha256 bytea not null unique check (octet_length(token_sha256) = 32),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
alter table private.agent_tokens enable row level security;
revoke all on private.agent_tokens from public, anon, authenticated, service_role, gaugeline_agent;

-- Insert one draft for the organisation the token belongs to. SECURITY DEFINER so it can read the token
-- table and insert past row-level security, which is why it checks everything itself: the token, that
-- the site and every finding belong to that organisation, and that the kind is registered (the table's
-- own checks cap the payload). The token is looked up by its hash, so the comparison never touches the
-- token itself; the hash is of a random secret, so its prefix tells an attacker nothing.
create function private.agent_insert_draft(
  agent_token text, p_site_id uuid, p_kind text, p_payload jsonb, p_finding_ids uuid[] default '{}'
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_org uuid;
  v_id uuid;
begin
  if agent_token is null or length(agent_token) < 32 or length(agent_token) > 200 then
    raise exception 'agent token not recognised' using errcode = '28000';
  end if;
  select t.org_id into v_org from private.agent_tokens t
    where t.token_sha256 = pg_catalog.sha256(pg_catalog.convert_to(agent_token, 'UTF8'))
      and t.revoked_at is null;
  if v_org is null then
    raise exception 'agent token not recognised' using errcode = '28000';
  end if;
  if not exists (select 1 from public.sites s where s.id = p_site_id and s.org_id = v_org) then
    raise exception 'site not found for this agent' using errcode = '42501';
  end if;
  if (select count(*) from public.findings f
      where f.id = any(coalesce(p_finding_ids, '{}')) and f.org_id = v_org and f.site_id = p_site_id)
     <> cardinality(array(select distinct pg_catalog.unnest(coalesce(p_finding_ids, '{}'::uuid[])))) then
    raise exception 'finding not found for this site' using errcode = '42501';
  end if;
  insert into public.drafts (org_id, site_id, kind, payload, finding_ids, created_by)
    values (v_org, p_site_id, p_kind, p_payload, coalesce(p_finding_ids, '{}'), null)
    returning id into v_id;
  return v_id;
end
$$;
revoke all on function private.agent_insert_draft(text, uuid, text, jsonb, uuid[])
  from public, anon, authenticated, service_role;
grant usage on schema private to gaugeline_agent;
grant execute on function private.agent_insert_draft(text, uuid, text, jsonb, uuid[]) to gaugeline_agent;

-- One person's choice per draft, whoever clicks and however often. A second choice (a double click, or two
-- people at the same moment) conflicts on this index; the inbox inserts with ON CONFLICT DO NOTHING and
-- reports the decision that won, so there is one decision row and one apply job. A decision is final: to
-- change course, the agent writes a new draft. Outcome rows the worker appends later (ADR-0010 part 4)
-- use other values and are not limited by this index.
create unique index decisions_one_choice_per_draft on public.decisions (draft_id)
  where decision in ('approved', 'edited', 'declined');

-- The SHA-256 of the exact payload approved (ADR-0010 part 2): the draft's payload for "approved", the
-- edited payload for "edited", as the database's own jsonb text. The database computes it on insert, so
-- nobody can supply a different one (no role is granted the column), and the apply job carries the same
-- text, so the worker can refuse a job whose payload does not hash to the approval.
alter table public.decisions add column payload_sha256 text
  check (payload_sha256 ~ '^[0-9a-f]{64}$');
-- NOT VALID: approvals recorded before this migration have no hash and cannot be updated (append-only);
-- every approval from now on must have one. The worker refuses a job without a hash.
alter table public.decisions add constraint decisions_approval_has_hash
  check (decision not in ('approved', 'edited') or payload_sha256 is not null) not valid;

create function private.decision_payload_hash() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_text text;
begin
  if new.decision = 'approved' then
    select d.payload::text into v_text from public.drafts d where d.id = new.draft_id;
  elsif new.decision = 'edited' then
    v_text := new.edited_payload::text;
  end if;
  new.payload_sha256 := case when v_text is null then null
    else pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_text, 'UTF8')), 'hex') end;
  return new;
end
$$;
revoke all on function private.decision_payload_hash() from public;
create trigger decisions_payload_hash before insert on public.decisions
  for each row execute function private.decision_payload_hash();
