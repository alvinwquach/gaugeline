import type { CheckContext, Finding } from "../model.js";
import { defineCheck } from "../model.js";
import type { PageSnapshot } from "../snapshot.js";
import {
  adminList,
  adminsOf,
  clientAccess,
  describeClient,
  systemLabel,
} from "../handoff/judge.js";
import type { Handoff } from "../handoff/reader.js";
import type { PeopleSystem, System } from "../handoff/types.js";

/** The handoff reader, or undefined when the run did not ask for a handoff. Without it these checks do nothing. */
const reader = (ctx: CheckContext): Handoff | undefined => ctx.handoff;

const urlOf = (system: System): string => `handoff:${system.id}`;

/**
 * The people systems of a handoff, and a could-not-check for each system that should have been read and
 * was not (a missing token, a refusal, an outage). Only that system is affected: the rest is judged.
 */
async function read(
  page: PageSnapshot,
  ctx: CheckContext,
): Promise<{ handoff: Handoff; systems: PeopleSystem[] } | undefined> {
  const handoff = reader(ctx);
  if (!handoff) return undefined;
  const all = await handoff.systems(page);
  for (const s of all) if (s.kind === "could-not-check") ctx.couldNotCheck?.(urlOf(s), s.reason);
  return { handoff, systems: all.filter((s): s is PeopleSystem => s.kind === "people") };
}

export const clientNotAdmin = defineCheck<PageSnapshot>({
  id: "client-not-admin",
  size: "S",
  done: "The client's own address is an owner or admin of the system, accepted and signed in once, so they can get in and add or remove people without you.",
  estimateChanges:
    "Minutes in the provider's members page if you are an owner. Longer when the account belongs to a former agency or a teammate who has to be reached to promote anyone.",
  area: "Security & email",
  severity: "high",
  title: "The client is not an owner or admin of a system their site depends on",
  what: "In a system Gaugeline could read, none of the client's addresses (gaugeline.handoff.json) holds an owner or admin role that has been accepted.",
  why: "If you are away, or the relationship ends, the client cannot add a new developer, change a plan or recover the account without asking you, and a lockout can take days to undo while the site's content is out of reach.",
  fix: "Ask a current owner to invite the client's own address as an owner or admin and have them accept it, or promote them if they are already a member. Then run the handoff again.",
  tech: "Read-only, GET only, with the tokens already in the environment: Vercel (GAUGELINE_VERCEL_TOKEN: the project, its team and the team's members), Sanity (SANITY_TOKEN: the project's members and their profiles) and Google Business Profile (GOOGLE_BUSINESS_PROFILE_TOKEN: the location's administrators). Each provider's role is mapped to owner, admin, member or viewer; an invitation not yet accepted is not a role. Addresses are compared in lower case and shown only as their first letter and domain. A system whose token may not list members, or whose members' addresses are hidden, is could-not-check for that system alone; no client address in the settings is could-not-check for all",
  async run(page, ctx) {
    const got = await read(page, ctx);
    if (!got) return [];
    const { handoff, systems } = got;
    if (!handoff.people.hasClient) {
      if (systems.length > 0)
        ctx.couldNotCheck?.(
          "handoff:config",
          "no client address is listed under clientEmails in gaugeline.handoff.json, so Gaugeline cannot say whether the client can get in",
        );
      return [];
    }
    const out: Finding[] = [];
    for (const s of systems) {
      const access = clientAccess(s, handoff.people);
      if (access === "admin") continue;
      if (access === "unknown") {
        ctx.couldNotCheck?.(
          urlOf(s),
          `${systemLabel(s)}: an owner or admin shows no address, so Gaugeline cannot tell whether it is the client's`,
        );
        continue;
      }
      out.push({
        checkId: "client-not-admin",
        severity: "high",
        title: this.title,
        evidence: `${systemLabel(s)}: the owners and admins are ${adminList(adminsOf(s))}; ${describeClient(s)}`,
        url: urlOf(s),
      });
    }
    return out;
  },
});

export const singleAdmin = defineCheck<PageSnapshot>({
  id: "single-admin",
  size: "S",
  done: "At least two different people can let others in or out of the system, and one of them is the client.",
  estimateChanges:
    "Minutes in the provider's members page. It needs the client to accept an invitation, which can take as long as they take to open an email.",
  area: "Security & email",
  severity: "medium",
  title: "The freelancer is the only owner or admin of a system the client depends on",
  what: "A system has exactly one owner or admin that has accepted, and it is one of the freelancer's addresses (gaugeline.handoff.json). Two addresses listed together under sameAs count as one person.",
  why: "One person is the single way in. If their login is lost, their account is closed or they are unreachable, nobody can add anyone, and the client has to wait for them.",
  fix: "Make a second person an owner or admin: the client first, and ideally a teammate you trust as well. Then run the handoff again.",
  tech: "Read as client-not-admin does. Owners and admins who have accepted, and who are not an API token, are counted by person: the addresses a person is listed under in sameAs share one key. Exactly one such person, whose address is in freelancerEmails, is the finding. A system whose members could not be read is could-not-check, never a pass",
  async run(page, ctx) {
    const got = await read(page, ctx);
    if (!got) return [];
    const out: Finding[] = [];
    for (const s of got.systems) {
      const admins = adminsOf(s);
      const people = new Set(admins.map((m) => m.person));
      const only = admins[0];
      if (people.size !== 1 || !only || only.party !== "freelancer") continue;
      out.push({
        checkId: "single-admin",
        severity: "medium",
        title: this.title,
        evidence: `${systemLabel(s)}: the only owner or admin is ${only.who}, an address of the freelancer's`,
        url: urlOf(s),
      });
    }
    return out;
  },
});

export const personalAccount = defineCheck<PageSnapshot>({
  id: "personal-account",
  size: "M",
  done: "The project lives in a team or organisation account that the client owns, and it has been moved there without a break in the site.",
  estimateChanges:
    "Moving a project between accounts can change its address, its environment variables and its domain settings. Plan an hour for a small site, and check the site afterwards.",
  area: "Security & email",
  severity: "medium",
  title: "A system the site depends on lives in a personal account",
  what: "The project that serves or feeds the site belongs to one person's account, not to a team or organisation.",
  why: "A personal account is one person's login. It has no list of members to add the client to, it cannot outlive that person's access, and it often belongs to the freelancer who set the site up, so the client's site is tied to a login that is not theirs.",
  fix: "Create a team or organisation owned by the client (or by both of you), move the project into it, and give the client's own address the owner role. Then run the handoff again.",
  tech: "Vercel: the project's accountId. An id that begins with team_ is a team; any other is a personal account, whose one owner is the token's own user (GET /v2/user). Other systems report a personal account only when their API says so. A project whose owner cannot be told apart is could-not-check",
  async run(page, ctx) {
    const got = await read(page, ctx);
    if (!got) return [];
    const out: Finding[] = [];
    for (const s of got.systems) {
      if (s.account.kind !== "personal") continue;
      const owners = adminsOf(s);
      out.push({
        checkId: "personal-account",
        severity: "medium",
        title: this.title,
        evidence: `${systemLabel({ ...s, account: { kind: "unknown" } })} is in a personal account, not a team${owners.length > 0 ? `: its owner is ${owners.map((m) => m.who).join(" and ")}` : ""}`,
        url: urlOf(s),
      });
    }
    return out;
  },
});

export const HANDOFF_CHECKS = [clientNotAdmin, singleAdmin, personalAccount] as const;
