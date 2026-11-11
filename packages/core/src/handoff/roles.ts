import type { Role } from "./types.js";

/** Only an owner or an admin can let someone in or take someone out. */
export function isAdminRole(role: Role): boolean {
  return role === "owner" || role === "admin";
}

const RANK: Readonly<Record<Role, number>> = {
  owner: 4,
  admin: 3,
  member: 2,
  viewer: 1,
  unknown: 0,
};

const upper = (raw: string): string =>
  raw
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");

/**
 * Vercel's team roles. OWNER is the only one that manages members and settings; the others work in
 * projects (MEMBER, DEVELOPER, SECURITY, CONTRIBUTOR), look after billing (BILLING) or look (the two
 * VIEWER roles). A role Gaugeline does not know is "unknown", never a guess.
 */
export function vercelRole(raw: string): Role {
  switch (upper(raw)) {
    case "OWNER":
      return "owner";
    case "MEMBER":
    case "DEVELOPER":
    case "SECURITY":
    case "BILLING":
    case "CONTRIBUTOR":
      return "member";
    case "VIEWER":
    case "VIEWER_FOR_PLUS":
      return "viewer";
    default:
      return "unknown";
  }
}

/** One of Sanity's role names. A custom role has a name Gaugeline cannot read the power of, so it is "unknown". */
function sanityOne(raw: string): Role {
  switch (raw.trim().toLowerCase()) {
    case "owner":
      return "owner";
    case "administrator":
      return "admin";
    case "editor":
    case "developer":
    case "contributor":
    case "deploy-studio":
      return "member";
    case "viewer":
      return "viewer";
    default:
      return "unknown";
  }
}

/** Sanity's role (or the list of roles a member holds): the highest wins. */
export function sanityRole(raw: string | readonly string[]): Role {
  const all = (typeof raw === "string" ? [raw] : raw).map(sanityOne);
  return all.reduce<Role>((best, r) => (RANK[r] > RANK[best] ? r : best), "unknown");
}

/**
 * Google Business Profile's location roles. Both kinds of owner can add and remove users; a manager
 * and a site manager work on the profile and cannot.
 */
export function googleRole(raw: string): Role {
  switch (upper(raw)) {
    case "PRIMARY_OWNER":
    case "OWNER":
      return "owner";
    case "MANAGER":
    case "SITE_MANAGER":
      return "member";
    default:
      return "unknown";
  }
}
