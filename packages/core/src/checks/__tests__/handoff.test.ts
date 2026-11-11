// check-community: allow-email (invented addresses at reserved example domains, only ever compared and masked)
import { describe, expect, it } from "vitest";
import type { CheckContext } from "../../model.js";
import { createPeople } from "../../handoff/people.js";
import type { Handoff } from "../../handoff/reader.js";
import type { Account, Member, PeopleSystem, Role, System } from "../../handoff/types.js";
import { HANDOFF_CHECKS, clientNotAdmin, personalAccount, singleAdmin } from "../handoff.js";
import { page } from "./helpers.js";

const people = createPeople({
  clientEmails: ["rosa@marlowe-bar.example"],
  freelancerEmails: ["dev@harbour-studio.example", "dev.harbour@mail.example"],
  sameAs: [["dev@harbour-studio.example", "dev.harbour@mail.example"]],
});
const PAGE = page({ finalUrl: "https://marlowe-bar.com/" });

const KEYS = {
  rosa: people.personOf("rosa@marlowe-bar.example"),
  dev: people.personOf("dev@harbour-studio.example"),
};
const rosa = (role: Role, over: Partial<Member> = {}): Member => ({
  who: "r***@marlowe-bar.example",
  party: "client",
  person: KEYS.rosa,
  role,
  rawRole: role,
  pending: false,
  token: false,
  ...over,
});
const dev = (role: Role, over: Partial<Member> = {}): Member => ({
  who: "d***@harbour-studio.example",
  party: "freelancer",
  person: KEYS.dev,
  role,
  rawRole: role,
  pending: false,
  token: false,
  ...over,
});

function system(members: Member[], over: Partial<PeopleSystem> = {}): PeopleSystem {
  return {
    kind: "people",
    id: "vercel",
    name: "Vercel",
    subject: "marlowe-bar-site",
    account: { kind: "team", name: "Harbour Studio" },
    members,
    notes: [],
    ...over,
  };
}

function context(systems: System[] | undefined, noClient = false) {
  const notes: { url: string; reason: string }[] = [];
  const handoff: Handoff | undefined = systems
    ? {
        config: {},
        people: noClient ? createPeople({}) : people,
        systems: async () => systems,
      }
    : undefined;
  const ctx: CheckContext = {
    warn: () => undefined,
    couldNotCheck: (url, reason) => void notes.push({ url, reason }),
    ...(handoff ? { handoff } : {}),
  };
  return { ctx, notes };
}

describe("the handoff checks do nothing outside gaugeline handoff", () => {
  it.each(HANDOFF_CHECKS.map((c) => [c.id, c] as const))(
    "%s finds nothing and notes nothing",
    async (_id, check) => {
      const { ctx, notes } = context(undefined);
      expect(await check.run(PAGE, ctx)).toEqual([]);
      expect(notes).toEqual([]);
    },
  );
});

