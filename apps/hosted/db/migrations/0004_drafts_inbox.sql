-- The drafts inbox (G37): the agent role, the registered draft kinds, and one decision per draft.
-- Run as the schema owner ("postgres" on Supabase).

-- Draft kinds may use an underscore (pull_request, sanity_draft), as the writer registry names them.
alter table public.drafts drop constraint drafts_kind_check;
alter table public.drafts add constraint drafts_kind_check check (kind ~ '^[a-z][a-z0-9_-]{0,39}$');

-- The agent role: an agent proposes, it never decides. It may INSERT a draft, in the organisation its
-- request claims name, of a registered kind, in nobody's name (created_by stays null). It has no other
-- privilege on any table or view: it cannot read drafts, insert a decision, or change anything. A role
-- without the privilege fails in the database, whatever the code above it does.
-- Roles are per server, not per database, so creating it tolerates another database having done it.
do $$ begin create role gaugeline_agent nologin noinherit;
exception when duplicate_object or unique_violation then null; end $$;
grant usage on schema public to gaugeline_agent;
grant insert (org_id, site_id, kind, payload, finding_ids) on public.drafts to gaugeline_agent;

create policy drafts_insert_agent on public.drafts for insert to gaugeline_agent
  with check (
    org_id = (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'org_id')::uuid
    and kind in ('pull_request', 'email', 'sanity_draft')
    and created_by is null
  );

-- One person's choice per draft, whoever clicks and however often. A second Approve (a double click, or
-- two people at the same moment) conflicts on this index; the inbox inserts with ON CONFLICT DO NOTHING
-- and reports the decision that won, so there is one decision row and one apply job. A decision is final:
-- to change course, the agent writes a new draft. Outcome rows the worker appends later (ADR-0010) use
-- other values and are not limited by this index.
create unique index decisions_one_choice_per_draft on public.decisions (draft_id)
  where decision in ('approved', 'edited', 'declined');
