import { describe, expect, it } from "vitest";
import { buildReceipt, receiptMarkdown, type ReceiptRun } from "../../receipt/index.js";
import { compareRuns, formatBeforeAfter } from "../compare.js";
import { buildChanges, formatChanges, type ChangeSources } from "../report.js";
import { siteDiff, siteReference } from "../site.js";
import {
  isRunRecord,
  type PageRecord,
  type RecordedSiteFinding,
  type RunRecord,
} from "../types.js";

/**
 * Findings that belong to the site and not to a page (a domain, a token, a hosting project, the
 * certificate of another host): the run keeps them beside the page findings, with the address the
 * check gave them, and says whether it read the renewals at all. Invented names throughout (rule 12).
 */
const PAGE: PageRecord = { mainHash: "a".repeat(16), links: [], types: [], scripts: [] };
const DOMAIN: RecordedSiteFinding = {
  checkId: "domain-expires-soon",
  address: "domain:marlowe-bar.example",
  title: "The domain's registration runs out soon",
};
const OTHER: RecordedSiteFinding = { ...DOMAIN, address: "domain:marlowe-grill.example" };
const WWW: RecordedSiteFinding = {
  checkId: "cert-name-mismatch",
  address: "https://www.marlowe-bar.example/",
  title: "The bare domain or www is not covered by the certificate",
};

const run = (day: string, extra: Partial<RunRecord> = {}): RunRecord => ({
  schema: 1,
  id: `r-202610${day}T060000Z`,
  takenAt: `2026-10-${day}T06:00:00.000Z`,
  pages: { "/": PAGE },
  findings: [],
  ...extra,
});
const CHECKS = ["cert-name-mismatch", "domain-expires-soon"];
const read = (day: string, ...siteFindings: RecordedSiteFinding[]) =>
  run(day, { renewalChecks: CHECKS, siteFindings });

describe("the stored shape: old files still load, the new fields are checked", () => {
  it("a run with none of the new fields is valid, exactly as before", () => {
    expect(isRunRecord(run("01"))).toBe(true);
  });
  it("a run with site findings and renewalChecks is valid", () => {
    expect(isRunRecord(read("01", DOMAIN, WWW))).toBe(true);
  });
  it.each([
    ["site findings that are not a list", { siteFindings: "x" }],
    ["a site finding with no address", { siteFindings: [{ checkId: "a", title: "t" }] }],
    [
      "a site finding with an address over the bound",
      { siteFindings: [{ ...DOMAIN, address: "x".repeat(501) }] },
    ],
    ["renewalChecks that is not a list", { renewalChecks: "yes" }],
    ["renewalChecks with a number in it", { renewalChecks: [1] }],
  ])("rejects %s", (_name, extra) => {
    expect(isRunRecord({ ...run("01"), ...extra })).toBe(false);
  });
});

describe("siteDiff: what a renewal did between two runs that both read the renewals", () => {
  it("lists new, fixed and unchanged, each address on its own", () => {
    const d = siteDiff(read("01", DOMAIN, OTHER), read("02", OTHER, WWW))!;
    expect(d.added).toEqual([WWW]);
    expect(d.fixed).toEqual([DOMAIN]);
    expect(d.unchanged).toEqual([OTHER]);
  });
  it("two domains of one check are two findings", () => {
    const d = siteDiff(read("01", DOMAIN), read("02", DOMAIN, OTHER))!;
    expect(d.added).toEqual([OTHER]);
    expect(d.unchanged).toEqual([DOMAIN]);
  });
  it("the same finding in consecutive runs is not new twice", () => {
    expect(siteDiff(read("01", DOMAIN), read("02", DOMAIN))!.added).toEqual([]);
    expect(siteDiff(read("02", DOMAIN), read("03", DOMAIN))!.added).toEqual([]);
  });
  it("is undefined when the runs share no check they read: absent is not fixed", () => {
    expect(siteDiff(read("01", DOMAIN), run("02"))).toBeUndefined();
    expect(siteDiff(run("01"), read("02", DOMAIN))).toBeUndefined();
  });
  it("a finding is gone only when its own check was read: one check unread leaves its findings out", () => {
    const after = run("02", { renewalChecks: ["domain-expires-soon"], siteFindings: [] });
    const d = siteDiff(read("01", DOMAIN, WWW), after)!;
    expect(d.fixed).toEqual([DOMAIN]);
    expect(d.notCompared).toEqual({ before: 1, after: 0 });
  });
  it("a repeated finding in one run counts once", () => {
    expect(siteDiff(read("01"), read("02", DOMAIN, DOMAIN))!.added).toEqual([DOMAIN]);
  });
});

