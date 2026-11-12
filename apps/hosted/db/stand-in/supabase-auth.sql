-- STAND-IN FOR SUPABASE. NOT A MIGRATION. NEVER RUN THIS ON A SUPABASE PROJECT.
--
-- The tests run the migrations on a plain Postgres. A Supabase project already has the roles and the
-- auth.uid() function the policies use; this file creates a minimal copy of just those, so the same
-- migration files run in both places unchanged:
--   * roles anon (not signed in), authenticated (signed in, subject to row-level security) and
--     service_role (the server, bypasses row-level security);
--   * auth.uid(): the signed-in user's id, read from the request's JWT claims ("sub");
--   * default privileges that grant every new table in public to those roles, as a Supabase project
--     does, so the tests see the same risk the migrations have to undo.
-- Roles are per server, not per database, so creating them tolerates another test file having done it.

do $$ begin create role anon nologin noinherit;
exception when duplicate_object or unique_violation then null; end $$;
do $$ begin create role authenticated nologin noinherit;
exception when duplicate_object or unique_violation then null; end $$;
do $$ begin create role service_role nologin noinherit bypassrls;
exception when duplicate_object or unique_violation then null; end $$;

create schema if not exists auth;

create or replace function auth.uid() returns uuid
language sql stable
as $$
  select nullif(
    coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
    ),
    ''
  )::uuid
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
