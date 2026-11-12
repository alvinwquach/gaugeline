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

-- The shape of each kind, held by the database for everyone who writes a draft or a decision: the agent,
-- a signed-in person (who can insert into both tables directly through Supabase's REST API) and the server.
-- These functions mirror apps/hosted/inbox/kinds.ts, which gives the same verdicts with friendlier messages
-- (a test runs both over one list of payloads). A payload that fails is refused when the draft is written
-- and again when an approval or an edit is recorded, so nothing outside a kind's fixed shape can be approved
-- and nothing can burn a draft's only decision. Each returns null when the value is fine, else a short reason
-- that never quotes the value.

-- A string field: its length, and no control or line-breaking character (C0 controls, DEL, C1 controls
-- including NEL, U+2028 and U+2029). Tab is allowed; a newline only when p_multiline.
create function private.draft_text_problem(
  p_value jsonb, p_name text, p_min int, p_max int, p_multiline boolean
) returns text
language plpgsql immutable set search_path = ''
as $$
declare
  v_text text;
  v_bad text;
begin
  if p_value is null or jsonb_typeof(p_value) <> 'string' then
    return p_name || ' must be a string';
  end if;
  v_text := p_value #>> '{}';
  if length(v_text) < p_min or length(v_text) > p_max then
    return p_name || ' must be ' || p_min || ' to ' || p_max || ' characters';
  end if;
  v_bad := case when p_multiline then '[\u0001-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]'
                else '[\u0001-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029]' end;
  if v_text ~ v_bad then
    return p_name || ' must not contain control or line-break characters';
  end if;
  return null;
end
$$;

-- A relative path inside a repository: plain characters, no leading "-", no segment made of dots only,
-- and none of git's own files, the CI configuration that runs with a repository's secrets or a git hooks
-- manager at any depth (case and trailing dots ignored, as Windows does).
create function private.draft_path_ok(p_path text) returns boolean
language plpgsql immutable set search_path = ''
as $$
declare
  v_segment text;
  v_name text;
begin
  if p_path is null or length(p_path) = 0 or length(p_path) > 300 or left(p_path, 1) = '-' then
    return false;
  end if;
  if p_path !~ '^[][A-Za-z0-9._@()-]+(/[][A-Za-z0-9._@()-]+)*$' then return false; end if;
  foreach v_segment in array string_to_array(p_path, '/') loop
    if left(v_segment, 1) = '-' then return false; end if;
    v_name := regexp_replace(lower(v_segment), '\.+$', '');
    if v_name = '' or v_name in ('.git', '.gitmodules', '.github', '.circleci', '.gitlab-ci.yml', '.husky') then
      return false;
    end if;
  end loop;
  return true;
end
$$;

create function private.draft_payload_problem(p_kind text, p_payload jsonb) returns text
language plpgsql immutable set search_path = ''
as $$
declare
  v_keys text[];
  v_item jsonb;
  v_entry record;
  v_problem text;
  v_count int;
  v_paths text[] := '{}';
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    return 'payload must be an object';
  end if;
  select coalesce(array_agg(k order by k), '{}') into v_keys from jsonb_object_keys(p_payload) k;

  if p_kind = 'email' then
    if v_keys <> array['body', 'subject'] then return 'payload must have exactly subject and body'; end if;
    return coalesce(private.draft_text_problem(p_payload -> 'subject', 'payload.subject', 1, 200, false),
                    private.draft_text_problem(p_payload -> 'body', 'payload.body', 0, 20000, true));

  elsif p_kind = 'pull_request' then
    if v_keys <> array['body', 'files', 'title'] then
      return 'payload must have exactly title, body and files';
    end if;
    v_problem := coalesce(private.draft_text_problem(p_payload -> 'title', 'payload.title', 1, 200, false),
                          private.draft_text_problem(p_payload -> 'body', 'payload.body', 0, 20000, true));
    if v_problem is not null then return v_problem; end if;
    if jsonb_typeof(p_payload -> 'files') <> 'array' then return 'payload.files must be an array'; end if;
    v_count := jsonb_array_length(p_payload -> 'files');
    if v_count < 1 or v_count > 20 then return 'payload.files must hold 1 to 20 files'; end if;
    for v_item in select * from jsonb_array_elements(p_payload -> 'files') loop
      if jsonb_typeof(v_item) <> 'object' or
         (select coalesce(array_agg(k order by k), '{}') from jsonb_object_keys(v_item) k)
           <> array['content', 'path'] then
        return 'each file must have exactly path and content';
      end if;
      if jsonb_typeof(v_item -> 'path') <> 'string' or not private.draft_path_ok(v_item ->> 'path') then
        return 'payload.files.path is not an allowed repository path';
      end if;
      if jsonb_typeof(v_item -> 'content') <> 'string' or length(v_item ->> 'content') > 100000 then
        return 'payload.files.content must be a string of at most 100000 characters';
      end if;
      v_paths := v_paths || (v_item ->> 'path');
    end loop;
    if (select count(distinct x) from unnest(v_paths) x) <> v_count then
      return 'payload.files names a path twice';
    end if;
    return null;

  elsif p_kind = 'sanity_draft' then
    if v_keys <> array['documentId', 'documentType', 'set'] then
      return 'payload must have exactly documentId, documentType and set';
    end if;
    if jsonb_typeof(p_payload -> 'documentId') <> 'string'
       or (p_payload ->> 'documentId') !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$' then
      return 'payload.documentId is not a plain document id';
    end if;
    if jsonb_typeof(p_payload -> 'documentType') <> 'string'
       or (p_payload ->> 'documentType') !~ '^[A-Za-z][A-Za-z0-9_]{0,63}$' then
      return 'payload.documentType is not a document type';
    end if;
    if jsonb_typeof(p_payload -> 'set') <> 'object' then return 'payload.set must be an object'; end if;
    v_count := (select count(*) from jsonb_object_keys(p_payload -> 'set'));
    if v_count < 1 or v_count > 20 then return 'payload.set must hold 1 to 20 fields'; end if;
    for v_entry in select key, value from jsonb_each(p_payload -> 'set') loop
      -- No leading underscore: _id, _type, _rev and the rest are the content system's own fields.
      if v_entry.key !~ '^[A-Za-z][A-Za-z0-9_]{0,63}$' then
        return 'payload.set has a field name that is not a plain name';
      end if;
      case jsonb_typeof(v_entry.value)
        when 'string' then
          v_problem := private.draft_text_problem(v_entry.value, 'payload.set value', 0, 2000, true);
          if v_problem is not null then return v_problem; end if;
        when 'number' then
          -- The range in which JSON and jsonb print a number alike (kinds.ts plainNumber).
          if (v_entry.value #>> '{}')::numeric <> 0
             and (abs((v_entry.value #>> '{}')::numeric) < 0.000001
                  or abs((v_entry.value #>> '{}')::numeric) >= 1e15) then
            return 'payload.set has a number out of range';
          end if;
        when 'boolean' then null;
        when 'null' then null;
        else return 'payload.set values must be text, numbers, true, false or null';
      end case;
    end loop;
    return null;
  end if;
  return 'kind ' || coalesce(p_kind, 'null') || ' is not registered';
end
$$;
revoke all on function private.draft_text_problem(jsonb, text, int, int, boolean),
  private.draft_path_ok(text), private.draft_payload_problem(text, jsonb) from public;

-- The draft table's own trigger: any inserter, any row. An unregistered kind is left to drafts_kind_check.
create function private.drafts_check_payload() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_problem text;
begin
  if new.kind in ('pull_request', 'email', 'sanity_draft') then
    v_problem := private.draft_payload_problem(new.kind, new.payload);
    if v_problem is not null then
      raise exception 'the payload does not match the % shape: %', new.kind, v_problem
        using errcode = '23514';
    end if;
  end if;
  return new;
end
$$;
revoke all on function private.drafts_check_payload() from public;
create trigger drafts_check_payload before insert on public.drafts
  for each row execute function private.drafts_check_payload();

-- At most 50 findings behind one draft.
alter table public.drafts add constraint drafts_finding_ids_cap
  check (cardinality(finding_ids) <= 50);

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
-- the site and every finding belong to that organisation, and the caps (50 findings a draft, 200 waiting
-- drafts a site). The kind, the payload's shape and its size are checked by the table's own constraints
-- and trigger, so they hold for every inserter. The token is looked up by its hash, so the comparison never touches the
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
  if cardinality(coalesce(p_finding_ids, '{}')) > 50 then
    raise exception 'a draft names at most 50 findings' using errcode = '54000';
  end if;
  if (select count(*) from public.findings f
      where f.id = any(coalesce(p_finding_ids, '{}')) and f.org_id = v_org and f.site_id = p_site_id)
     <> cardinality(array(select distinct pg_catalog.unnest(coalesce(p_finding_ids, '{}'::uuid[])))) then
    raise exception 'finding not found for this site' using errcode = '42501';
  end if;
  -- A site holds at most 200 undecided drafts from agents: one that loops cannot fill the inbox. The lock
  -- makes the count exact when two calls arrive together; it is held to the end of the transaction.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_site_id::text, 0));
  if (select count(*) from public.drafts d
      where d.site_id = p_site_id
        and not exists (select 1 from public.decisions x where x.draft_id = d.id
                        and x.decision in ('approved', 'edited', 'declined'))) >= 200 then
    raise exception 'this site already has 200 drafts waiting for a decision; decide or decline some first'
      using errcode = '53400';
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
  v_kind text;
  v_payload jsonb;
  v_problem text;
  v_text text;
begin
  if new.decision in ('approved', 'edited') then
    -- The payload being approved must fit its kind: the draft's own for "approved", the edit for "edited".
    -- Only a draft of the decision's own organisation is read (the foreign key refuses any other).
    select d.kind, case when new.decision = 'approved' then d.payload else new.edited_payload end
      into v_kind, v_payload
      from public.drafts d where d.id = new.draft_id and d.org_id = new.org_id;
    if found then
      v_problem := private.draft_payload_problem(v_kind, v_payload);
      if v_problem is not null then
        raise exception 'the payload does not match the % shape: %', v_kind, v_problem
          using errcode = '23514';
      end if;
      v_text := v_payload::text;
    end if;
  end if;
  new.payload_sha256 := case when v_text is null then null
    else pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_text, 'UTF8')), 'hex') end;
  return new;
end
$$;
revoke all on function private.decision_payload_hash() from public;
create trigger decisions_payload_hash before insert on public.decisions
  for each row execute function private.decision_payload_hash();
