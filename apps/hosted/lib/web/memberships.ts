/** Who the signed-in person is in each organisation, read as them (the policies apply). */
import type { Tx } from "./db.js";

export type Role = "owner" | "admin" | "member" | "client";

export interface Membership {
  orgId: string;
  orgName: string;
  role: Role;
  /** A client viewer's one site; null for everyone else. */
  siteId: string | null;
}

export const ROLE_LABEL: Readonly<Record<Role, string>> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  client: "Client viewer",
};

/** The person's organisations, by name. The explicit user_id filter is for clarity: the policies already limit it. */
export async function listMemberships(tx: Tx, userId: string): Promise<Membership[]> {
  const rows = await tx`
    select m.org_id, o.name as org_name, m.role, m.site_id
    from public.members m join public.organisations o on o.org_id = m.org_id
    where m.user_id = ${userId}
    order by o.name, m.org_id`;
  return rows.map((r) => ({
    orgId: r.org_id as string,
    orgName: r.org_name as string,
    role: r.role as Role,
    siteId: (r.site_id as string | null) ?? null,
  }));
}

/** The organisation to show: the one chosen (if the person is in it), else the first by name. */
export function pickOrg(
  memberships: Membership[],
  chosen: string | undefined,
): Membership | undefined {
  return memberships.find((m) => m.orgId === chosen) ?? memberships[0];
}

export interface SiteRow {
  id: string;
  name: string;
  url: string;
  /** IANA name; sets when the nightly run starts and the zone the page shows times in. */
  timezone: string;
}

/**
 * The sites to offer in an organisation. A client viewer is held to their one site here as well as by the
 * database: the page must not depend on the policy alone to hold back what a viewer should not be offered.
 */
export async function listSites(tx: Tx, m: Membership): Promise<SiteRow[]> {
  if (m.role === "client" && !m.siteId) return [];
  const rows = await tx`
    select id, name, url, timezone from public.sites
    where org_id = ${m.orgId} ${m.role === "client" ? tx`and id = ${m.siteId}` : tx``}
    order by name, id`;
  return rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    url: r.url as string,
    timezone: r.timezone as string,
  }));
}
