import { describe, expect, it } from "vitest";
import type { DnsReader } from "../../dns.js";
import { createFetcher } from "../../fetcher.js";
import { createRenewals } from "../../renewals/reader.js";
import { buildSnapshot } from "../../snapshot.js";
import { handoffConfigSchema } from "../config.js";
import { createHandoff } from "../reader.js";
import type { DnsSystem, DomainSystem, PeopleSystem, System } from "../types.js";
import {
  BAR_HANDOFF,
  CLIENT,
  COACH,
  COACH_HANDOFF,
  ENV,
  FREELANCER,
  FREELANCER_HOME,
  GOOGLE_TOKEN,
  SANITY_TOKEN,
  VERCEL_TOKEN,
  world,
} from "./world.js";

async function read(
  address: string,
  config: unknown,
  opts: {
    over?: Parameters<typeof world>[0];
    env?: Record<string, string | undefined>;
    googleLocation?: string;
    dns?: DnsReader;
  } = {},
) {
  const { transport, seen } = world(opts.over);
  const fetcher = createFetcher({ transport });
  const env = opts.env ?? ENV;
  const parsed = handoffConfigSchema.parse(config);
  const renewals = createRenewals({ config: {}, env: {} }, fetcher);
  const handoff = createHandoff(
    {
      config: parsed,
      env,
      ...(opts.googleLocation ? { googleLocation: opts.googleLocation } : {}),
      ...(opts.dns ? { dns: opts.dns } : {}),
    },
    fetcher,
    renewals,
  );
  const snapshot = buildSnapshot(await fetcher.getSite(address));
  return { handoff, snapshot, seen, systems: await handoff.systems(snapshot) };
}

const byId = (systems: System[], id: string) => systems.find((s) => s.id === id);
const BAR = { config: BAR_HANDOFF, googleLocation: "locations/1234567890" };

