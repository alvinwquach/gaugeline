/**
 * The chat endpoint's dependencies for a running server (X69). Its own login, its own variable:
 *   GAUGELINE_CHAT_DATABASE_URL  a member of gaugeline_chat and of nothing else
 *                                (not the owner, not service_role, not gaugeline_worker; migration 0010).
 * Opened and checked once. The apply queue is the same gap the inbox has: the jobs table that an approval
 * enqueues into is not built yet, so outside development and tests the endpoint answers 503 instead of
 * recording an approval nothing will apply.
 */
import postgres from "postgres";
import { chatLoginsWithOtherRoles, connectionSkipsRls } from "../db/audit.js";
import { MemoryApplyQueue } from "../inbox/inbox.js";
import type { SlackDeps } from "./slack.js";
import { CHAT_ROLE, sqlChatStore } from "./store.js";

export const CHAT_URL_ENV = "GAUGELINE_CHAT_DATABASE_URL";

export async function openChatDatabase(env: Record<string, string | undefined>) {
  const url = env[CHAT_URL_ENV];
  if (!url) throw new Error(`${CHAT_URL_ENV} is not set: the chat endpoint has no database.`);
  const sql = postgres(url, { max: 5, onnotice: () => {} });
  try {
    if (await connectionSkipsRls(sql))
      throw new Error(`Refusing to start: the login in ${CHAT_URL_ENV} skips row-level security.`);
    const [me] = await sql`select session_user as u,
      pg_has_role(session_user, ${CHAT_ROLE}, 'SET') as chat`;
    if (!me?.chat)
      throw new Error(`Refusing to start: the login must be a member of ${CHAT_ROLE}.`);
    // A login that could also become a signed-in person (or the server, the worker, the agent) could claim
    // to be anyone: the endpoint's login is a member of gaugeline_chat and nothing else (0010).
    if ((await chatLoginsWithOtherRoles(sql)).includes(me.u as string))
      throw new Error(
        `Refusing to start: the login in ${CHAT_URL_ENV} can also act as authenticated, anon, service_role, gaugeline_worker or gaugeline_agent.`,
      );
  } catch (e) {
    await sql.end({ timeout: 1 });
    throw e;
  }
  return sql;
}

let shared: Promise<SlackDeps> | undefined;
let testReply: SlackDeps["reply"];

/** Tests only (NODE_ENV=test): where replies go instead of Slack. Production always posts to Slack. */
export function setReplyForTests(reply: SlackDeps["reply"]): void {
  if (process.env.NODE_ENV !== "test")
    throw new Error("setReplyForTests runs only under NODE_ENV=test");
  testReply = reply;
}

export function getSlackDeps(): Promise<SlackDeps> {
  shared ??= (async () => {
    const env = process.env;
    if (env.NODE_ENV !== "development" && env.NODE_ENV !== "test")
      throw new Error(
        "no apply queue is wired yet: chat approvals run only in development and tests",
      );
    const sql = await openChatDatabase(env);
    return {
      sql,
      store: sqlChatStore(sql),
      queue: new MemoryApplyQueue(),
      ...(testReply ? { reply: testReply } : {}),
      ...(env.GAUGELINE_APP_URL ? { appUrl: env.GAUGELINE_APP_URL } : {}),
    };
  })().catch((e: unknown) => {
    shared = undefined;
    throw e;
  });
  return shared;
}

/** Tests only: forget the shared connection (and close it) so the next request opens its own. */
export async function closeSlackDeps(): Promise<void> {
  const open = shared;
  shared = undefined;
  if (open) await (await open.catch(() => undefined))?.sql.end({ timeout: 1 });
}
