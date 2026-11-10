import { describe, expect, it } from "vitest";
import { SITES_DIR } from "../../../../fixtures/src/index.js";
import { replayMcp, staticSite } from "../../../../testkit/src/index.js";
import { createFetcher } from "../../fetcher.js";
import type { Check, CheckContext, Finding } from "../../model.js";
import { CRM_CHECKS } from "../../presets.js";
import { checkSite } from "../../site.js";
import { buildSnapshot, type PageSnapshot } from "../../snapshot.js";
import { crmConfigSchema } from "../../sources/crm.js";
import { NO_CRM, NO_TRANSPORT, type CrmRead } from "../../sources/crm-read.js";
import { PAGE_CHECKS } from "../index.js";
import { crmFieldNames } from "../crm-field-names.js";
import { crmLeadSource } from "../crm-lead-source.js";
import { crmWentQuiet } from "../crm-went-quiet.js";

const HOST = "tideline-coaching.example";
const DIR = `${SITES_DIR}crm-leads`;
const NOW = () => new Date("2026-11-10T18:00:00Z");

const FIELDS = [
  "Id",
  "FirstName",
  "LastName",
  "Company",
  "Email",
  "Phone",
  "LeadSource",
  "Preferred_Session__c",
].map((name) => ({ name }));

const W2L = (inner: string) =>
  `<form action="https://webto.salesforce.com/servlet/servlet.WebToLead?encoding=UTF-8" method="POST">${inner}</form>`;

function snap(body: string): PageSnapshot {
  return buildSnapshot([
    {
      url: `https://${HOST}/`,
      status: 200,
      headers: { "content-type": "text/html" },
      body: `<html><head><title>Tideline Coaching</title></head><body>${body}</body></html>`,
      ms: 1,
    },
  ]);
}

type Noted = string[];
async function run(check: Check<PageSnapshot>, page: PageSnapshot, crm?: CrmRead, now = NOW) {
  const notes: Noted = [];
  const ctx: CheckContext = {
    warn: () => undefined,
    couldNotCheck: (_url: string, reason: string) => notes.push(reason),
    now,
    ...(crm ? { crm: () => Promise.resolve(crm) } : {}),
  };
  const found = (await check.run(page, ctx)) as Finding[];
  return { found, notes };
}

const blankLeads = (total: number, blank: number, field = "LeadSource") =>
  Array.from({ length: total }, (_, i) => ({
    id: `00Q5e00000Tx${String(i + 1).padStart(3, "0")}`,
    blank: i < blank ? [field] : [],
  }));

const recent = (
  total: number,
  blank: number,
  extra: Partial<NonNullable<CrmRead["recent"]>["sample"]> = {},
  missingFields: string[] = [],
): CrmRead => ({
  source: "Salesforce",
  reasons: {},
  recent: {
    since: new Date("2026-11-03T18:00:00Z"),
    missingFields,
    sample: {
      fields: ["LeadSource"],
      refused: [],
      leads: blankLeads(total, blank),
      truncated: false,
      ...extra,
    },
  },
});

const quiet = (total: number, latest: string | undefined, quietDays = 3): CrmRead => ({
  source: "Salesforce",
  reasons: {},
  window: {
    since: new Date("2026-10-27T18:00:00Z"),
    days: 14,
    quietDays,
    count: { total, ...(latest ? { latest: new Date(latest) } : {}) },
  },
});