describe("the systems a handoff reads", () => {
  it("lists the domain, DNS, Vercel, Sanity and Google, then the manual lines the page shows", async () => {
    const { systems } = await read("marlowe-bar.com", BAR.config, BAR);
    expect(systems.map((s) => [s.id, s.kind])).toEqual([
      ["domain", "domain"],
      ["dns", "dns"],
      ["vercel", "people"],
      ["sanity", "people"],
      ["google-business", "people"],
      ["stripe", "manual"],
    ]);
  });

  it("the domain: registrar, and whether the registrant is hidden", async () => {
    const { systems } = await read("marlowe-bar.com", BAR.config, BAR);
    const domain = byId(systems, "domain") as DomainSystem;
    expect(domain.subject).toBe("marlowe-bar.com");
    expect(domain.registrar).toBe("Plume Registrar, Inc.");
    expect(domain.registrant).toBe("redacted");
  });

  it("DNS: the provider from the registry's name servers, no resolver needed", async () => {
    const { systems, seen } = await read("marlowe-bar.com", BAR.config, BAR);
    const dns = byId(systems, "dns") as DnsSystem;
    expect(dns.provider).toBe("Cloudflare");
    expect(dns.source).toBe("registry");
    expect(dns.nameservers).toEqual(["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"]);
    expect(seen.some((s) => s.url.includes("/domain/marlowe-bar.com"))).toBe(true);
  });

  it("DNS with --dns: the live NS records win, and a difference from the registry is noted", async () => {
    const dns: DnsReader = {
      txt: async () => [],
      mx: async () => [],
      ns: async () => ["ns1.vercel-dns.com", "ns2.vercel-dns.com"],
    };
    const { systems } = await read("marlowe-bar.com", BAR.config, { ...BAR, dns });
    const d = byId(systems, "dns") as DnsSystem;
    expect(d.provider).toBe("Vercel");
    expect(d.source).toBe("dns");
    expect(d.notes.join(" ")).toMatch(/registry/);
  });

  it("DNS with --dns when the lookup fails: falls back to the registry and says so", async () => {
    const dns: DnsReader = {
      txt: async () => [],
      mx: async () => [],
      ns: async () => {
        throw new Error("the NS lookup failed (ETIMEOUT)");
      },
    };
    const { systems } = await read("marlowe-bar.com", BAR.config, { ...BAR, dns });
    const d = byId(systems, "dns") as DnsSystem;
    expect(d.source).toBe("registry");
    expect(d.notes.join(" ")).toMatch(/lookup/);
  });

  it("a name server it does not know is listed with no provider, not guessed", async () => {
    const { systems } = await read("marlowe-bar.com", BAR.config, {
      ...BAR,
      over: {
        "GET https://rdap.registry.example/com/v1/domain/marlowe-bar.com": {
          status: 200,
          body: {
            objectClassName: "domain",
            ldhName: "marlowe-bar.com",
            nameservers: [{ ldhName: "dns1.small-host.example" }],
          },
        },
      },
    });
    const dns = byId(systems, "dns") as DnsSystem;
    expect(dns.provider).toBeUndefined();
    expect(dns.nameservers).toEqual(["dns1.small-host.example"]);
  });

  it("Vercel: the team, and every member masked with their party and role", async () => {
    const { systems } = await read("marlowe-bar.com", BAR.config, BAR);
    const v = byId(systems, "vercel") as PeopleSystem;
    expect(v.subject).toBe("marlowe-bar-site");
    expect(v.account).toEqual({ kind: "team", name: "Harbour Studio" });
    expect(v.members.map((m) => [m.who, m.party, m.role, m.pending])).toEqual([
      ["d***@harbour-studio.example", "freelancer", "owner", false],
      ["m***@harbour-studio.example", "freelancer", "member", false],
      ["r***@marlowe-bar.example", "client", "member", true],
    ]);
  });

  it("Sanity: a token is not a person, and the freelancer under two addresses is one person", async () => {
    const { systems } = await read("marlowe-bar.com", BAR.config, BAR);
    const v = byId(systems, "vercel") as PeopleSystem;
    const s = byId(systems, "sanity") as PeopleSystem;
    expect(s.members.map((m) => [m.who, m.party, m.role, m.token])).toEqual([
      ["d***@mail.example", "freelancer", "admin", false],
      ["r***@marlowe-bar.example", "client", "member", false],
      ["an API token", "other", "viewer", true],
    ]);
    expect(s.members[0]?.person).toBe(v.members[0]?.person);
  });

  it("Google: read from the listings location when its token is set", async () => {
    const { systems, seen } = await read("marlowe-bar.com", BAR.config, BAR);
    const g = byId(systems, "google-business") as PeopleSystem;
    expect(g.members.map((m) => [m.party, m.role])).toEqual([
      ["client", "owner"],
      ["freelancer", "member"],
    ]);
    const googleCalls = seen.filter((s) => s.url.includes("googleapis.com"));
    expect(googleCalls).toHaveLength(1);
  });

  it("Google without a location is a line to check by hand, never a guess", async () => {
    const { systems } = await read("marlowe-bar.com", BAR.config);
    const g = byId(systems, "google-business");
    expect(g).toMatchObject({ kind: "manual" });
  });

  it("a member whose address the provider hides is 'unknown', with an id-free label", async () => {
    const { systems } = await read("marlowe-bar.com", BAR.config, {
      ...BAR,
      over: {
        "GET https://api.sanity.io/v2021-06-07/projects/abc123xy/users/su_dev,su_rosa": {
          status: 404,
        },
      },
    });
    const s = byId(systems, "sanity") as PeopleSystem;
    expect(s.members[0]).toMatchObject({ party: "unknown" });
    expect(s.members[0]?.who).toBe("an account whose address Sanity does not show");
    expect(s.notes.join(" ")).toMatch(/address/);
  });

  it("a token without permission is could-not-check for that system only", async () => {
    const { systems } = await read("marlowe-bar.com", BAR.config, {
      ...BAR,
      over: {
        "GET https://api.vercel.com/v3/teams/team_harbour01/members?limit=100": { status: 403 },
      },
    });
    expect(byId(systems, "vercel")).toMatchObject({ kind: "could-not-check" });
    expect(byId(systems, "sanity")).toMatchObject({ kind: "people" });
    expect(byId(systems, "google-business")).toMatchObject({ kind: "people" });
    expect(byId(systems, "domain")).toMatchObject({ kind: "domain" });
  });

  it("a site served by Vercel with no project named says what to add", async () => {
    const { systems } = await read("marlowe-bar.com", { clientEmails: [CLIENT] }, { env: {} });
    const v = byId(systems, "vercel");
    expect(v).toMatchObject({ kind: "could-not-check" });
    expect(v?.kind === "could-not-check" && v.reason).toContain("gaugeline.handoff.json");
  });

  it("a site not on Vercel or Sanity has no such system", async () => {
    const { systems } = await read(
      "marlowe-bar.com",
      { clientEmails: [CLIENT] },
      {
        env: {},
        over: {
          "GET https://marlowe-bar.com/": {
            status: 200,
            headers: { "content-type": "text/html" },
            body: "<!doctype html><title>Marlowe Bar</title><h1>Marlowe Bar</h1>",
          },
        },
      },
    );
    expect(systems.map((s) => s.id)).toEqual(["domain", "dns", "google-business"]);
  });

  it("the config can ask for a manual line the page does not show", async () => {
    const { systems } = await read(
      "marlowe-bar.com",
      { ...BAR.config, also: ["square", "mailchimp"] },
      BAR,
    );
    const manual = systems.filter((s) => s.kind === "manual");
    expect(manual.map((s) => [s.id, s.kind === "manual" && s.detected])).toEqual([
      ["stripe", true],
      ["square", false],
      ["mailchimp", false],
    ]);
  });

  it("every manual line says why it is not read, and none is read", async () => {
    const { systems, seen } = await read(
      "marlowe-bar.com",
      { ...BAR.config, also: ["square"] },
      BAR,
    );
    for (const s of systems)
      if (s.kind === "manual") {
        expect(s.why.length).toBeGreaterThan(20);
        expect(
          seen.some((r) => r.url.includes("stripe.com/v1") || r.url.includes("squareup")),
        ).toBe(false);
      }
  });

  it("a personal Vercel account is read as one owner, and DNS is Vercel's", async () => {
    const { systems } = await read("juniper-coaching.com", COACH_HANDOFF, {
      env: { ...ENV, SANITY_PROJECT_ID: undefined },
    });
    const v = byId(systems, "vercel") as PeopleSystem;
    expect(v.account.kind).toBe("personal");
    expect(v.members.map((m) => [m.who, m.party, m.role])).toEqual([
      ["a***@juniper-coaching.example", "client", "owner"],
    ]);
    expect((byId(systems, "dns") as DnsSystem).provider).toBe("Vercel");
    expect(systems.map((s) => s.id)).toEqual(["domain", "dns", "vercel", "google-business"]);
  });

  it("when the registry cannot be read the domain and DNS say why, and the rest is still read", async () => {
    const { systems } = await read("marlowe-bar.com", BAR.config, {
      ...BAR,
      over: {
        "GET https://rdap.registry.example/com/v1/domain/marlowe-bar.com": {
          status: 429,
          headers: { "retry-after": "60" },
        },
      },
    });
    const domain = byId(systems, "domain");
    expect(domain).toMatchObject({ kind: "could-not-check" });
    expect(domain?.kind === "could-not-check" && domain.reason).toMatch(/429/);
    expect(byId(systems, "dns")).toMatchObject({ kind: "could-not-check" });
    expect(byId(systems, "vercel")).toMatchObject({ kind: "people" });
  });

  it("an adapter's members() read joins the report, and one without it is a line to check by hand", async () => {
    const { transport } = world();
    const fetcher = createFetcher({ transport });
    const handoff = createHandoff(
      {
        config: handoffConfigSchema.parse({ clientEmails: [CLIENT] }),
        env: {},
        sources: [
          {
            id: "webflow",
            name: "Webflow",
            members: async () => ({
              ok: true,
              subject: "marlowe-bar",
              account: { kind: "team", name: "Harbour Studio" },
              members: [{ email: CLIENT, role: "owner", rawRole: "Owner" }],
              notes: [],
            }),
          },
          {
            id: "framer",
            name: "Framer",
            why: "Framer's API offers no read of a site's collaborators.",
          },
        ],
      },
      fetcher,
      createRenewals({ config: {}, env: {} }, fetcher),
    );
    const snapshot = buildSnapshot(await fetcher.getSite("marlowe-bar.com"));
    const systems = await handoff.systems(snapshot);
    const webflow = byId(systems, "webflow") as PeopleSystem;
    expect(webflow.members.map((m) => [m.who, m.party, m.role])).toEqual([
      ["r***@marlowe-bar.example", "client", "owner"],
    ]);
    expect(byId(systems, "framer")).toMatchObject({
      kind: "manual",
      why: "Framer's API offers no read of a site's collaborators.",
    });
  });

  it("asks only with GET, sends each token to its own provider only, and reads once", async () => {
    const { handoff, snapshot, seen } = await read("marlowe-bar.com", BAR.config, BAR);
    const before = seen.length;
    await handoff.systems(snapshot);
    expect(seen.length).toBe(before);
    for (const s of seen) {
      expect(s.method === "GET" || s.method === "HEAD").toBe(true);
      const host = new URL(s.url).hostname;
      for (const [token, hosts] of [
        [VERCEL_TOKEN, ["api.vercel.com"]],
        [SANITY_TOKEN, ["api.sanity.io"]],
        [GOOGLE_TOKEN, ["mybusinessaccountmanagement.googleapis.com"]],
      ] as const) {
        expect(s.url).not.toContain(token);
        if (s.headers.authorization === `Bearer ${token}`) expect(hosts).toContain(host);
      }
    }
  });

  it("nothing in the systems holds a full email address, a token or a user id", async () => {
    const { systems } = await read("marlowe-bar.com", BAR.config, BAR);
    const text = JSON.stringify(systems);
    for (const secret of [
      CLIENT,
      FREELANCER,
      FREELANCER_HOME,
      COACH,
      VERCEL_TOKEN,
      SANITY_TOKEN,
      GOOGLE_TOKEN,
      "u_rosa",
      "su_rosa",
    ])
      expect(text, secret).not.toContain(secret);
  });
});
