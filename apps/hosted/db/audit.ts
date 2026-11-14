/**
 * Questions about the database's own safety, asked of the catalog. The tests call these after every
 * migration; a deploy can call them too. Each returns the names that fail, so [] means safe.
 */
import type postgres from "postgres";

type Query = postgres.Sql | postgres.TransactionSql;

/** Tables in `schema` with row-level security turned off. Supabase exposes "public" through its API. */
export async function tablesWithoutRls(sql: Query, schema = "public"): Promise<string[]> {
  const rows =
    await sql`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${schema} and c.relkind in ('r', 'p') and not c.relrowsecurity order by 1`;
  return rows.map((r) => r.relname as string);
}

/** Tables in `schema` without an org_id column: every row belongs to one organisation. */
export async function tablesWithoutOrgId(sql: Query, schema = "public"): Promise<string[]> {
  const rows =
    await sql`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${schema} and c.relkind in ('r', 'p')
      and not exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped)
    order by 1`;
  return rows.map((r) => r.relname as string);
}

/**
 * Views in `schema` that run with their owner's rights. Such a view reads the tables as the owner, which
 * skips row-level security for whoever selects from it; security_invoker (Postgres 15+) makes it the caller.
 */
export async function viewsWithoutSecurityInvoker(
  sql: Query,
  schema = "public",
): Promise<string[]> {
  const rows =
    await sql`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${schema} and c.relkind in ('v', 'm')
      and not coalesce(c.reloptions @> array['security_invoker=true'] or c.reloptions @> array['security_invoker=on'], false)
    order by 1`;
  return rows.map((r) => r.relname as string);
}

/**
 * True when this connection can read around row-level security. Both the login (session_user) and the
 * role in effect (current_user) are checked, because `set role` can switch to any role the login is a
 * member of, whatever NOINHERIT says. Reported: membership (directly or through other roles) in a
 * superuser, in a BYPASSRLS role other than service_role, or in the owner of a table in `schema`.
 *
 * The app's login must be like Supabase's authenticator: NOINHERIT, a member of `anon`, `authenticated` and
 * `service_role` only. Call this once at start-up, outside any transaction (assertConnectionRespectsRls).
 */
export async function connectionSkipsRls(sql: Query, schema = "public"): Promise<boolean> {
  const rows = await sql`
    with me as (select unnest(array[session_user::name, current_user::name]) as rolname),
    risky as (
      select r.oid from pg_roles r
      where r.rolsuper or (r.rolbypassrls and r.rolname <> 'service_role')
      union
      select c.relowner from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = ${schema} and c.relkind in ('r', 'p')
    )
    select exists (
      select 1 from me, risky where pg_has_role(me.rolname, risky.oid, 'MEMBER')
    ) as skips`;
  return rows[0]?.skips === true;
}

/** Throw when the connection could read around row-level security (see connectionSkipsRls). */
export async function assertConnectionRespectsRls(sql: Query, schema = "public"): Promise<void> {
  if (await connectionSkipsRls(sql, schema)) {
    throw new Error(
      "this database connection skips row-level security (a superuser, a BYPASSRLS role or a table owner): connect with the app's login role, and use the owner only for migrations",
    );
  }
}

/**
 * Login roles that can act as the drafts agent (`gaugeline_agent`, 0005) and also as a signed-in person or
 * the server (`authenticated`, `service_role`). The agent's login must be a member of the agent role only:
 * a login that could also `set role authenticated` or `service_role` would not be limited to proposing
 * drafts. Membership counts however it is reached (directly or through other roles, inherited or not);
 * superusers are left out because they are members of every role. Returns the names, so [] means safe, and
 * also [] on a database that has no `gaugeline_agent` yet. Roles are per server, so this looks at every
 * login on it.
 */
export async function agentLoginsWithOtherRoles(sql: Query): Promise<string[]> {
  const rows = await sql`
    select r.rolname from pg_roles r, pg_roles agent
    where agent.rolname = 'gaugeline_agent' and r.oid <> agent.oid and not r.rolsuper
      and pg_has_role(r.oid, agent.oid, 'MEMBER')
      and exists (
        select 1 from pg_roles other
        where other.rolname in ('authenticated', 'service_role')
          and pg_has_role(r.oid, other.oid, 'MEMBER'))
    order by 1`;
  return rows.map((r) => r.rolname as string);
}

/**
 * Functions in schema `private` that `role` may execute, by name. A function there is server-only unless a
 * migration grants it on purpose, and the tests list exactly which ones each role may call.
 */
export async function privateFunctionsExecutableBy(sql: Query, role: string): Promise<string[]> {
  const rows = await sql`select distinct p.proname from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and has_function_privilege(${role}, p.oid, 'EXECUTE') order by 1`;
  return rows.map((r) => r.proname as string);
}

/**
 * SECURITY DEFINER functions in `schema` that do not pin `search_path` to empty. Such a function runs as
 * its owner, so an unpinned search_path lets a caller put their own table or operator in its way.
 */
export async function definerFunctionsWithoutEmptySearchPath(
  sql: Query,
  schema = "private",
): Promise<string[]> {
  const rows =
    await sql`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = ${schema} and p.prosecdef
      and coalesce(p.proconfig, '{}') <> array['search_path=""']
    order by 1`;
  return rows.map((r) => r.proname as string);
}

/**
 * Login roles that can act as the chat endpoint (`gaugeline_chat`, 0010) and also as a signed-in person
 * (`authenticated`), the server, the worker or the drafts agent. The chat login may run four functions and
 * nothing else: private.chat_decide finds the member from a link that member confirmed. A login that could
 * also `set role authenticated` could claim to be any person and write a decision in their name, so the
 * login must be a member of `gaugeline_chat` only, like the agent's login (agentLoginsWithOtherRoles).
 * Membership counts however it is reached; superusers are left out. Returns the names, so [] means safe
 * (also on a database with no `gaugeline_chat` yet).
 */
export async function chatLoginsWithOtherRoles(sql: Query): Promise<string[]> {
  const rows = await sql`
    select r.rolname from pg_roles r, pg_roles chat
    where chat.rolname = 'gaugeline_chat' and r.oid <> chat.oid and not r.rolsuper
      and pg_has_role(r.oid, chat.oid, 'MEMBER')
      and exists (
        select 1 from pg_roles other
        where other.rolname in ('authenticated', 'anon', 'service_role', 'gaugeline_worker', 'gaugeline_agent')
          and pg_has_role(r.oid, other.oid, 'MEMBER'))
    order by 1`;
  return rows.map((r) => r.rolname as string);
}
