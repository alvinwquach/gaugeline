import { describe, expect, it } from "vitest";
import { HANDOFF_CHECKS } from "../../checks/handoff.js";
import { createFetcher } from "../../fetcher.js";
import { createRenewals } from "../../renewals/reader.js";
import { checkSite } from "../../site.js";
import { handoffConfigSchema } from "../config.js";
import { createPeople } from "../people.js";
import { createHandoff } from "../reader.js";
import { createHandoffRegistry } from "../registry.js";
import {
  buildHandoff,
  formatHandoffLines,
  handoffFiles,
  renderHandoffHtml,
  renderHandoffMarkdown,
  type HandoffSummary,
} from "../report.js";
import type { PeopleSystem, System } from "../types.js";
import {
  BAR_HANDOFF,
  CLIENT,
  COACH,
  ENV,
  FREELANCER,
  FREELANCER_HOME,
  GOOGLE_TOKEN,
  NOW,
  SANITY_TOKEN,
  TEAMMATE,
  VERCEL_TOKEN,
  world,
} from "./world.js";

async function summaryFor(
  address: string,
  config: unknown,
  opts: {
    over?: Parameters<typeof world>[0];
    env?: Record<string, string | undefined>;
    mutate?: (s: System[]) => System[];
  } = {},
): Promise<HandoffSummary> {
  const { transport } = world(opts.over);
  const fetcher = createFetcher({ transport });
  const handoff = createHandoff(
    {
      config: handoffConfigSchema.parse(config),
      env: opts.env ?? ENV,
      ...(opts.google === false ? {} : { googleLocation: "locations/1234567890" }),
    },
    fetcher,
    createRenewals({ config: {}, env: {} }, fetcher),
  );
  const checked = await checkSite({
    address,
    fetcher,
    registry: createHandoffRegistry(),
    only: HANDOFF_CHECKS.map((c) => c.id),
    handoff,
    tolerateUnreachable: true,
    now: () => NOW,
  });
  const all = await handoff.systems(checked.snapshot);
  const registry = createHandoffRegistry();
  return buildHandoff({
    site: new URL(checked.snapshot.finalUrl).host,
    now: NOW,
    version: "0.3.0",
    systems: opts.mutate ? opts.mutate(all) : all,
    findings: checked.result.findings,
    couldNotCheck: checked.result.couldNotCheck,
    people: handoff.people,
    registry,
  });
}

const SECRETS = [
  CLIENT,
  FREELANCER,
  FREELANCER_HOME,
  TEAMMATE,
  COACH,
  VERCEL_TOKEN,
  SANITY_TOKEN,
  GOOGLE_TOKEN,
];

describe("buildHandoff: the JSON summary", () => {
  it("lists every system with how the client stands in it", async () => {
    const s = await summaryFor("marlowe-bar.com", BAR_HANDOFF);
    expect(s.schemaVersion).toBe(1);
    expect(s.site).toBe("marlowe-bar.com");
    expect(s.generatedAt).toBe("2026-11-11T09:00:00.000Z");
    expect(s.systems.map((x) => [x.id, x.status, x.clientAccess ?? null])).toEqual([
      ["domain", "read", null],
      ["dns", "read", null],
      ["vercel", "read", "invited"],
      ["sanity", "read", "member"],
      ["google-business", "read", "admin"],
      ["stripe", "manual", null],
    ]);
    expect(s.counts).toMatchObject({ systems: 6, read: 5, manual: 1, couldNotCheck: 0 });
    expect(s.counts.findings).toEqual({ high: 2, medium: 2, low: 0 });
  });

  it("never holds a full address, a token or a provider's user id, anywhere", async () => {
    const s = await summaryFor("marlowe-bar.com", BAR_HANDOFF);
    const all = [
      JSON.stringify(s),
      renderHandoffMarkdown(s),
      renderHandoffHtml(s),
      formatHandoffLines(s).join("\n"),
    ].join("\n");
    for (const secret of [...SECRETS, "u_rosa", "su_rosa", "u_dev"])
      expect(all, secret).not.toContain(secret);
    expect(all).toContain("r***@marlowe-bar.example");
  });

  it("is the same every time it is built from the same reads", async () => {
    const a = await summaryFor("marlowe-bar.com", BAR_HANDOFF);
    const b = await summaryFor("marlowe-bar.com", BAR_HANDOFF);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(renderHandoffMarkdown(b)).toBe(renderHandoffMarkdown(a));
    expect(renderHandoffHtml(b)).toBe(renderHandoffHtml(a));
  });

  it("each finding carries why it matters and how to fix it", async () => {
    const s = await summaryFor("marlowe-bar.com", BAR_HANDOFF);
    for (const f of s.findings) {
      expect(f.why.length).toBeGreaterThan(20);
      expect(f.fix.length).toBeGreaterThan(20);
    }
  });

  it("the checklist splits what the owner owns, what to add themselves to and what to ask for", async () => {
    const s = await summaryFor("marlowe-bar.com", BAR_HANDOFF);
    const group = (g: string) => s.checklist.filter((c) => c.group === g).map((c) => c.system);
    expect(group("own")).toEqual(["google-business"]);
    expect(group("add")).toEqual(["vercel", "sanity"]);
    expect(group("ask")).toEqual(["domain", "dns", "stripe"]);
    for (const c of s.checklist) if (c.link !== undefined) expect(c.link).toMatch(/^https:\/\//);
    expect(s.checklist.filter((c) => c.group === "add").every((c) => c.link !== undefined)).toBe(
      true,
    );
  });

  it("a system that could not be read is something to check yourself, with the reason", async () => {
    const s = await summaryFor("marlowe-bar.com", BAR_HANDOFF, {
      over: {
        "GET https://api.vercel.com/v3/teams/team_harbour01/members?limit=100": { status: 403 },
      },
    });
    const vercel = s.systems.find((x) => x.id === "vercel");
    expect(vercel?.status).toBe("could-not-check");
    expect(vercel?.reason).toMatch(/403/);
    expect(s.checklist.find((c) => c.system === "vercel")?.group).toBe("add");
    expect(s.counts.couldNotCheck).toBe(1);
  });

  it("the client's own personal account is something she owns", async () => {
    const s = await summaryFor(
      "juniper-coaching.com",
      {
        clientEmails: [COACH],
        freelancerEmails: [FREELANCER],
        vercel: { project: "juniper-site" },
      },
      { env: { ...ENV, SANITY_PROJECT_ID: undefined }, google: false },
    );
    expect(s.checklist.filter((c) => c.group === "own").map((c) => c.system)).toEqual(["vercel"]);
    expect(s.findings.map((f) => f.checkId)).toEqual(["personal-account"]);
  });

  it("a hostile provider name is escaped, and invisible characters in it are written out", async () => {
    const s = await summaryFor("marlowe-bar.com", BAR_HANDOFF, {
      mutate: (systems) =>
        systems.map((x) =>
          x.id === "vercel" && x.kind === "people"
            ? ({
                ...x,
                subject: "<script>alert(1)</script> \u202Eevil",
                account: { kind: "team", name: "Studio | `x` \u200B" },
              } as PeopleSystem)
            : x,
        ),
    });
    const html = renderHandoffHtml(s);
    const md = renderHandoffMarkdown(s);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html + md).not.toMatch(/[\u202E\u200B]/);
    expect(md).not.toContain("<script>");
    expect(md).toContain("\\u{202E}");
  });
});