describe("client-not-admin (high)", () => {
  it("fires when none of the client's addresses owns or administers the system", async () => {
    const { ctx } = context([system([dev("owner"), rosa("member")])]);
    const found = await clientNotAdmin.run(PAGE, ctx);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      checkId: "client-not-admin",
      severity: "high",
      url: "handoff:vercel",
    });
    expect(found[0]?.evidence).toContain("Vercel");
    expect(found[0]?.evidence).toContain("Harbour Studio");
    expect(found[0]?.evidence).toContain("d***@harbour-studio.example");
    expect(found[0]?.evidence).toContain("r***@marlowe-bar.example is a member");
  });

  it("is quiet when the client is an owner, or an admin", async () => {
    for (const role of ["owner", "admin"] as const) {
      const { ctx } = context([system([dev("owner"), rosa(role)])]);
      expect(await clientNotAdmin.run(PAGE, ctx), role).toEqual([]);
    }
  });

  it("does not count an invitation as being an admin, and says it is waiting", async () => {
    const { ctx } = context([system([dev("owner"), rosa("owner", { pending: true })])]);
    const found = await clientNotAdmin.run(PAGE, ctx);
    expect(found).toHaveLength(1);
    expect(found[0]?.evidence).toMatch(/invited, and has not accepted/);
  });

  it("fires when the client is not in the system at all", async () => {
    const { ctx } = context([system([dev("owner")])]);
    const found = await clientNotAdmin.run(PAGE, ctx);
    expect(found[0]?.evidence).toMatch(/none of the client's addresses is listed/);
  });

  it("reports each system that fails, in the order given", async () => {
    const { ctx } = context([
      system([dev("owner")]),
      system([dev("admin"), rosa("member")], {
        id: "sanity",
        name: "Sanity",
        subject: "Marlowe Bar",
        account: { kind: "unknown" },
      }),
      system([rosa("owner"), dev("member")], {
        id: "google-business",
        name: "Google Business Profile",
      }),
    ]);
    expect((await clientNotAdmin.run(PAGE, ctx)).map((f) => f.url)).toEqual([
      "handoff:vercel",
      "handoff:sanity",
    ]);
  });

  it("an admin whose address is not shown leaves it unknown: could-not-check, no finding", async () => {
    const hidden = dev("admin", {
      who: "an account whose address Sanity does not show",
      party: "unknown",
      person: "hidden1",
    });
    const { ctx, notes } = context([
      system([hidden, rosa("member")], { id: "sanity", name: "Sanity" }),
    ]);
    expect(await clientNotAdmin.run(PAGE, ctx)).toEqual([]);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.url).toBe("handoff:sanity");
    expect(notes[0]?.reason).toMatch(/address/);
  });

  it("a client who is an admin is known even when another admin is hidden", async () => {
    const hidden = dev("admin", { party: "unknown", person: "hidden1" });
    const { ctx, notes } = context([system([hidden, rosa("owner")])]);
    expect(await clientNotAdmin.run(PAGE, ctx)).toEqual([]);
    expect(notes).toEqual([]);
  });

  it("without a client address it cannot say, and says what to add", async () => {
    const { ctx, notes } = context([system([dev("owner")])], true);
    expect(await clientNotAdmin.run(PAGE, ctx)).toEqual([]);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.reason).toContain("clientEmails");
    expect(notes[0]?.reason).toContain("gaugeline.handoff.json");
  });

  it("a system that could not be read is could-not-check for that system, with the reason", async () => {
    const { ctx, notes } = context([
      {
        kind: "could-not-check",
        id: "vercel",
        name: "Vercel",
        reason: "Vercel refused the token (HTTP 403)",
      },
      system([dev("owner")], { id: "sanity", name: "Sanity" }),
    ]);
    const found = await clientNotAdmin.run(PAGE, ctx);
    expect(found.map((f) => f.url)).toEqual(["handoff:sanity"]);
    expect(notes).toEqual([
      { url: "handoff:vercel", reason: "Vercel refused the token (HTTP 403)" },
    ]);
  });

  it("manual lines, the domain and DNS are never findings: there is no user list to judge", async () => {
    const { ctx, notes } = context([
      {
        kind: "manual",
        id: "stripe",
        name: "Stripe",
        why: "Stripe's API does not list the people on an account",
        detected: true,
      },
      {
        kind: "domain",
        id: "domain",
        name: "Domain registration",
        subject: "marlowe-bar.com",
        registrant: "redacted",
        notes: [],
      },
      {
        kind: "dns",
        id: "dns",
        name: "DNS",
        subject: "marlowe-bar.com",
        nameservers: [],
        source: "registry",
        notes: [],
      },
    ]);
    expect(await clientNotAdmin.run(PAGE, ctx)).toEqual([]);
    expect(notes).toEqual([]);
  });

  it("the evidence never holds a full address", async () => {
    const { ctx } = context([system([dev("owner"), rosa("member")])]);
    const text = JSON.stringify(await clientNotAdmin.run(PAGE, ctx));
    expect(text).not.toMatch(/rosa@|dev@|dev\.harbour@/);
  });
});

