/**
 * Per-site upload tokens. A token is `glt_<8 hex prefix>_<43 random base64url characters>` (256 bits). It is
 * shown once, when minted. Only its SHA-256 is stored, beside the prefix that finds the row: a fast hash is
 * right here because the token is random and long, so there is nothing to guess and nothing to stretch.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { type Sql, type Tx, withService } from "./db.js";

export const TOKEN_PATTERN = /^glt_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/;

export interface NewToken {
  token: string;
  prefix: string;
  hash: string;
}

export const hashToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

export function newToken(): NewToken {
  const prefix = randomBytes(4).toString("hex");
  const token = `glt_${prefix}_${randomBytes(32).toString("base64url")}`;
  return { token, prefix, hash: hashToken(token) };
}

/** The token in an `Authorization: Bearer <token>` header, or null if the header is not that. */
export function parseBearer(header: string | null): string | null {
  const m = header === null ? null : /^Bearer ([^\s]+)$/i.exec(header);
  return m && TOKEN_PATTERN.test(m[1]!) ? m[1]! : null;
}

/** Add a token for a site; the plain token is in the result and nowhere else. Throws for a site that is not in the organisation. */
export async function mintToken(
  sql: Sql,
  site: { orgId: string; siteId: string },
): Promise<{ token: string; id: string; prefix: string }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const t = newToken();
    try {
      const id = await withService(sql, async (tx) => {
        const rows = await tx`insert into public.tokens (org_id, site_id, prefix, token_hash)
          values (${site.orgId}, ${site.siteId}, ${t.prefix}, ${t.hash}) returning id`;
        return rows[0]!.id as string;
      });
      return { token: t.token, id, prefix: t.prefix };
    } catch (e) {
      // A prefix that is already in use: try another. Anything else is the caller's to see.
      if ((e as { code?: string }).code !== "23505" || attempt === 2) throw e;
    }
  }
  throw new Error("unreachable");
}

export async function revokeToken(sql: Sql, id: string): Promise<void> {
  await withService(sql, async (tx) => {
    await tx`update public.tokens set revoked_at = now() where id = ${id} and revoked_at is null`;
  });
}

export interface Authorised {
  tokenId: string;
  orgId: string;
  siteId: string;
}

/** The site a token is for, or null: unknown, revoked and mismatched all look the same. */
export async function authenticate(tx: Tx, token: string): Promise<Authorised | null> {
  const prefix = token.slice(4, 12);
  const rows = await tx`select id, org_id, site_id, token_hash, revoked_at
    from public.tokens where prefix = ${prefix}`;
  const row = rows[0];
  // Compare against something even when no row was found, so a miss takes about as long as a near miss.
  const stored = Buffer.from((row?.token_hash as string | undefined) ?? "0".repeat(64), "hex");
  const given = Buffer.from(hashToken(token), "hex");
  const same = stored.length === given.length && timingSafeEqual(stored, given);
  if (!row || !same || row.revoked_at !== null) return null;
  return { tokenId: row.id as string, orgId: row.org_id as string, siteId: row.site_id as string };
}
