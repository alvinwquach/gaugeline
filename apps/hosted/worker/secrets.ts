/**
 * Secrets an organisation gives the hosted app (V-01): notification webhook URLs (X67) and chat signing
 * secrets (X69). The Vault store calls private.put_secret / get_secret / delete_secret (migration 0006) as
 * service_role; the memory store is for unit tests and is refused in production.
 *
 * Nothing here ever puts a value into a log, an error message or a list: errors are a SecretError with a
 * code and a fixed message, and a database error is replaced, not wrapped, because a driver error can
 * carry the query's parameters. CMS tokens and the GitHub App key are never stored (docs/hosted/secrets.md).
 */
import type postgres from "postgres";
import { withService } from "../lib/api/db.js";

export type SecretKind = "webhook_url" | "signing_secret";
export const SECRET_KINDS: readonly SecretKind[] = ["webhook_url", "signing_secret"];
export const MAX_SECRET_BYTES = 4096;
const NAME = /^[a-z][a-z0-9_.-]{0,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SecretMeta {
  name: string;
  kind: SecretKind;
  createdAt: Date;
  rotatedAt: Date | null;
}

export interface SecretStore {
  /** Store a new secret ("created") or replace the value of an existing one ("rotated"). */
  put(orgId: string, name: string, kind: SecretKind, value: string): Promise<"created" | "rotated">;
  /** The value, or null when the organisation has no secret by that name. */
  get(orgId: string, name: string): Promise<string | null>;
  /** True when a secret was deleted, false when there was none. */
  delete(orgId: string, name: string): Promise<boolean>;
  /** Names, kinds and dates for one organisation, by name. Never a value. */
  list(orgId: string): Promise<SecretMeta[]>;
}

export type SecretErrorCode =
  | "invalid-org"
  | "invalid-name"
  | "invalid-kind"
  | "invalid-value"
  | "kind-mismatch"
  | "unavailable";

const MESSAGES: Record<SecretErrorCode, string> = {
  "invalid-org": "organisation id is not a known organisation",
  "invalid-name": "secret name must be 1 to 63 of a-z 0-9 _ . - starting with a letter",
  "invalid-kind": `secret kind must be one of ${SECRET_KINDS.join(", ")}`,
  "invalid-value": `secret value must be 1 to ${MAX_SECRET_BYTES} bytes`,
  "kind-mismatch": "a secret keeps its kind: delete it first",
  unavailable: "the secret store could not complete the request",
};

/** A fixed message per code: never the value, the name's owner or a driver error. */
export class SecretError extends Error {
  constructor(readonly code: SecretErrorCode) {
    super(MESSAGES[code]);
    this.name = "SecretError";
  }
}

function checkKey(orgId: string, name: string): void {
  if (!UUID.test(orgId)) throw new SecretError("invalid-org");
  if (!NAME.test(name)) throw new SecretError("invalid-name");
}

function checkPut(orgId: string, name: string, kind: SecretKind, value: string): void {
  checkKey(orgId, name);
  if (!SECRET_KINDS.includes(kind)) throw new SecretError("invalid-kind");
  const bytes = typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0;
  if (bytes < 1 || bytes > MAX_SECRET_BYTES) throw new SecretError("invalid-value");
}

/** In memory, for tests. A Map keyed by organisation, then by name: one lookup each, no scan. */
export function memorySecretStore(): SecretStore {
  const orgs = new Map<string, Map<string, SecretMeta & { value: string }>>();
  return {
    async put(orgId, name, kind, value) {
      checkPut(orgId, name, kind, value);
      const org = orgs.get(orgId) ?? new Map();
      orgs.set(orgId, org);
      const old = org.get(name);
      if (old && old.kind !== kind) throw new SecretError("kind-mismatch");
      const now = new Date();
      org.set(name, {
        name,
        kind,
        value,
        createdAt: old?.createdAt ?? now,
        rotatedAt: old ? now : null,
      });
      return old ? "rotated" : "created";
    },
    async get(orgId, name) {
      checkKey(orgId, name);
      return orgs.get(orgId)?.get(name)?.value ?? null;
    },
    async delete(orgId, name) {
      checkKey(orgId, name);
      return orgs.get(orgId)?.delete(name) ?? false;
    },
    async list(orgId) {
      if (!UUID.test(orgId)) throw new SecretError("invalid-org");
      return [...(orgs.get(orgId)?.values() ?? [])]
        .map(({ name, kind, createdAt, rotatedAt }) => ({ name, kind, createdAt, rotatedAt }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
  };
}

/** Map a database error to a code. The original error is dropped: it may hold the query's parameters. */
function fromDatabase(e: unknown): SecretError {
  const pg = e as { code?: string; message?: string };
  if (pg.code === "23503") return new SecretError("invalid-org");
  if (pg.code === "22023" && /keeps its kind/.test(pg.message ?? ""))
    return new SecretError("kind-mismatch");
  if (pg.code === "22023" && /name/.test(pg.message ?? "")) return new SecretError("invalid-name");
  if (pg.code === "22023" && /kind/.test(pg.message ?? "")) return new SecretError("invalid-kind");
  if (pg.code === "22023") return new SecretError("invalid-value");
  return new SecretError("unavailable");
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof SecretError) throw e;
    throw fromDatabase(e);
  }
}

/** Supabase Vault through migration 0006's functions, one service_role transaction per call. */
export function vaultSecretStore(sql: postgres.Sql): SecretStore {
  return {
    async put(orgId, name, kind, value) {
      checkPut(orgId, name, kind, value);
      return guarded(() =>
        withService(sql, async (tx) => {
          const r = await tx`select private.put_secret(${orgId}, ${name}, ${kind}, ${value}) as r`;
          return r[0]!.r as "created" | "rotated";
        }),
      );
    },
    async get(orgId, name) {
      checkKey(orgId, name);
      return guarded(() =>
        withService(sql, async (tx) => {
          const r = await tx`select private.get_secret(${orgId}, ${name}) as v`;
          return (r[0]?.v as string | null) ?? null;
        }),
      );
    },
    async delete(orgId, name) {
      checkKey(orgId, name);
      return guarded(() =>
        withService(sql, async (tx) => {
          const r = await tx`select private.delete_secret(${orgId}, ${name}) as r`;
          return r[0]!.r === true;
        }),
      );
    },
    async list(orgId) {
      if (!UUID.test(orgId)) throw new SecretError("invalid-org");
      return guarded(() =>
        withService(sql, async (tx) => {
          const rows = await tx`select name, kind, created_at, rotated_at from private.secret_refs
            where org_id = ${orgId} order by name`;
          return rows.map((r) => ({
            name: r.name as string,
            kind: r.kind as SecretKind,
            createdAt: r.created_at as Date,
            rotatedAt: (r.rotated_at as Date | null) ?? null,
          }));
        }),
      );
    },
  };
}

/**
 * Pick the store from GAUGELINE_SECRET_STORE: "vault" (needs the worker's database connection) or
 * "memory" (tests and local development only; refused when NODE_ENV is production). No default, so a
 * deploy that forgot the variable fails at start-up instead of silently keeping secrets in memory.
 */
export function secretStoreFrom(
  env: Record<string, string | undefined>,
  sql?: postgres.Sql,
): SecretStore {
  const kind = env.GAUGELINE_SECRET_STORE;
  if (kind === "vault") {
    if (!sql)
      throw new Error("GAUGELINE_SECRET_STORE=vault needs the worker's database connection");
    return vaultSecretStore(sql);
  }
  if (kind === "memory") {
    if (env.NODE_ENV === "production")
      throw new Error("GAUGELINE_SECRET_STORE=memory is for tests; production uses vault");
    return memorySecretStore();
  }
  throw new Error('GAUGELINE_SECRET_STORE must be "vault" or "memory"');
}
