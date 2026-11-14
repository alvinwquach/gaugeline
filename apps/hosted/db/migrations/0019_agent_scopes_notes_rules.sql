-- Two scopes for the registry's closed list (AG-02; the owner's go on 13 Nov 2026 for AG-15 and AG-17). Run as
-- the schema owner ("postgres" on Supabase). The file takes the next free number when it merges (the
-- migrator refuses gaps and repeats).
--
--   read:notes        the field-findings miner (AG-15) reads a folder of review notes
--   read:rules-file   the house-rules compiler (AG-17) reads one style-guide file
--
-- This changes one constraint, public.agents.agents_scopes_known (0012), and nothing else: the two names are
-- added to the list and the count rises from 5 to 7, the length of the new list. No table, column, role,
-- login, grant, policy or function is added or changed, and no existing row changes (every scope a row holds
-- is still on the list, so the new constraint validates against them). The name stays, because
-- private.register_agent (0012) reports a broken rule by it.
--
-- What these scopes do NOT do: the policy's closed tool list (private.agent_authorize, 0013, and the tool
-- checks of agent_denies, 0013, and the trace, 0015) is untouched, so a call that names either tool is still
-- refused as `tool-not-allowed`. Registering an agent with one of them lets it do nothing in the database
-- until a later, reviewed change adds the tool: deny by default (ADR-0014).
--
-- The three other rules of the list stand: a flat list that starts at 1, no scope twice (the triggers of
-- 0012), and every name on the list or the whole registration is refused.
alter table public.agents drop constraint agents_scopes_known;
alter table public.agents add constraint agents_scopes_known check (
  scopes <@ array['draft:pull_request', 'draft:email', 'draft:sanity_draft', 'read:runs', 'read:pending',
    'read:notes', 'read:rules-file']
  and coalesce(array_ndims(scopes), 1) = 1 and coalesce(array_lower(scopes, 1), 1) = 1
  and cardinality(scopes) <= 7);
