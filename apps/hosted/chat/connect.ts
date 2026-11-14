/**
 * Connecting a chat workspace (X69): the signing secret goes to the SecretStore (Vault), then the
 * connection row that names it. Run by the settings API or the worker as service_role, never by the chat
 * login. A connection MUST name its workspace (a Slack team id, a Discord server id): a signed request that
 * names another is refused, and a connection that names none would check nothing, so none is created
 * (decideFromChat also refuses one written any other way). A Discord connection's "secret" is the
 * application's public key, kept like every other signing value.
 */
import { type Sql, withService } from "../lib/api/db.js";
import type { SecretStore } from "../worker/secrets.js";
import type { ChatProvider } from "./store.js";

const WORKSPACE: Record<ChatProvider, { pattern: RegExp; what: string } | undefined> = {
  slack: { pattern: /^[A-Z][A-Z0-9]{2,30}$/, what: "a Slack team id (T0...)" },
  discord: { pattern: /^[0-9]{5,25}$/, what: "a Discord server id (digits)" },
  // Teams has no verified scheme yet (docs/hosted/chat-approvals.md): nothing can be connected.
  teams: undefined,
};
const SECRET_SHAPE: Record<ChatProvider, RegExp> = {
  slack: /^.{8,4096}$/s,
  discord: /^[0-9a-f]{64}$/i,
  teams: /^$/,
};

export interface ChatConnectionInput {
  orgId: string;
  provider: ChatProvider;
  label: string;
  /** The provider's own id for the workspace: required. */
  workspaceRef: string;
  /** Slack's signing secret, or Discord's application public key (64 hex characters). */
  signingSecret: string;
}

export class ConnectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectError";
  }
}

export async function connectChat(
  deps: { sql: Sql; secrets: SecretStore },
  input: ChatConnectionInput,
): Promise<{ connectionId: string; secretName: string }> {
  const rule = WORKSPACE[input.provider];
  if (!rule) throw new ConnectError(`${input.provider} cannot be connected yet`);
  if (typeof input.workspaceRef !== "string" || !rule.pattern.test(input.workspaceRef))
    throw new ConnectError(`a ${input.provider} connection needs its workspace: ${rule.what}`);
  if (typeof input.label !== "string" || input.label.length < 1 || input.label.length > 80)
    throw new ConnectError("a label is 1 to 80 characters");
  if (
    typeof input.signingSecret !== "string" ||
    !SECRET_SHAPE[input.provider].test(input.signingSecret)
  )
    throw new ConnectError(`that is not a ${input.provider} signing value`);
  // One secret per workspace; saving again rotates it. Lowercase: a secret name is a-z 0-9 . _ -
  const secretName = `chat-${input.provider}-${input.workspaceRef.toLowerCase()}`;
  const stored = await deps.secrets.put(
    input.orgId,
    secretName,
    "signing_secret",
    input.signingSecret,
  );
  try {
    // One connection per organisation, provider and workspace: connecting again only rotates the secret.
    const id = await withService(deps.sql, async (tx) => {
      const [old] = await tx`select id from public.chat_connections
        where org_id = ${input.orgId} and provider = ${input.provider} and workspace_ref = ${input.workspaceRef}`;
      if (old) return old.id as string;
      const [row] =
        await tx`insert into public.chat_connections (org_id, provider, label, workspace_ref, secret_name)
        values (${input.orgId}, ${input.provider}, ${input.label}, ${input.workspaceRef}, ${secretName})
        returning id`;
      return row!.id as string;
    });
    return { connectionId: id, secretName };
  } catch {
    // A secret this call created, for a connection that does not exist: take it back (never one it only
    // rotated, which another connection may use), and say nothing of the value.
    if (stored === "created") await deps.secrets.delete(input.orgId, secretName).catch(() => false);
    throw new ConnectError("the connection could not be saved");
  }
}
