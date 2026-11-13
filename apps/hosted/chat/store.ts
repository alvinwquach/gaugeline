/**
 * What the chat endpoint may ask the database (X69), and nothing else. The login it runs on is a member of
 * `gaugeline_chat` (which holds no privilege on any table; migration 0010) and of `authenticated` (to write
 * a decision as the member, in inbox.ts). Everything here goes through the four SECURITY DEFINER functions
 * that role may execute: read one connection's signing secret, claim a request once, find the member a chat
 * user is. A value that comes back is the secret itself, so nothing here logs a row or wraps a driver error.
 */
import type postgres from "postgres";

export type ChatProvider = "slack" | "discord" | "teams";

export interface ChatConnection {
  id: string;
  orgId: string;
  provider: ChatProvider;
  /** The provider's id for the workspace; a signed request that names another one is refused. */
  workspaceRef: string | null;
}

export interface ChatMember {
  userId: string;
  role: string;
}

export interface ChatStore {
  /** The active connection a request address names, or undefined (unknown, disabled or not a UUID). */
  connection(id: string): Promise<ChatConnection | undefined>;
  /** Its signing secret, or undefined when it has none of kind signing_secret. */
  signingSecret(id: string): Promise<string | undefined>;
  /** True the first time this key is seen for the connection, false after. */
  claim(id: string, requestKey: string): Promise<boolean>;
  /** The member a chat user is linked to in the connection's organisation. */
  member(id: string, chatUserId: string): Promise<ChatMember | undefined>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CHAT_ROLE = "gaugeline_chat";

/** One transaction as gaugeline_chat, checked: a login without the role fails here, not later. */
async function asChat<T>(sql: postgres.Sql, fn: (tx: postgres.TransactionSql) => Promise<T>) {
  return (await sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${CHAT_ROLE}`);
    await tx.unsafe("set local statement_timeout = 10000");
    const rows = await tx`select current_user as u`;
    if (rows[0]?.u !== CHAT_ROLE) throw new Error(`the chat endpoint must run as ${CHAT_ROLE}`);
    return fn(tx);
  })) as T;
}

export function sqlChatStore(sql: postgres.Sql): ChatStore {
  return {
    async connection(id) {
      if (!UUID.test(id)) return undefined;
      const rows = await asChat(sql, (tx) => tx`select * from private.chat_connection(${id})`);
      const r = rows[0];
      if (!r) return undefined;
      return {
        id,
        orgId: r.org_id as string,
        provider: r.provider as ChatProvider,
        workspaceRef: (r.workspace_ref as string | null) ?? null,
      };
    },
    async signingSecret(id) {
      if (!UUID.test(id)) return undefined;
      const rows = await asChat(sql, (tx) => tx`select private.chat_signing_secret(${id}) as s`);
      const s = rows[0]?.s as string | null | undefined;
      return s ? s : undefined;
    },
    async claim(id, requestKey) {
      if (!UUID.test(id)) return false;
      const rows = await asChat(
        sql,
        (tx) => tx`select private.chat_claim_request(${id}, ${requestKey}) as ok`,
      );
      return rows[0]?.ok === true;
    },
    async member(id, chatUserId) {
      if (!UUID.test(id)) return undefined;
      const rows = await asChat(
        sql,
        (tx) => tx`select * from private.chat_member(${id}, ${chatUserId})`,
      );
      const r = rows[0];
      return r ? { userId: r.user_id as string, role: r.role as string } : undefined;
    },
  };
}
