/**
 * What a handoff report is made of. A system is one place a client's site depends on (the domain, the
 * hosting, the content studio, the business listing). For each one Gaugeline reads who holds it, with
 * the tokens the freelancer already has and only through GET, or says why it could not and what to
 * check by hand. Nothing here holds a secret or a full email address: a person is a masked address, a
 * role and a party, and the only identifier kept is a one-way key used to count one person once.
 */

/** What a member can do in the system, in the report's own four words, or "unknown" for a role it does not know. */
export type Role = "owner" | "admin" | "member" | "viewer" | "unknown";

/** Whose address it is, by gaugeline.handoff.json: the client's, the freelancer's, anyone else's, or not shown at all. */
export type Party = "client" | "freelancer" | "other" | "unknown";

/** A member as the provider listed them, before the address is masked. Never leaves the reader. */
export interface RawMember {
  email?: string;
  /** The provider's own id, used only to label a member whose address is not shown. */
  id?: string;
  role: Role;
  /** The provider's word for the role, as written ("OWNER", "administrator"). */
  rawRole: string;
  /** Invited and not yet accepted. */
  pending?: boolean;
  /** An API token or robot, not a person. */
  token?: boolean;
}

export interface Member {
  /** The masked address ("o***@client.example"), or "an account whose address the provider does not show". */
  who: string;
  party: Party;
  /** One key for one person: two addresses the config says belong together share it. Not printed. */
  person: string;
  role: Role;
  rawRole: string;
  pending: boolean;
  token: boolean;
}

/** Who owns the project: a team or organisation, or a person's own account. */
export interface Account {
  kind: "team" | "personal" | "unknown";
  name?: string;
}

/** The answer a provider reader gives: the members, or why they could not be read. */
export type SourceRead =
  | { ok: true; subject: string; account: Account; members: RawMember[]; notes: string[] }
  | { ok: false; reason: string };

/** A system where the provider lists its members, so the report can say who can get in. */
export interface PeopleSystem {
  kind: "people";
  id: string;
  name: string;
  /** What in the system is meant: a project name, a location. */
  subject: string;
  account: Account;
  members: Member[];
  notes: string[];
  /** Where the owner adds a member, when the provider has a page for it. */
  help?: string;
}

/** The domain's registration, from the registry's public RDAP record. The account holder is not in it. */
export interface DomainSystem {
  kind: "domain";
  id: "domain";
  name: string;
  subject: string;
  registrar?: string;
  /** What the registry shows of the registrant: nothing (redacted or not listed), or a published name. */
  registrant: "redacted" | "not-listed" | "published";
  notes: string[];
}

/** Whose name servers answer for the domain. */
export interface DnsSystem {
  kind: "dns";
  id: "dns";
  name: string;
  subject: string;
  provider?: string;
  nameservers: string[];
  /** Where the name servers were read: the registry's record, or a live DNS lookup (--dns). */
  source: "registry" | "dns";
  help?: string;
  notes: string[];
}

/** A system whose users Gaugeline does not read: a line to check by hand, never a guess. */
export interface ManualSystem {
  kind: "manual";
  id: string;
  name: string;
  /** Why it is not read: the provider's API does not list users, or no adapter reads it. */
  why: string;
  /** True when the page shows the site uses it; false when the config asked for it or it is always listed. */
  detected: boolean;
  help?: string;
}

/** A system that should have been read and was not: no token, no permission, an outage. Only this system is affected. */
export interface UnreadSystem {
  kind: "could-not-check";
  id: string;
  name: string;
  subject?: string;
  reason: string;
  help?: string;
}

export type System = PeopleSystem | DomainSystem | DnsSystem | ManualSystem | UnreadSystem;

/** What the client can do in a people system. */
export type ClientAccess = "admin" | "member" | "invited" | "none" | "unknown";