describe("siteReference: the run a new/fixed question is asked against", () => {
  const runs = [read("01", DOMAIN), run("02"), read("03", DOMAIN), read("04")];
  it("by default the latest earlier run that read the renewals, skipping one that did not", () => {
    expect(siteReference(runs, { kind: "previous" })?.id).toBe("r-20261003T060000Z");
    expect(siteReference(runs.slice(0, 3), { kind: "previous" })?.id).toBe("r-20261001T060000Z");
  });
  it("by date: the latest reading run before the date", () => {
    expect(siteReference(runs, { kind: "date", at: "2026-10-03T00:00:00.000Z" })?.id).toBe(
      "r-20261001T060000Z",
    );
  });
  it("by run id: that run, or the latest reading run before it", () => {
    expect(siteReference(runs, { kind: "run", id: "r-20261002T060000Z" })?.id).toBe(
      "r-20261001T060000Z",
    );
  });
  it("is undefined when no earlier run read any renewal check", () => {
    expect(siteReference([run("01"), read("02", DOMAIN)], { kind: "previous" })).toBeUndefined();
  });
});

const none: ChangeSources = {
  revisions: () => Promise.resolve({ state: "not-configured" }),
  deploys: () => Promise.resolve({ state: "not-configured" }),
};

describe("changes: renewals are a block of their own, never given a page or a cause", () => {
  it("a renewal that appeared is listed as new, with no page diff and no attribution", async () => {
    const report = await buildChanges({
      site: "marlowe-bar.example",
      runs: [read("01"), read("02", DOMAIN)],
      sources: none,
    });
    expect(report.items).toEqual([]);
    expect(report.renewals).toEqual({ added: [DOMAIN], fixed: [], noHistory: 0 });
    const text = formatChanges(report);
    expect(text).toContain("Renewals since the run before:");
    expect(text).toContain(
      "  new    domain-expires-soon  domain:marlowe-bar.example  The domain's registration runs out soon",
    );
    expect(text).not.toContain("No new findings");
    expect(text).not.toMatch(/content edit|deploy/);
  });
  it("a renewal that went away is listed as fixed", async () => {
    const report = await buildChanges({
      site: "marlowe-bar.example",
      runs: [read("01", DOMAIN), read("02")],
      sources: none,
    });
    expect(formatChanges(report)).toContain(
      "  fixed  domain-expires-soon  domain:marlowe-bar.example",
    );
  });
  it("the same renewal in the next run is not listed again", async () => {
    const report = await buildChanges({
      site: "marlowe-bar.example",
      runs: [read("01", DOMAIN), read("02", DOMAIN)],
      sources: none,
    });
    expect(report.renewals).toEqual({ added: [], fixed: [], noHistory: 0 });
    expect(formatChanges(report)).toContain("No new findings since the run before.");
  });
  it("the first run that read the renewals has nothing to compare with: counted, not called new", async () => {
    const report = await buildChanges({
      site: "marlowe-bar.example",
      runs: [run("01"), read("02", DOMAIN)],
      sources: none,
    });
    expect(report.renewals).toEqual({ added: [], fixed: [], noHistory: 1 });
    expect(formatChanges(report)).toContain(
      "1 renewal finding with no earlier run that read the renewals to compare with.",
    );
  });
  it("a latest run that did not read the renewals says nothing about them", async () => {
    const report = await buildChanges({
      site: "marlowe-bar.example",
      runs: [read("01", DOMAIN), run("02")],
      sources: none,
    });
    expect(report.renewals).toEqual({ added: [], fixed: [], noHistory: 0 });
  });
  it("an address with a control character is printed escaped", async () => {
    const report = await buildChanges({
      site: "marlowe-bar.example",
      runs: [
        read("01"),
        read("02", { ...DOMAIN, address: `domain:a${String.fromCharCode(27)}[31mb` }),
      ],
      sources: none,
    });
    expect(formatChanges(report)).not.toContain(String.fromCharCode(27));
  });
});

