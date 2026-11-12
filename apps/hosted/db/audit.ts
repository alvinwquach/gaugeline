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