describe("renderHandoffMarkdown", () => {
  it("is a document with the checklist at the end", async () => {
    const md = renderHandoffMarkdown(await summaryFor("marlowe-bar.com", BAR_HANDOFF));
    const lines = md.split("\n");
    expect(lines[0]).toBe("# Who owns what: marlowe-bar.com");
    const heads = lines.filter((l) => l.startsWith("## "));
    expect(heads).toEqual([
      "## At a glance",
      "## What to fix",
      "## System by system",
      "## A checklist for the owner",
    ]);
    expect(md).toContain("- [ ] ");
    expect(lines.at(-2)).toMatch(/password/);
  });

  it("writes the date out and says what it did not do", async () => {
    const md = renderHandoffMarkdown(await summaryFor("marlowe-bar.com", BAR_HANDOFF));
    expect(md).toContain("11 Nov 2026");
    expect(md).toMatch(/read-only/i);
  });

  it("says nothing needs fixing when nothing does", () => {
    const md = renderHandoffMarkdown(
      buildHandoff({
        site: "marlowe-bar.com",
        now: NOW,
        version: "0.3.0",
        systems: [],
        findings: [],
        couldNotCheck: [],
        people: createPeople({}),
        registry: createHandoffRegistry(),
      }),
    );
    expect(md).toContain("Nothing to fix.");
  });
});

describe("renderHandoffHtml", () => {
  it("is one file: no script, no stylesheet link, no image, links only to provider pages", async () => {
    const html = renderHandoffHtml(await summaryFor("marlowe-bar.com", BAR_HANDOFF));
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>Who owns what: marlowe-bar.com</title>");
    expect(html).not.toMatch(/<script|<link |<img |<iframe|onerror=|javascript:/i);
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1] ?? "");
    expect(hrefs.length).toBeGreaterThan(0);
    for (const h of hrefs) expect(h).toMatch(/^https:\/\//);
  });
});

describe("handoffFiles", () => {
  it("is three files, the JSON being the summary", async () => {
    const s = await summaryFor("marlowe-bar.com", BAR_HANDOFF);
    const files = handoffFiles(s);
    expect(files.map((f) => f.name)).toEqual(["handoff.html", "handoff.md", "handoff.json"]);
    expect(JSON.parse(files[2]?.text ?? "")).toEqual(JSON.parse(JSON.stringify(s)));
    expect(files.every((f) => f.text.endsWith("\n"))).toBe(true);
  });
});

describe("formatHandoffLines: the terminal view", () => {
  it("one line a system, then the count of what to fix", async () => {
    const lines = formatHandoffLines(await summaryFor("marlowe-bar.com", BAR_HANDOFF));
    expect(lines[0]).toBe("Who owns what for marlowe-bar.com");
    expect(
      lines.some((l) =>
        /^Vercel\s+Project marlowe-bar-site, in the team "Harbour Studio"/.test(l.trim()),
      ),
    ).toBe(true);
    expect(lines.some((l) => /^Stripe\s+/.test(l.trim()))).toBe(true);
  });
});