describe("crm-lead-source: unit", () => {
  const page = snap("<p>hi</p>");

  it("counts the leads with an empty source and shows the field and five record ids", async () => {
    const { found, notes } = await run(crmLeadSource, page, recent(40, 12));
    expect(notes).toEqual([]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ checkId: "crm-lead-source", severity: "medium" });
    expect(found[0]?.evidence).toBe(
      "12 of 40 leads created since 2026-11-03 have an empty LeadSource. Example record ids: 00Q5e00000Tx001, 00Q5e00000Tx002, 00Q5e00000Tx003, 00Q5e00000Tx004, 00Q5e00000Tx005",
    );
  });

  it("names each field when several are watched, and says when the sample stopped at its limit", async () => {
    const read = recent(200, 30, { fields: ["LeadSource", "Campaign_Source__c"], truncated: true });
    for (const [i, lead] of (read.recent?.sample.leads ?? []).entries())
      if (i < 30) lead.blank = i % 2 === 0 ? ["LeadSource", "Campaign_Source__c"] : ["LeadSource"];
    const { found } = await run(crmLeadSource, page, read);
    expect(found[0]?.evidence).toMatch(
      /^30 of the newest 200 leads created since 2026-11-03 have an empty source field \(LeadSource: 30, Campaign_Source__c: 15\)\./,
    );
  });

  it("says nothing for a stray blank: under two leads, or under a tenth of them", async () => {
    expect((await run(crmLeadSource, page, recent(40, 1))).found).toEqual([]);
    expect((await run(crmLeadSource, page, recent(100, 9))).found).toEqual([]);
    expect((await run(crmLeadSource, page, recent(40, 0))).found).toEqual([]);
    expect((await run(crmLeadSource, page, recent(10, 2))).found).toHaveLength(1);
  });

  it("with no leads in the window, says there was nothing to check", async () => {
    const { found, notes } = await run(crmLeadSource, page, recent(0, 0));
    expect(found).toEqual([]);
    expect(notes).toEqual([
      "No leads were created since 2026-11-03, so there were no lead sources to check.",
    ]);
  });

  it("reports a watched field that Lead does not have, and still checks the others", async () => {
    const { found, notes } = await run(crmLeadSource, page, recent(40, 12, {}, ["Nope__c"]));
    expect(found).toHaveLength(1);
    expect(notes[0]).toMatch(/Lead has no field called Nope__c/);
  });

  it("is could-not-check with the reason when the CRM could not be read", async () => {
    const read: CrmRead = {
      source: "Salesforce",
      reasons: {
        recent: "The signed-in user cannot read the Lead object, so the CRM was not checked.",
      },
    };
    const { found, notes } = await run(crmLeadSource, page, read);
    expect(found).toEqual([]);
    expect(notes).toEqual([
      "The signed-in user cannot read the Lead object, so the CRM was not checked.",
    ]);
  });

  it("runs nothing when no CRM is configured", async () => {
    expect(await run(crmLeadSource, page)).toEqual({ found: [], notes: [] });
  });

  it("never puts anything but ids, counts and field names in the evidence", async () => {
    const hostile = recent(10, 5, { fields: ["Campaign_\u202ESource__c"] });
    const { found } = await run(crmLeadSource, page, hostile);
    expect(found[0]?.evidence).not.toContain("\u202E");
  });
});

