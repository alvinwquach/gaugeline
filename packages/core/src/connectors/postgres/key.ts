/**
 * Which Supabase key may be set. The key is read here and nowhere else: its role claim is decoded
 * locally so a key that bypasses row-level security is refused, and it is never sent anywhere and
 * never printed. Messages name the role, never any part of the key.
 */

export type KeyVerdict = { ok: true; role: string } | { ok: false; message: string };

/** Roles that read around row-level security or administer the project. */
const REFUSED_ROLES: ReadonlySet<string> = new Set([
  "service_role",
  "supabase_admin",
  "postgres",
  "supabase_auth_admin",
  "supabase_storage_admin",
]);

const ADVICE =
  "Use the anon key, or a key for a role you created just for reading (see the Supabase section of docs/connectors/postgres).";

/**
 * Check a key before anything uses it. A JWT is decoded (not verified: Gaugeline never sends it, so
 * there is nothing to protect by verifying) and its `role` claim read. The newer `sb_secret_` keys
 * act as service_role and are refused; `sb_publishable_` keys act as anon.
 */
export function checkSupabaseKey(raw: string): KeyVerdict {
  const key = raw.trim();
  if (key === "") return { ok: false, message: `The Supabase key is empty. ${ADVICE}` };
  if (key.startsWith("sb_secret_"))
    return {
      ok: false,
      message: `That is a Supabase secret key, which acts as service_role and bypasses row-level security, so Gaugeline will not use it. ${ADVICE}`,
    };
  if (key.startsWith("sb_publishable_")) return { ok: true, role: "anon" };
  const parts = key.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p)))
    return {
      ok: false,
      message: `That does not look like a Supabase API key (a JWT with three parts). ${ADVICE}`,
    };
  let role: unknown;
  try {
    const claims: unknown = JSON.parse(
      Buffer.from(parts[1] as string, "base64url").toString("utf8"),
    );
    role =
      claims !== null && typeof claims === "object"
        ? (claims as { role?: unknown }).role
        : undefined;
  } catch {
    return {
      ok: false,
      message: `That does not look like a Supabase API key (its payload cannot be read). ${ADVICE}`,
    };
  }
  if (typeof role !== "string" || role === "")
    return {
      ok: false,
      message: `That key has no role in it, so Gaugeline cannot tell what it can read. ${ADVICE}`,
    };
  if (REFUSED_ROLES.has(role.toLowerCase()))
    return {
      ok: false,
      message: `That key is for the ${role.toLowerCase()} role, which bypasses row-level security, so Gaugeline will not use it. ${ADVICE}`,
    };
  return { ok: true, role };
}
