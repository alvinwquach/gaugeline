// check-community: allow-email (invented addresses at reserved example domains, in the stand-ins for the providers' answers)
import { recordedTransport, type Recorded, type Seen } from "../../renewals/__tests__/recorded.js";
import { bootstrapFor } from "../../renewals/__tests__/rdap-fixtures.js";
import type { Transport } from "../../fetcher.js";

/**
 * The invented world the handoff tests and docs run in, answered from recorded responses (nothing touches
 * a network). Two clients of one freelancer, Harbour Studio, on 11 Nov 2026:
 *  - marlowe-bar.com, a bar. The site is on Vercel in the studio's team, its content is in a Sanity
 *    project the studio administers, and its Google Business Profile belongs to the owner. The owner has
 *    been invited to the Vercel team and is only an editor in Sanity.
 *  - juniper-coaching.com, a coach. She signed up for Vercel herself: a personal account, which she owns.
 *    Her Sanity project is not named in any config, so only Vercel and the domain are read.
 */
export const NOW = new Date("2026-11-11T09:00:00Z");

/** Invented keys, built at run time so no key-shaped string sits in the repository. */
export const VERCEL_TOKEN = ["vercel", "-invented-", "token", "han0001"].join("");
export const SANITY_TOKEN = ["sk", "INVENTED", "sanity", "han0002"].join("");
export const GOOGLE_TOKEN = ["ya29.", "invented", "-google-", "han0003"].join("");
export const ENV = {
  NO_COLOR: "1",
  GAUGELINE_VERCEL_TOKEN: VERCEL_TOKEN,
  SANITY_TOKEN,
  SANITY_PROJECT_ID: "abc123xy",
  GOOGLE_BUSINESS_PROFILE_TOKEN: GOOGLE_TOKEN,
};

/** The addresses in the fixtures. The freelancer's two are one person. */
export const CLIENT = "rosa@marlowe-bar.example";
export const FREELANCER = "dev@harbour-studio.example";
export const FREELANCER_HOME = "dev.harbour@mail.example";
export const TEAMMATE = "mia@harbour-studio.example";
export const COACH = "ana@juniper-coaching.example";

export const BAR_HANDOFF = {
  clientEmails: [CLIENT],
  freelancerEmails: [FREELANCER, FREELANCER_HOME, TEAMMATE],
  sameAs: [[FREELANCER, FREELANCER_HOME]],
  vercel: { project: "marlowe-bar-site", teamId: "team_harbour01" },
  sanity: { projectId: "abc123xy" },
};
export const BAR_LISTINGS = { google: { location: "locations/1234567890" } };
export const COACH_HANDOFF = {
  clientEmails: [COACH],
  freelancerEmails: [FREELANCER],
  vercel: { project: "juniper-site" },
};

const registrar = (name: string) => ({
  objectClassName: "entity",
  roles: ["registrar"],
  vcardArray: [
    "vcard",
    [
      ["version", {}, "text", "4.0"],
      ["fn", {}, "text", name],
    ],
  ],
});

/** A registrant entity a registry has blanked, as .com registries have since 2018. */
export const REDACTED_REGISTRANT = {
  objectClassName: "entity",
  roles: ["registrant"],
  vcardArray: [
    "vcard",
    [
      ["version", {}, "text", "4.0"],
      ["fn", {}, "text", "REDACTED FOR PRIVACY"],
    ],
  ],
  remarks: [
    {
      title: "REDACTED FOR PRIVACY",
      description: ["Some of the data in this object has been removed."],
    },
  ],
};

const ns = (name: string) => ({ objectClassName: "nameserver", ldhName: name });

const PAGE = (extra: string) =>
  `<!doctype html><html lang=en><head><title>Marlowe Bar</title></head><body><h1>Marlowe Bar</h1><p>Open Tuesday to Sunday.</p>${extra}</body></html>`;

/** What each member of the studio's Vercel team looks like in the team's member list. */
export const VERCEL_MEMBERS = {
  members: [
    { uid: "u_dev", email: FREELANCER, role: "OWNER", confirmed: true },
    { uid: "u_mia", email: TEAMMATE, role: "MEMBER", confirmed: true },
    { uid: "u_rosa", email: CLIENT, role: "MEMBER", confirmed: false },
  ],
  pagination: { count: 3, next: null },
};

