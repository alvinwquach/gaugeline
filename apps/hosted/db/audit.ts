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
 * The app's login must be like Supabase's authenticator: NOINHERIT, a member of `authenticated` and
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
