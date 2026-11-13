-- 0016: approval receipts (AG-06). It follows AG-05's 0015 (the migrator refuses gaps, so this file runs
-- only once 0015 is on main).
--
-- One receipt per person's choice on a draft (approved, edited, declined), written by the same transaction
-- that records the choice: an AFTER INSERT trigger on public.decisions. Nothing about a decisions row changes
-- (ADR-0014: a column on, or a change to, ADR-0010's decisions rows would need an ADR first); the receipt is
-- a new row in a new table. Each receipt commits to the organisation's previous one by hash, so the
-- receipts form one chain per organisation that `gaugeline receipts verify` checks offline with
-- packages/core/src/approval-receipts (the same canonical text: a test builds both from one set of inputs).
--
-- What it proves and what it does not: tamper evidence, not a signature. The table owner can disable these
-- triggers and rewrite the whole chain; a head hash kept outside the database finds that (docs/hosted/receipts.md).
-- The record never holds the payload: only its SHA-256 (the payload can hold page text).

create table public.receipts (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.organisations (org_id),
  seq bigint not null check (seq >= 1),
  decision_id bigint not null unique references public.decisions (id),
  draft_id uuid not null,
  prev text not null check (prev ~ '^[0-9a-f]{64}$'),
  hash text not null unique check (hash ~ '^[0-9a-f]{64}$'),
  -- The canonical JSON line, exactly as exported and verified (about 600 bytes).
  record text not null check (octet_length(record) <= 2048),
  -- Who wrote the decision, which the hashed record cannot say (its format is fixed): 'person' when the
  -- signed-in person (auth.uid()) is the decided_by of the row, 'service' for every other writer (the
  -- server's service_role, which may insert any decided_by, and the chat approval function, which maps a
  -- verified chat click to a member). Not hashed: it sits beside the chain, in the writers export.
  written_by text not null check (written_by in ('person', 'service')),
  created_at timestamptz not null default now(),
  -- One chain per organisation: no two receipts at one position, none following the same receipt (a fork),
  -- and one receipt per draft (one choice per draft, 0005).
  unique (org_id, seq),
  unique (org_id, prev),
  unique (org_id, draft_id)
);

-- Owners and admins read their organisation's chain; members, client viewers, the agent and the worker read
-- nothing. Nobody but this migration's functions writes: no role is granted INSERT, UPDATE or DELETE.
alter table public.receipts enable row level security;
create policy receipts_select on public.receipts for select to authenticated
  using (org_id in (select private.admin_org_ids()));
revoke all on public.receipts from public, anon, authenticated, service_role, gaugeline_agent,
  gaugeline_worker;
grant select on public.receipts to authenticated;

create trigger receipts_append_only before update or delete on public.receipts
  for each row execute function private.refuse_change();
create trigger receipts_no_truncate before truncate on public.receipts
  for each statement execute function private.refuse_change();

-- The head of each organisation's chain. Its row is locked (FOR UPDATE) while a receipt is written, so two
-- choices recorded at the same moment take turns: under READ COMMITTED the second waits and then reads the
-- first one's head; under REPEATABLE READ or SERIALIZABLE it fails with a serialization error and its
-- decision rolls back with it. Either way there is no fork.
create table private.receipt_heads (
  org_id uuid primary key references public.organisations (org_id),
  seq bigint not null check (seq >= 0),
  hash text not null check (hash ~ '^[0-9a-f]{64}$')
);
alter table private.receipt_heads enable row level security;
revoke all on private.receipt_heads from public, anon, authenticated, service_role, gaugeline_agent,
  gaugeline_worker;

-- The canonical JSON of one receipt (packages/core/src/approval-receipts/canonical.ts): keys sorted, no
-- whitespace, integers only, strings as JSON writes them. Without p_hash, the text the hash is taken over;
-- with it, the line itself. Every string goes through to_json, which escapes like JSON.stringify for the
-- characters these fields can hold (ids, hex, fixed words). Times are UTC with six fraction digits.
create function private.receipt_text(
  p_org uuid, p_seq bigint, p_draft uuid, p_decision_id bigint, p_kind text, p_decision text,
  p_payload_sha256 text, p_member uuid, p_role text, p_decided_at timestamptz, p_prev text, p_hash text
) returns text
language sql stable set search_path = ''
as $$
  select '{"approver":{"member":' || pg_catalog.to_json(p_member::text)::text
    || ',"role":' || coalesce(pg_catalog.to_json(p_role)::text, 'null') || '}'
    || ',"decidedAt":' || pg_catalog.to_json(pg_catalog.to_char(p_decided_at at time zone 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text
    || ',"decision":' || pg_catalog.to_json(p_decision)::text
    || ',"decisionId":' || pg_catalog.to_json(p_decision_id::text)::text
    || ',"draft":' || pg_catalog.to_json(p_draft::text)::text
    || ',"expiresAt":' || case when p_decision in ('approved', 'edited')
         then pg_catalog.to_json(pg_catalog.to_char((p_decided_at + interval '72 hours') at time zone 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text
         else 'null' end
    || case when p_hash is null then '' else ',"hash":' || pg_catalog.to_json(p_hash)::text end
    || ',"kind":' || pg_catalog.to_json(p_kind)::text
    || ',"org":' || pg_catalog.to_json(p_org::text)::text
    || ',"payloadSha256":' || pg_catalog.to_json(p_payload_sha256)::text
    || ',"prev":' || pg_catalog.to_json(p_prev)::text
    || ',"seq":' || p_seq::text
    || ',"v":1}'
$$;
revoke all on function private.receipt_text(uuid, bigint, uuid, bigint, text, text, text, uuid, text,
  timestamptz, text, text) from public, anon, authenticated, service_role;

-- Write the receipt for a person's choice, in the decision's own transaction: if the receipt cannot be
-- written, the decision is not recorded either. SECURITY DEFINER so it can read the draft, the member's role
-- and the head past row-level security and insert where no caller may; it reads only rows of the decision's
-- own organisation. The payload hash is the one the database computed (0005) for an approval or an edit,
-- and the hash of the draft's payload, computed the same way, for a decline (what the person saw).
create function private.decisions_write_receipt() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_kind text;
  v_payload_sha256 text;
  v_role text;
  v_head record;
  v_seq bigint;
  v_hash text;
begin
  select d.kind,
         case when new.decision = 'declined'
           then pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(d.payload::text, 'UTF8')), 'hex')
           else new.payload_sha256 end
    into v_kind, v_payload_sha256
    from public.drafts d where d.id = new.draft_id and d.org_id = new.org_id;
  if v_kind is null or v_payload_sha256 is null then
    raise exception 'a receipt needs the draft and the hash of the payload that was decided'
      using errcode = '23514';
  end if;
  -- The role at this moment in the draft's own organisation; null when decided_by is not a member there.
  select m.role into v_role from public.members m
    where m.org_id = new.org_id and m.user_id = new.decided_by;
  insert into private.receipt_heads (org_id, seq, hash) values (new.org_id, 0, pg_catalog.repeat('0', 64))
    on conflict (org_id) do nothing;
  select h.seq, h.hash into v_head from private.receipt_heads h where h.org_id = new.org_id for update;
  v_seq := v_head.seq + 1;
  v_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(private.receipt_text(
    new.org_id, v_seq, new.draft_id, new.id, v_kind, new.decision, v_payload_sha256, new.decided_by, v_role,
    new.decided_at, v_head.hash, null), 'UTF8')), 'hex');
  insert into public.receipts (org_id, seq, decision_id, draft_id, prev, hash, record, written_by)
    values (new.org_id, v_seq, new.id, new.draft_id, v_head.hash, v_hash, private.receipt_text(
      new.org_id, v_seq, new.draft_id, new.id, v_kind, new.decision, v_payload_sha256, new.decided_by,
      v_role, new.decided_at, v_head.hash, v_hash),
      case when (select auth.uid()) = new.decided_by then 'person' else 'service' end);
  update private.receipt_heads set seq = v_seq, hash = v_hash where org_id = new.org_id;
  return null;
end
$$;
revoke all on function private.decisions_write_receipt() from public, anon, authenticated, service_role;

-- Only a person's choice gets a receipt. A choice skipped by ON CONFLICT DO NOTHING (a double click) inserts
-- no row and fires nothing, so one draft never gets two receipts.
create trigger decisions_write_receipt after insert on public.decisions
  for each row when (new.decision in ('approved', 'edited', 'declined'))
  execute function private.decisions_write_receipt();
