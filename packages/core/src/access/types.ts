import * as z from "zod";
import { ConfigError } from "../errors.js";

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const envName = z
  .string()
  .regex(ENV_NAME, "must be an environment variable's name, like SUPABASE_ANON_KEY");
/** PostgREST table and column names as Gaugeline accepts them: letters, digits and underscores. */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

export const accessTableSchema = z
  .object({
    name: z.string().regex(IDENT, "must be a table name"),
    /** Meant to be readable by anyone (a menu, opening hours). */
    public: z.boolean().optional(),
    /** The column holding the owner's user id: rows are a signed-in user's own when it matches. */
    owner: z.string().regex(IDENT, "must be a column name").optional(),
  })
  .strict();

export const accessUserSchema = z
  .object({
    role: z.string().min(1),
    /** The variable holding a signed-in test user's access token (a JWT from your auth). */
    tokenEnv: envName,
    /** The variable holding that user's id, as stored in the tables' owner columns. */
    userIdEnv: envName,
  })
  .strict();

/**
 * Who may read what, for the project behind the site. Keys and tokens are never in this file:
 * only the names of the environment variables that hold them.
 */
export const accessConfigSchema = z
  .object({
    provider: z.literal("supabase"),
    /** The project address, e.g. https://<ref>.supabase.co. */
    url: z.url({ protocol: /^https$/ }),
    /** The variable holding the project's public (anon) key. */
    anonKeyEnv: envName,
    tables: z.array(accessTableSchema).default([]),
    users: z.array(accessUserSchema).default([]),
    probeWrites: z
      .literal(false, {
        error: "Gaugeline is read-only: it never inserts rows, so write probes are not supported",
      })
      .optional(),
  })
  .strict();

export type AccessConfig = z.infer<typeof accessConfigSchema>;

/** The config with its keys read from the environment. Never logged, never in a finding. */
export interface AccessSettings {
  url: string;
  anonKey: string;
  tables: AccessConfig["tables"];
  users: { role: string; token: string; userId: string }[];
}

/** Read the keys the config names; a variable that is not set stops the run, naming it. */
export function resolveAccess(
  config: AccessConfig,
  env: Record<string, string | undefined>,
): AccessSettings {
  const need = (where: string, name: string): string => {
    const value = env[name];
    if (value === undefined || value === "")
      throw new ConfigError(`gaugeline.access.json: ${where} names ${name}, which is not set.`, {
        hint: `Set ${name} in the environment Gaugeline runs in, or remove the entry.`,
      });
    return value;
  };
  return {
    url: config.url.replace(/\/+$/, ""),
    anonKey: need("anonKeyEnv", config.anonKeyEnv),
    tables: config.tables,
    users: config.users.map((u, i) => ({
      role: u.role,
      token: need(`users.${i}.tokenEnv`, u.tokenEnv),
      userId: need(`users.${i}.userIdEnv`, u.userIdEnv),
    })),
  };
}