describe("single-admin (medium)", () => {
  it("fires when the only admin is the freelancer", async () => {
    const { ctx } = context([system([dev("owner"), rosa("member")])]);
    const found = await singleAdmin.run(PAGE, ctx);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      checkId: "single-admin",
      severity: "medium",
      url: "handoff:vercel",
    });
    expect(found[0]?.evidence).toContain("d***@harbour-studio.example");
  });

  it("is quiet with a second admin, or when the one admin is the client", async () => {
    expect(
      await singleAdmin.run(PAGE, context([system([dev("owner"), rosa("admin")])]).ctx),
    ).toEqual([]);
    expect(
      await singleAdmin.run(PAGE, context([system([rosa("owner"), dev("member")])]).ctx),
    ).toEqual([]);
  });

  it("counts the same person under two addresses once", async () => {
    const second = dev("admin", {
      who: "d***@mail.example",
      person: people.personOf("dev.harbour@mail.example"),
    });
    const { ctx } = context([system([dev("owner"), second, rosa("member")])]);
    expect(await singleAdmin.run(PAGE, ctx)).toHaveLength(1);
  });

  it("counts two different freelancers as two admins", async () => {
    const mia = dev("admin", { who: "m***@harbour-studio.example", person: "someone-else" });
    const { ctx } = context([system([dev("owner"), mia, rosa("member")])]);
    expect(await singleAdmin.run(PAGE, ctx)).toEqual([]);
  });

  it("ignores a token and an invitation that has not been accepted", async () => {
    const bot = dev("admin", { who: "an API token", party: "other", person: "bot", token: true });
    const invited = rosa("owner", { pending: true });
    const { ctx } = context([system([dev("owner"), bot, invited])]);
    expect(await singleAdmin.run(PAGE, ctx)).toHaveLength(1);
  });

  it("needs no client address: it is about the freelancer alone", async () => {
    const { ctx, notes } = context([system([dev("owner")])], true);
    expect(await singleAdmin.run(PAGE, ctx)).toHaveLength(1);
    expect(notes.filter((n) => /clientEmails/.test(n.reason))).toEqual([]);
  });

  it("says nothing of a system it could not read beyond its reason", async () => {
    const { ctx, notes } = context([
      { kind: "could-not-check", id: "sanity", name: "Sanity", reason: "no token" },
    ]);
    expect(await singleAdmin.run(PAGE, ctx)).toEqual([]);
    expect(notes).toEqual([{ url: "handoff:sanity", reason: "no token" }]);
  });
});

describe("personal-account (medium)", () => {
  const personal: Account = { kind: "personal", name: "a personal account" };
  it("fires when the project lives in a personal account", async () => {
    const { ctx } = context([system([dev("owner")], { account: personal })]);
    const found = await personalAccount.run(PAGE, ctx);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      checkId: "personal-account",
      severity: "medium",
      url: "handoff:vercel",
    });
    expect(found[0]?.evidence).toContain("marlowe-bar-site");
    expect(found[0]?.evidence).toContain("d***@harbour-studio.example");
  });

  it("names the client when it is the client's own account", async () => {
    const { ctx } = context([system([rosa("owner")], { account: personal })]);
    const found = await personalAccount.run(PAGE, ctx);
    expect(found[0]?.evidence).toContain("r***@marlowe-bar.example");
  });

  it("is quiet for a team, for an account of unknown kind, and for a system with no accounts", async () => {
    expect(await personalAccount.run(PAGE, context([system([dev("owner")])]).ctx)).toEqual([]);
    expect(
      await personalAccount.run(
        PAGE,
        context([system([dev("owner")], { account: { kind: "unknown" } })]).ctx,
      ),
    ).toEqual([]);
    expect(
      await personalAccount.run(
        PAGE,
        context([
          { kind: "manual", id: "stripe", name: "Stripe", why: "x".repeat(30), detected: true },
        ]).ctx,
      ),
    ).toEqual([]);
  });
});