describe("crm-field-names: unit", () => {
  const form = W2L(
    '<input type="hidden" name="oid" value="x"><input type="hidden" name="retURL" value="y">' +
      '<input name="first_name"><input name="last_name"><input name="email"><input name="company">' +
      '<input type="hidden" name="lead_source" value="Website"><input type="hidden" name="utm_campaign">' +
      '<input name="promo_code"><select name="preferred_time"></select><input name="00N5e000001AbCd">' +
      '<input type="submit" name="submit" value="Go"><textarea name="description"></textarea>',
  );
  const read: CrmRead = { source: "Salesforce", reasons: {}, fields: FIELDS };

  it("lists the names Lead has no field for, with how many matched", async () => {
    const { found, notes } = await run(crmFieldNames, snap(form), read);
    expect(notes).toEqual([]);
    expect(found).toHaveLength(1);
    expect(found[0]?.evidence).toBe(
      "A Web-to-Lead form sends promo_code, preferred_time, description, which Lead has no field for (5 other fields matched; 1 custom field was sent by id and not compared)",
    );
  });

  it("matches Web-to-Lead's own names to their Lead fields, labels and custom fields", async () => {
    const page = snap(
      W2L('<input name="first_name"><input name="Preferred_Session"><input name="zip">'),
    );
    const withLabels: CrmRead = {
      source: "Salesforce",
      reasons: {},
      fields: [
        { name: "FirstName" },
        { name: "Preferred_Session__c", label: "Best slot" },
        { name: "PostalCode" },
      ],
    };
    expect((await run(crmFieldNames, page, withLabels)).found).toEqual([]);
    const byLabel = snap(W2L('<input name="best slot">'));
    expect((await run(crmFieldNames, byLabel, withLabels)).found).toEqual([]);
  });

  it("finds nothing wrong in a form whose fields all exist", async () => {
    const page = snap(
      W2L('<input name="first_name"><input name="email"><input name="oid" type="hidden">'),
    );
    expect((await run(crmFieldNames, page, read)).found).toEqual([]);
  });

  it("caps the names it lists and counts the rest", async () => {
    const many = Array.from({ length: 12 }, (_, i) => `<input name="extra_${i}">`).join("");
    const { found } = await run(crmFieldNames, snap(W2L(many)), read);
    expect(found[0]?.evidence).toMatch(
      /^A Web-to-Lead form sends extra_0, .*extra_7 and 4 more, which Lead has no field for/,
    );
  });

  it("does not compare forms that are not Web-to-Lead, and reads no CRM for a page without one", async () => {
    const other = snap(
      '<form action="https://forms.hubspot.com/uploads/form/v2/1/x"><input name="zzz"></form>',
    );
    let asked = false;
    const ctx: CheckContext = {
      warn: () => undefined,
      crm: () => ((asked = true), Promise.resolve(read)),
    };
    expect(await crmFieldNames.run(other, ctx)).toEqual([]);
    expect(asked).toBe(false);
  });

  it("says a Salesforce form in an iframe was not read", async () => {
    const page = snap('<iframe src="https://go.pardot.com/l/1/2026-01-01/ab"></iframe>');
    const { found, notes } = await run(crmFieldNames, page, read);
    expect(found).toEqual([]);
    expect(notes[0]).toMatch(/inside an iframe or drawn by JavaScript/);
  });

  it("is could-not-check with the reason when Lead could not be read", async () => {
    const none: CrmRead = { source: "Salesforce", reasons: { fields: "No CRM." } };
    const { found, notes } = await run(crmFieldNames, snap(form), none);
    expect([found, notes]).toEqual([[], ["No CRM."]]);
  });
});

describe("crm-went-quiet: unit", () => {
  const withForm = snap(W2L('<input name="email">'));

  it("fires when leads stopped for the quiet days while the form is on the page", async () => {
    const { found } = await run(crmWentQuiet, withForm, quiet(31, "2026-11-05T14:30:12Z"));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ checkId: "crm-went-quiet", severity: "high" });
    expect(found[0]?.evidence).toBe(
      "No lead has been created for 5 days (the last was on 2026-11-05); 31 came in over the last 14 days, about 2.2 a day. A Salesforce Web-to-Lead form is still on the page",
    );
  });

  it("is exact about the boundary: 3 days is quiet, 2 days and 23 hours is not", async () => {
    expect(
      (await run(crmWentQuiet, withForm, quiet(31, "2026-11-07T18:00:00Z"))).found,
    ).toHaveLength(1);
    expect((await run(crmWentQuiet, withForm, quiet(31, "2026-11-07T18:00:01Z"))).found).toEqual(
      [],
    );
    expect(
      (await run(crmWentQuiet, withForm, quiet(31, "2026-11-04T18:00:00Z", 5))).found,
    ).toHaveLength(1);
    expect((await run(crmWentQuiet, withForm, quiet(31, "2026-11-06T18:00:00Z", 5))).found).toEqual(
      [],
    );
  });

  it("does not fire while leads are arriving", async () => {
    expect((await run(crmWentQuiet, withForm, quiet(88, "2026-11-10T16:41:07Z"))).found).toEqual(
      [],
    );
  });

  it("is could-not-check with too few leads to call it quiet, or with no leads at all", async () => {
    const few = await run(crmWentQuiet, withForm, quiet(4, "2026-11-01T10:00:00Z"));
    expect(few.found).toEqual([]);
    expect(few.notes).toEqual([
      "Only 4 leads in the last 14 days, too few to say leads went quiet.",
    ]);
    const none = await run(crmWentQuiet, withForm, quiet(0, undefined));
    expect(none.notes).toEqual([
      "Only 0 leads in the last 14 days, too few to say leads went quiet.",
    ]);
  });

  it("is could-not-check when no recognised form is on the page", async () => {
    const { found, notes } = await run(
      crmWentQuiet,
      snap("<p>No form.</p>"),
      quiet(31, "2026-11-01T10:00:00Z"),
    );
    expect(found).toEqual([]);
    expect(notes[0]).toMatch(/No recognised form is on this page/);
  });

  it("names every recognised provider that is on the page", async () => {
    const page = snap(
      `${W2L("")}<iframe src="https://go.pardot.com/l/100001/2026-02-03/xk2m"></iframe>`,
    );
    const { found } = await run(crmWentQuiet, page, quiet(31, "2026-11-01T10:00:00Z"));
    expect(found[0]?.evidence).toMatch(
      /A Pardot \(Marketing Cloud Account Engagement\) and Salesforce Web-to-Lead form is still on the page$/,
    );
  });

  it("reads the clock it was given, not the real one", async () => {
    const later = () => new Date("2027-01-01T00:00:00Z");
    const { found } = await run(crmWentQuiet, withForm, quiet(31, "2026-11-09T00:00:00Z"), later);
    expect(found[0]?.evidence).toMatch(/created for 53 days/);
  });
});

