import type { People } from "./people.js";
import { isAdminRole } from "./roles.js";
import type { ClientAccess, Member, PeopleSystem } from "./types.js";

/** What a system's own members are called in a sentence: "project", "location". */
const NOUN: Readonly<Record<string, string>> = {
  vercel: "project",
  sanity: "project",
  "google-business": "location",
};

/** "Vercel project marlowe-bar-site (team "Harbour Studio")": which system, which part of it, and whose account. */
export function systemLabel(
  system: Pick<PeopleSystem, "id" | "name" | "subject" | "account">,
): string {
  const noun = NOUN[system.id];
  const account =
    system.account.kind === "team"
      ? system.account.name
        ? ` (team "${system.account.name}")`
        : " (a team)"
      : system.account.kind === "personal"
        ? " (a personal account)"
        : "";
  return `${system.name}${noun ? ` ${noun}` : ""} ${system.subject}${account}`;
}

/** The people who can let others in or take them out: an accepted owner or admin, and not a token. */
export function adminsOf(system: PeopleSystem): Member[] {
  return system.members.filter((m) => isAdminRole(m.role) && !m.pending && !m.token);
}

/** "d***@harbour-studio.example (owner), m***@harbour-studio.example (admin)". */
export function adminList(admins: readonly Member[]): string {
  return admins.length === 0 ? "no one" : admins.map((m) => `${m.who} (${m.role})`).join(", ");
}

/**
 * How the client stands in a system: an owner or admin who has accepted (admin); a member with a
 * lower role (member); only invited (invited); not listed (none); or unknown, when there is no client
 * address to look for, or an owner or admin whose address the provider does not show might be the client.
 */
export function clientAccess(system: PeopleSystem, people: People): ClientAccess {
  if (!people.hasClient) return "unknown";
  const clients = system.members.filter((m) => m.party === "client" && !m.token);
  if (clients.some((m) => isAdminRole(m.role) && !m.pending)) return "admin";
  if (adminsOf(system).some((m) => m.party === "unknown")) return "unknown";
  if (clients.some((m) => !m.pending)) return "member";
  if (clients.length > 0) return "invited";
  return "none";
}

/** Says where the client is in the system, in a clause: "r***@x is a member", "none of the client's addresses is listed". */
export function describeClient(system: PeopleSystem): string {
  const clients = system.members.filter((m) => m.party === "client" && !m.token);
  if (clients.length === 0) return "none of the client's addresses is listed";
  return clients
    .map((m) => {
      if (m.pending) return `${m.who} was invited, and has not accepted`;
      if (m.role === "unknown")
        return `${m.who} has a role Gaugeline does not recognise ("${m.rawRole}")`;
      return `${m.who} is ${m.role === "member" ? "a member" : m.role === "viewer" ? "a viewer" : `an ${m.role}`}`;
    })
    .join("; ");
}
