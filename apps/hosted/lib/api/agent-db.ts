/**
 * The agent's own database login for the API's agent reads (AG-08). One variable (a secret, server-only):
 *
 *   GAUGELINE_AGENT_DATABASE_URL   a login that is a member of gaugeline_agent and of nothing else: not the
 *                                  owner, not authenticated, service_role, anon, the worker or the chat login
 *
 * An agent's bearer token never reaches the service_role connection: its reads run as gaugeline_agent, which
 * holds no privilege on any table and may run only private.agent_insert_draft, private.agent_list_pending and
 * private.agent_list_runs (migration 0014). Each of those takes the organisation from the token and
 * authorizes the call once, with its own scope. Unset, the API answers an agent's token with a 503.
 */
import postgres from "postgres";
import { connectionSkipsRls } from "../../db/audit.js";
import { AGENT_ROLE, type Sql } from "./db.js";

export const AGENT_URL_ENV = "GAUGELINE_AGENT_DATABASE_URL";
export { AGENT_ROLE };
const OTHER_ROLES = [
  "authenticated",
  "anon",
  "service_role",
  "gaugeline_worker",
  "gaugeline_chat",
] as const;

/** Opens and checks the agent login, or returns undefined when the variable is not set. */
export async function openAgentDatabase(
  env: Record<string, string | undefined>,
): Promise<Sql | undefined> {
  const url = env[AGENT_URL_ENV];
  if (!url) return undefined;
  const sql = postgres(url, { max: 5, onnotice: () => {} });
  try {
    if (await connectionSkipsRls(sql))
      throw new Error(`Refusing to start: the login in ${AGENT_URL_ENV} skips row-level security.`);
    const [me] = await sql`select pg_has_role(session_user, ${AGENT_ROLE}, 'MEMBER') as agent,
      exists (select 1 from pg_roles o where o.rolname = any(${OTHER_ROLES as unknown as string[]})
        and pg_has_role(session_user, o.oid, 'MEMBER')) as other`;
    if (!me?.agent)
      throw new Error(
        `Refusing to start: the login in ${AGENT_URL_ENV} is not a member of ${AGENT_ROLE}.`,
      );
    if (me.other)
      throw new Error(
        `Refusing to start: the login in ${AGENT_URL_ENV} can also act as ${OTHER_ROLES.join(", ")}: it must be a member of ${AGENT_ROLE} only.`,
      );
  } catch (e) {
    await sql.end({ timeout: 1 });
    throw e;
  }
  return sql;
}