describe("the lead checks: registered, in Leads, and off unless a CRM is configured", () => {
  it("are page checks in the Leads area", () => {
    for (const id of CRM_CHECKS) {
      const check = PAGE_CHECKS.find((c) => c.id === id);
      expect(check?.area, id).toBe("Leads");
    }
    expect(CRM_CHECKS).toEqual(["crm-lead-source", "crm-field-names", "crm-went-quiet"]);
  });

  it("every one has what, why, fix and a technical line that names the read-only server", () => {
    for (const c of [crmLeadSource, crmFieldNames, crmWentQuiet]) {
      for (const f of [c.what, c.why, c.fix, c.tech]) expect(f.length).toBeGreaterThan(20);
      expect(c.tech).toMatch(/read-only MCP server/);
    }
  });
});

describe("the lead checks: integration (recorded MCP responses, an invented studio)", () => {
  const fetcher = () =>
    createFetcher({
      transport: staticSite(HOST, DIR, () => Promise.reject(new Error("unexpected request"))),
      timeoutMs: 5000,
    });
  const config = (salesforce: Record<string, unknown> = {}) =>
    crmConfigSchema.parse({ salesforce });

  async function runWith(recording: string, salesforce: Record<string, unknown> = {}) {
    const transport = replayMcp(recording);
    const { result } = await checkSite({
      address: `https://${HOST}/`,
      fetcher: fetcher(),
      only: [...CRM_CHECKS],
      now: NOW,
      crm: { config: config(salesforce), transport },
    });
    return { result, transport };
  }

  it("12 of 40 recent leads have a blank source: found, with the field and five record ids, and no names or emails", async () => {
    const { result, transport } = await runWith("tideline-leads");
    expect(result.failed).toEqual([]);
    expect(result.findings.map((f) => [f.checkId, f.evidence])).toEqual([
      [
        "crm-field-names",
        "A Web-to-Lead form sends promo_code, preferred_time, which Lead has no field for (5 other fields matched; 1 custom field was sent by id and not compared)",
      ],
      [
        "crm-lead-source",
        "12 of 40 leads created since 2026-11-03 have an empty LeadSource. Example record ids: 00Q5e00000Tx002, 00Q5e00000Tx003, 00Q5e00000Tx007, 00Q5e00000Tx009, 00Q5e00000Tx012",
      ],
    ]);
    expect(result.couldNotCheck).toEqual([]);
    expect(transport.seen.length).toBeLessThanOrEqual(8);
    expect(transport.unused()).toEqual([]);
    const output = JSON.stringify(result);
    expect(output).not.toMatch(/@|Rowan|Ellery|FirstName":|LastName":/);
  });

  it("a server that sends names and emails beside the ids still gives none of them in the output", async () => {
    const { result } = await runWith("tideline-leaky");
    expect(result.findings.find((f) => f.checkId === "crm-lead-source")?.evidence).toMatch(
      /^4 of 10 leads/,
    );
    expect(JSON.stringify(result)).not.toMatch(
      /Rowan|Ellery|Okafor|Lindqvist|Vance|invented\.example|555-01|knee rehab/,
    );
  });

  it("a custom field holds the campaign", async () => {
    const { result } = await runWith("tideline-custom-field", {
      sourceFields: ["Campaign_Source__c"],
    });
    expect(result.findings.find((f) => f.checkId === "crm-lead-source")?.evidence).toMatch(
      /^9 of 30 leads created since 2026-11-03 have an empty Campaign_Source__c\./,
    );
  });

  it("leads went quiet while the form still loads", async () => {
    const { result } = await runWith("tideline-quiet");
    expect(result.findings.find((f) => f.checkId === "crm-went-quiet")?.evidence).toBe(
      "No lead has been created for 5 days (the last was on 2026-11-05); 31 came in over the last 14 days, about 2.2 a day. A Salesforce Web-to-Lead form is still on the page",
    );
    // Six leads this week, all with a source.
    expect(result.findings.find((f) => f.checkId === "crm-lead-source")).toBeUndefined();
  });

  it("the signed-in user can't read Lead: unchecked, with the reason, never passed", async () => {
    const { result } = await runWith("tideline-no-lead-access");
    expect(result.findings).toEqual([]);
    expect(result.couldNotCheck.map((c) => c.id).sort()).toEqual([...CRM_CHECKS].sort());
    for (const c of result.couldNotCheck) expect(c.reason).toMatch(/cannot read the Lead object/);
  });

  it("the quota is nearly used: the run stops, says so, and asks nothing more", async () => {
    const { result, transport } = await runWith("tideline-quota-near");
    expect(result.findings).toEqual([]);
    for (const c of result.couldNotCheck)
      expect(c.reason).toMatch(/96% of the org's API allowance/);
    expect(result.couldNotCheck).toHaveLength(3);
    expect(transport.seen).toHaveLength(1);
  });

  it("without gaugeline.crm.json the lead checks are not run, so not passed either", async () => {
    const { result } = await checkSite({
      address: `https://${HOST}/`,
      fetcher: fetcher(),
      now: NOW,
    });
    const ran = new Set([
      ...result.passed,
      ...result.failed.map((f) => f.id),
      ...result.findings.map((f) => f.checkId),
    ]);
    for (const id of CRM_CHECKS) expect(ran.has(id), id).toBe(false);
    expect(result.couldNotCheck.some((c) => CRM_CHECKS.includes(c.id))).toBe(false);
  });

  it("asked for by id with nothing configured, they say no CRM is set up", async () => {
    const { result } = await checkSite({
      address: `https://${HOST}/`,
      fetcher: fetcher(),
      now: NOW,
      only: [...CRM_CHECKS],
    });
    expect(result.couldNotCheck.map((c) => c.reason)).toEqual([NO_CRM, NO_CRM, NO_CRM]);
  });

  it("configured but with no way to reach the server in this build: could not check, nothing requested", async () => {
    const { result } = await checkSite({
      address: `https://${HOST}/`,
      fetcher: fetcher(),
      now: NOW,
      only: [...CRM_CHECKS],
      crm: { config: config() },
    });
    expect(result.findings).toEqual([]);
    expect(result.couldNotCheck.map((c) => c.reason)).toEqual([
      NO_TRANSPORT,
      NO_TRANSPORT,
      NO_TRANSPORT,
    ]);
  });

  it("starts the lead window at the last run when there is one", async () => {
    const transport = replayMcp("tideline-leads");
    // The recording is matched on the query, so the 8 Nov window finds no answer: only the query asked is checked here.
    const { result } = await checkSite({
      address: `https://${HOST}/`,
      fetcher: fetcher(),
      now: NOW,
      only: ["crm-lead-source"],
      crm: { config: config(), transport },
      previous: {
        schema: 1,
        url: `https://${HOST}/`,
        takenAt: "2026-11-08T09:00:00.000Z",
        prices: {},
        forms: {},
      },
    });
    const query = transport.seen
      .map((s) => (s.message.params?.arguments as { query?: string } | undefined)?.query)
      .find((q) => q?.includes("ORDER BY"));
    expect(query).toContain("CreatedDate >= 2026-11-08T09:00:00Z");
    expect(result.failed).toEqual([]);
  });
});