export const SANITY_PROJECT = {
  id: "abc123xy",
  displayName: "Marlowe Bar",
  organizationId: "org_harbour",
  members: [
    { id: "su_dev", role: "administrator", isRobot: false, isCurrentUser: true },
    { id: "su_rosa", role: "editor", isRobot: false, isCurrentUser: false },
    { id: "su_bot", role: "viewer", isRobot: true, isCurrentUser: false },
  ],
};
export const SANITY_USERS = [
  { id: "su_dev", displayName: "Dev", email: FREELANCER_HOME },
  { id: "su_rosa", displayName: "Rosa", email: CLIENT },
];

export const GOOGLE_ADMINS = {
  admins: [
    {
      name: "locations/1234567890/admins/a1",
      admin: CLIENT,
      role: "PRIMARY_OWNER",
      pendingInvitation: false,
    },
    {
      name: "locations/1234567890/admins/a2",
      admin: FREELANCER,
      role: "MANAGER",
      pendingInvitation: false,
    },
  ],
};

export function world(over: Record<string, Recorded> = {}): { transport: Transport; seen: Seen[] } {
  return recordedTransport({
    "GET https://marlowe-bar.com/": {
      status: 200,
      headers: {
        "content-type": "text/html",
        "x-vercel-id": "fra1::abcde-1731315600000-0123456789ab",
      },
      body: PAGE(
        '<script src="https://js.stripe.com/v3/"></script><img src="https://cdn.sanity.io/images/abc123xy/production/bar-1200x800.jpg" alt="The bar">',
      ),
    },
    "GET https://data.iana.org/rdap/dns.json": {
      status: 200,
      body: bootstrapFor("https://rdap.registry.example", { com: "/com/v1/", uk: "/uk/v1/" }),
    },
    "GET https://rdap.registry.example/com/v1/domain/marlowe-bar.com": {
      status: 200,
      body: {
        objectClassName: "domain",
        ldhName: "marlowe-bar.com",
        status: ["client transfer prohibited"],
        events: [{ eventAction: "expiration", eventDate: "2026-12-03T14:02:11Z" }],
        entities: [registrar("Plume Registrar, Inc."), REDACTED_REGISTRANT],
        nameservers: [ns("ada.ns.cloudflare.com"), ns("bob.ns.cloudflare.com")],
      },
    },
    "GET https://api.vercel.com/v9/projects/marlowe-bar-site?teamId=team_harbour01": {
      status: 200,
      body: { id: "prj_bar", name: "marlowe-bar-site", accountId: "team_harbour01" },
    },
    "GET https://api.vercel.com/v2/teams/team_harbour01": {
      status: 200,
      body: { id: "team_harbour01", slug: "harbour-studio", name: "Harbour Studio" },
    },
    "GET https://api.vercel.com/v3/teams/team_harbour01/members?limit=100": {
      status: 200,
      body: VERCEL_MEMBERS,
    },
    "GET https://api.sanity.io/v2021-06-07/projects/abc123xy": {
      status: 200,
      body: SANITY_PROJECT,
    },
    "GET https://api.sanity.io/v2021-06-07/projects/abc123xy/users/su_dev,su_rosa": {
      status: 200,
      body: SANITY_USERS,
    },
    "GET https://mybusinessaccountmanagement.googleapis.com/v1/locations/1234567890/admins": {
      status: 200,
      body: GOOGLE_ADMINS,
    },
    // The coach: a personal Vercel account that she owns.
    "GET https://juniper-coaching.com/": {
      status: 200,
      headers: {
        "content-type": "text/html",
        "x-vercel-id": "iad1::zzzzz-1731315600000-0123456789ab",
      },
      body: PAGE(""),
    },
    "GET https://rdap.registry.example/com/v1/domain/juniper-coaching.com": {
      status: 200,
      body: {
        objectClassName: "domain",
        ldhName: "juniper-coaching.com",
        status: ["client transfer prohibited"],
        events: [{ eventAction: "expiration", eventDate: "2027-05-20T10:00:00Z" }],
        entities: [registrar("Harbour Names Ltd")],
        nameservers: [ns("ns1.vercel-dns.com"), ns("ns2.vercel-dns.com")],
      },
    },
    "GET https://api.vercel.com/v9/projects/juniper-site": {
      status: 200,
      body: { id: "prj_jun", name: "juniper-site", accountId: "uid_ana01" },
    },
    "GET https://api.vercel.com/v2/user": {
      status: 200,
      body: { user: { id: "uid_ana01", email: COACH, username: "ana-coach" } },
    },
    ...over,
  });
}