describe("before and after: renewals beside the page findings", () => {
  it("shows fixed, new and still there", () => {
    const result = compareRuns("marlowe-bar.example", [
      read("01", DOMAIN, OTHER),
      read("02", OTHER, WWW),
    ]);
    if (!result.ok) throw new Error(result.note);
    expect(result.report.renewals).toMatchObject({
      fixed: [DOMAIN],
      added: [WWW],
      unchanged: [OTHER],
    });
    const text = formatBeforeAfter(result);
    expect(text).toContain("Renewals fixed (1)");
    expect(text).toContain("Renewals new (1)");
    expect(text).toContain("Renewals still there (1)");
  });
  it("says so when the two runs share no renewal check they read, and compares nothing", () => {
    const result = compareRuns("marlowe-bar.example", [read("01", DOMAIN), run("02")]);
    if (!result.ok) throw new Error(result.note);
    expect(result.report.renewals).toBeUndefined();
    expect(formatBeforeAfter(result)).toContain(
      "Renewals are not compared: the two runs did not both read them.",
    );
  });
  it("prints nothing about renewals when neither run read them (old history reads as before)", () => {
    const result = compareRuns("marlowe-bar.example", [run("01"), run("02")]);
    if (!result.ok) throw new Error(result.note);
    expect(formatBeforeAfter(result)).not.toMatch(/Renewals/);
  });
});

describe("the receipt: renewals are fixed only by a run that read the renewals", () => {
  const rr = (day: string, ...site: RecordedSiteFinding[]): ReceiptRun => ({
    takenAt: `2026-10-${day}T06:00:00.000Z`,
    pages: ["/"],
    findings: [],
    siteFindings: site,
    renewalChecks: CHECKS,
  });
  const plain = (day: string): ReceiptRun => ({
    takenAt: `2026-10-${day}T06:00:00.000Z`,
    pages: ["/"],
    findings: [],
  });
  const build = (runs: ReceiptRun[]) =>
    buildReceipt({
      site: "marlowe-bar.example",
      month: "2026-10",
      runs,
      now: new Date("2026-11-13T09:00:00.000Z"),
    });

  it("a renewal fixed in the month is under Renewals, with its address and no page", () => {
    const r = build([rr("01"), rr("02", DOMAIN), rr("03", DOMAIN), rr("04")]);
    expect(r.groups.map((g) => g.name)).toEqual(["Renewals"]);
    expect(r.groups[0]?.items).toEqual([
      {
        checkId: "domain-expires-soon",
        title: DOMAIN.title,
        path: "domain:marlowe-bar.example",
        site: true,
        firstSeen: "2026-10-02",
        resolvedOn: "2026-10-04",
        reportedByClient: false,
      },
    ]);
    const md = receiptMarkdown(r);
    expect(md).toContain("### Renewals");
    expect(md).toContain(
      "- **The domain's registration runs out soon** (domain:marlowe-bar.example, seen Fri 2 Oct, fixed by Sun 4 Oct).",
    );
    expect(md).not.toContain("(on domain:");
  });
  it("two domains of one check are two items", () => {
    const r = build([rr("01", DOMAIN, OTHER), rr("02", OTHER), rr("03")]);
    expect(r.groups[0]?.items.map((i) => [i.path, i.resolvedOn])).toEqual([
      ["domain:marlowe-bar.example", "2026-10-02"],
      ["domain:marlowe-grill.example", "2026-10-03"],
    ]);
  });
  it("a run that did not read the renewals does not fix a renewal, and does not open it twice", () => {
    const r = build([rr("01", DOMAIN), plain("02"), rr("03", DOMAIN)]);
    expect(r.groups).toEqual([]);
    expect(r.counts).toMatchObject({ opened: 1, stillOpen: 1 });
  });
  it("is still open while every run that read the renewals has it", () => {
    const r = build([rr("01", DOMAIN), plain("02")]);
    expect(r.stillOpen.map((i) => i.path)).toEqual(["domain:marlowe-bar.example"]);
  });
  it("old runs with no site findings change nothing", () => {
    const r = build([plain("01"), plain("02")]);
    expect(r.groups).toEqual([]);
    expect(r.counts.opened).toBe(0);
  });
});
