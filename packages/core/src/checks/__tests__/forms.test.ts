// check-community: allow-email (invented addresses at reserved example domains, as mailto links the checks read)
import { describe, expect, it } from "vitest";
import { startFixture } from "../../../../fixtures/src/index.js";
import { createFetcher } from "../../fetcher.js";
import { findMailtoCtas } from "../../forms/mailto.js";
import { PROVIDERS } from "../../forms/providers.js";
import type { Check, Finding } from "../../model.js";
import { buildSnapshot, type PageSnapshot } from "../../snapshot.js";
import { checkSite } from "../../site.js";
import { crmInsecure } from "../crm-insecure.js";
import { crmLateTracking } from "../crm-late-tracking.js";
import { crmNoCampaignFields } from "../crm-no-campaign-fields.js";
import { crmNoTracking } from "../crm-no-tracking.js";
import { hasCampaignField } from "../forms.js";
import { formsManyProviders } from "../forms-many-providers.js";
import { PAGE_CHECKS, createPageRegistry } from "../index.js";
import { mailtoCta } from "../mailto-cta.js";
import { page } from "./helpers.js";

const HTTPS = "https://harbour-physio.example/book/";
const HTTP = "http://harbour-physio.example/book/";

function snap(body: string, head = "", url = HTTPS): PageSnapshot {
  return buildSnapshot([
    {
      url,
      status: 200,
      headers: { "content-type": "text/html" },
      body: `<html><head><title>Harbour Physio</title>${head}</head><body>${body}</body></html>`,
      ms: 1,
    },
  ]);
}

type Noted = { url: string; reason: string };
async function run(check: Check<PageSnapshot>, s: PageSnapshot) {
  const notes: Noted[] = [];
  const found = (await check.run(s, {
    warn: () => undefined,
    couldNotCheck: (url: string, reason: string) => notes.push({ url, reason }),
  })) as Finding[];
  return { found, notes };
}

const PARDOT_IFRAME =
  '<iframe src="https://go.pardot.com/l/100001/2026-02-03/xk2m?utm_source=x"></iframe>';
const PARDOT_TRACK = '<script src="https://pi.pardot.com/pd.js"></script>';
const PARDOT_LABEL = "Pardot (Marketing Cloud Account Engagement)";
const HS_FORM = '<form action="https://forms.hubspot.com/uploads/form/v2/1234567/news"></form>';
const HS_TRACK = '<script src="https://js.hs-scripts.com/1234567.js"></script>';
const W2L =
  '<form action="https://webto.salesforce.com/servlet/servlet.WebToLead?encoding=UTF-8" method="POST">';
const MKTO_FORM = '<form action="https://app-ab12.marketo.com/index.php/leadCapture/save2"></form>';
const MKTO_TRACK = '<script src="https://munchkin.marketo.net/munchkin.js"></script>';
const LOAD_LOADER =
  "<script>piAId = '100001'; (function(){ function l(){ var s = document.createElement('script'); s.src = 'https://pi.pardot.com/pd.js'; document.body.appendChild(s); } window.addEventListener('load', l, false); })();</script>";

// ---- unit: crm-no-tracking ----------------------------------------------------------------------

describe("crm-no-tracking: unit", () => {
  const cases: { name: string; body: string; head?: string; fires: number }[] = [
    { name: "a Pardot iframe and no tracking code", body: PARDOT_IFRAME, fires: 1 },
    {
      name: "a Pardot iframe and pd.js in the head",
      body: PARDOT_IFRAME,
      head: PARDOT_TRACK,
      fires: 0,
    },
    {
      name: "a Pardot iframe and the piAId variable",
      body: PARDOT_IFRAME,
      head: "<script>piAId = '100001';</script>",
      fires: 0,
    },
    { name: "a HubSpot form and no tracking code", body: HS_FORM, fires: 1 },
    { name: "a HubSpot form and its tracking script", body: HS_FORM, head: HS_TRACK, fires: 0 },
    { name: "a Marketo form and no Munchkin", body: MKTO_FORM, fires: 1 },
    { name: "a Marketo form and Munchkin", body: MKTO_FORM, head: MKTO_TRACK, fires: 0 },
    {
      name: "a Pardot iframe with only HubSpot's tracking code (another provider's does not count)",
      body: PARDOT_IFRAME,
      head: HS_TRACK,
      fires: 1,
    },
    {
      name: "two HubSpot forms and no tracking code (one finding per form)",
      body: HS_FORM + HS_FORM,
      fires: 2,
    },
    { name: "no form at all", body: "<p>Hello</p>", fires: 0 },
    {
      name: "a form that is not from a recognised provider",
      body: '<form action="/enquire"></form>',
      fires: 0,
    },
  ];
  for (const c of cases) {
    it(`${c.name}: ${c.fires === 0 ? "does not fire" : `fires ${c.fires}`}`, async () => {
      const { found } = await run(crmNoTracking, snap(c.body, c.head));
      expect(found).toHaveLength(c.fires);
    });
  }

  it("skips Typeform, Formstack and Web-to-Lead, which have no tracking script in the table", async () => {
    for (const body of [
      '<iframe src="https://form.typeform.com/to/AbC123"></iframe>',
      '<iframe src="https://baybakery.formstack.com/forms/?1234567-AbCdEf"></iframe>',
      `${W2L}<input type="hidden" name="oid" value="x"></form>`,
    ]) {
      const { found, notes } = await run(crmNoTracking, snap(body));
      expect(found).toEqual([]);
      expect(notes).toEqual([]);
    }
    for (const p of PROVIDERS) {
      expect(p.trackingScript !== undefined).toBe(["pardot", "hubspot", "marketo"].includes(p.id));
    }
  });

  it("names the provider by its label, the form's address without its query, at the check's severity", async () => {
    const { found } = await run(crmNoTracking, snap(PARDOT_IFRAME));
    expect(found).toEqual([
      {
        checkId: "crm-no-tracking",
        severity: "high",
        title: crmNoTracking.title,
        evidence: `${PARDOT_LABEL} iframe https://go.pardot.com/l/100001/2026-02-03/xk2m: its tracking code is not on the page.`,
        url: HTTPS,
      },
    ]);
    const form = await run(crmNoTracking, snap(HS_FORM));
    expect(form.found[0]?.evidence).toBe(
      "HubSpot form posting to https://forms.hubspot.com/uploads/form/v2/1234567/news: its tracking code is not on the page.",
    );
  });

  it("is not a finding for a page that did not load as HTML", async () => {
    const s = { ...snap(PARDOT_IFRAME), status: 404 };
    expect((await run(crmNoTracking, s)).found).toEqual([]);
  });
});

// ---- unit: crm-late-tracking --------------------------------------------------------------------

describe("crm-late-tracking: unit", () => {
  const pardotPage = (trackingAt: number, formAt: number): PageSnapshot =>
    page({
      finalUrl: HTTPS,
      iframes: [{ src: "https://go.pardot.com/l/1/2/3", position: formAt }],
      scriptTags: [{ src: "https://pi.pardot.com/pd.js", position: trackingAt }],
    });

  it("passes with tracking at position 4 and the form at position 9", async () => {
    expect((await run(crmLateTracking, pardotPage(4, 9))).found).toEqual([]);
  });

  it("fires when it is reversed: the form at 4 and the tracking at 9", async () => {
    const { found } = await run(crmLateTracking, pardotPage(9, 4));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      checkId: "crm-late-tracking",
      severity: "medium",
      url: HTTPS,
    });
    expect(found[0]?.evidence).toBe(
      `${PARDOT_LABEL} iframe https://go.pardot.com/l/1/2/3: its tracking code comes after the form in the page's HTML. Load the tracking script in the head, before the form.`,
    );
  });

  it("fires for a form element too, in plain HTML order", async () => {
    expect((await run(crmLateTracking, snap(HS_FORM + HS_TRACK))).found).toHaveLength(1);
    expect((await run(crmLateTracking, snap(HS_TRACK + HS_FORM))).found).toEqual([]);
    expect((await run(crmLateTracking, snap(MKTO_FORM + MKTO_TRACK))).found).toHaveLength(1);
  });

  it("fires when the loader runs on window load and the form is an iframe", async () => {
    const { found } = await run(crmLateTracking, snap(PARDOT_IFRAME, LOAD_LOADER));
    expect(found).toHaveLength(1);
    expect(found[0]?.evidence).toContain("loaded by a window load handler");
    expect(found[0]?.evidence).toContain("Load the tracking script in the head, before the form.");
  });

  it("recognises the other ways of waiting for window load", async () => {
    for (const code of [
      "window.onload = function () { load('https://pi.pardot.com/pd.js'); };",
      "window.attachEvent('onload', async_load); /* piAId pi.pardot.com/pd.js */",
    ]) {
      const { found } = await run(crmLateTracking, snap(PARDOT_IFRAME, `<script>${code}</script>`));
      expect(found, code).toHaveLength(1);
    }
  });

  it("passes an iframe when a direct pd.js comes before it, even with a window load loader too", async () => {
    const { found } = await run(crmLateTracking, snap(PARDOT_IFRAME, PARDOT_TRACK + LOAD_LOADER));
    expect(found).toEqual([]);
  });

  it("does not mind a window load loader when the form is a form element, not an iframe", async () => {
    const hubspotLoad =
      "<script>_hsq = []; window.addEventListener('load', function(){ /* js.hs-scripts.com/1.js */ });</script>";
    expect((await run(crmLateTracking, snap(HS_FORM, hubspotLoad))).found).toEqual([]);
  });

  it("does not fire when the provider has no tracking code on the page (crm-no-tracking says that)", async () => {
    const { found, notes } = await run(crmLateTracking, snap(PARDOT_IFRAME));
    expect(found).toEqual([]);
    expect(notes).toEqual([]);
  });

  it("skips Typeform, Formstack and Web-to-Lead", async () => {
    for (const body of [
      '<iframe src="https://form.typeform.com/to/AbC123"></iframe>',
      '<iframe src="https://baybakery.formstack.com/forms/?1"></iframe>',
      `${W2L}<input type="hidden" name="oid" value="x"></form>`,
    ]) {
      expect((await run(crmLateTracking, snap(body, LOAD_LOADER))).found).toEqual([]);
    }
  });
});

// ---- unit: crm-insecure -------------------------------------------------------------------------

describe("crm-insecure: unit", () => {
  it("fires once for an http form action on an https page", async () => {
    const { found } = await run(
      crmInsecure,
      snap('<form action="http://forms.hubspot.com/uploads/form/v2/1/2?token=abc"></form>'),
    );
    expect(found).toEqual([
      {
        checkId: "crm-insecure",
        severity: "high",
        title: crmInsecure.title,
        evidence:
          "HubSpot form action http://forms.hubspot.com/uploads/form/v2/1/2 is plain http on an https page.",
        url: HTTPS,
      },
    ]);
  });

  it("names a form of no recognised provider as a form", async () => {
    const { found } = await run(
      crmInsecure,
      snap('<form action="http://crm.example/leads"></form>'),
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.evidence).toBe(
      "Form action http://crm.example/leads is plain http on an https page.",
    );
  });

  it("fires for an http iframe, an http embed script and an http tracking script", async () => {
    const iframe = await run(
      crmInsecure,
      snap('<iframe src="http://go.pardot.com/l/1/2/3"></iframe>'),
    );
    expect(iframe.found.map((f) => f.evidence)).toEqual([
      `${PARDOT_LABEL} iframe http://go.pardot.com/l/1/2/3 is plain http on an https page.`,
    ]);
    const embed = await run(
      crmInsecure,
      snap('<script src="http://js.hsforms.net/forms/embed/v2.js"></script>'),
    );
    expect(embed.found.map((f) => f.evidence)).toEqual([
      "HubSpot form script http://js.hsforms.net/forms/embed/v2.js is plain http on an https page.",
    ]);
    const tracking = await run(
      crmInsecure,
      snap('<script src="http://cdn.pardot.com/pd.js"></script>' + PARDOT_IFRAME),
    );
    expect(tracking.found.map((f) => f.evidence)).toEqual([
      `${PARDOT_LABEL} tracking script http://cdn.pardot.com/pd.js is plain http on an https page.`,
    ]);
  });

  it("does not fire for https parts, protocol-relative addresses or an http page", async () => {
    expect(
      (await run(crmInsecure, snap('<form action="//forms.hubspot.com/x"></form>' + HS_TRACK)))
        .found,
    ).toEqual([]);
    expect(
      (await run(crmInsecure, snap('<form action="http://crm.example/leads"></form>', "", HTTP)))
        .found,
    ).toEqual([]);
  });

  it("does not read the http branch of Pardot's own conditional loader as a plain http script", async () => {
    const { found } = await run(crmInsecure, snap(PARDOT_IFRAME, LOAD_LOADER));
    expect(found).toEqual([]);
    const fixtureSnippet = `<script>piAId = '1'; s.src = ('https:' == document.location.protocol ? 'https://pi' : 'http://cdn') + '.pardot.com/pd.js';</script>`;
    expect((await run(crmInsecure, snap(PARDOT_IFRAME, fixtureSnippet))).found).toEqual([]);
  });

  it("is one finding for each insecure part", async () => {
    const { found } = await run(
      crmInsecure,
      snap(
        '<form action="http://crm.example/a"></form><form action="http://crm.example/b"></form>',
      ),
    );
    expect(found).toHaveLength(2);
  });
});

// ---- unit: the hidden-field matcher -------------------------------------------------------------

describe("hasCampaignField", () => {
  it("accepts utm_*, gclid and a lead source field in any case", () => {
    for (const name of [
      "utm_source",
      "UTM_Source",
      "utm_campaign",
      "gclid",
      "GCLID",
      "lead_source",
      "LeadSource",
    ]) {
      expect(hasCampaignField([name], "pardot"), name).toBe(true);
    }
  });

  it("accepts each provider's own default field", () => {
    expect(hasCampaignField(["campaign_id"], "pardot")).toBe(true);
    expect(hasCampaignField(["Campaign_ID"], "salesforce-web-to-lead")).toBe(true);
    expect(hasCampaignField(["hs_context"], "hubspot")).toBe(true);
    expect(hasCampaignField(["leadSource"], "marketo")).toBe(true);
    // Another provider's default is not this one's.
    expect(hasCampaignField(["hs_context"], "pardot")).toBe(false);
  });

  it("does not accept fields named otherwise", () => {
    for (const name of ["oid", "retURL", "source_campaign", "email", "utmsource", "my_gclid_x"]) {
      expect(hasCampaignField([name], "salesforce-web-to-lead"), name).toBe(false);
    }
    expect(hasCampaignField([], "pardot")).toBe(false);
  });
});

// ---- unit: crm-no-campaign-fields ---------------------------------------------------------------

describe("crm-no-campaign-fields: unit", () => {
  const w2l = (...fields: string[]) =>
    W2L +
    fields.map((n) => `<input type="hidden" name="${n}" value="x">`).join("") +
    '<input name="email"></form>';

  it("fires for a Web-to-Lead form with no campaign field, listing the hidden fields found", async () => {
    const { found } = await run(crmNoCampaignFields, snap(w2l("oid", "retURL")));
    expect(found).toEqual([
      {
        checkId: "crm-no-campaign-fields",
        severity: "medium",
        title: crmNoCampaignFields.title,
        evidence:
          "Salesforce Web-to-Lead form posting to https://webto.salesforce.com/servlet/servlet.WebToLead has no utm_*, gclid or lead source field; hidden fields found: oid, retURL.",
        url: HTTPS,
      },
    ]);
  });

  it("says so when the form has no hidden fields at all", async () => {
    const { found } = await run(crmNoCampaignFields, snap(HS_FORM));
    expect(found[0]?.evidence).toContain("hidden fields found: none.");
  });

  it("does not fire with utm_source, UTM_Source, gclid or lead_source as a hidden input", async () => {
    for (const name of ["utm_source", "UTM_Source", "gclid", "lead_source"]) {
      expect((await run(crmNoCampaignFields, snap(w2l("oid", name)))).found, name).toEqual([]);
    }
  });

  it("does not count a visible input named utm_source", async () => {
    const body = `${W2L}<input type="hidden" name="oid" value="x"><input name="utm_source"></form>`;
    const { found } = await run(crmNoCampaignFields, snap(body));
    expect(found).toHaveLength(1);
    expect(found[0]?.evidence).toContain("hidden fields found: oid.");
  });

  it("fires, with the fields it found, when they are named differently from the provider defaults", async () => {
    const { found } = await run(crmNoCampaignFields, snap(w2l("oid", "source_campaign")));
    expect(found).toHaveLength(1);
    expect(found[0]?.evidence).toContain("hidden fields found: oid, source_campaign.");
  });

  it("is one finding, for the second form, when two forms of one provider differ", async () => {
    const body = w2l("oid", "utm_campaign") + w2l("oid", "retURL");
    const { found } = await run(crmNoCampaignFields, snap(body));
    expect(found).toHaveLength(1);
    expect(found[0]?.evidence).toContain("hidden fields found: oid, retURL.");
  });

  it("covers Pardot, HubSpot and Marketo forms", async () => {
    for (const body of [
      '<form action="https://go.pardot.com/l/1/2/3"></form>',
      HS_FORM,
      MKTO_FORM,
    ]) {
      expect((await run(crmNoCampaignFields, snap(body))).found, body).toHaveLength(1);
    }
  });

  it("says it could not see inside an embedded form, and does not fail it", async () => {
    const { found, notes } = await run(crmNoCampaignFields, snap(PARDOT_IFRAME));
    expect(found).toEqual([]);
    expect(notes).toEqual([
      {
        url: HTTPS,
        reason: `could not see inside the embedded form: the ${PARDOT_LABEL} iframe https://go.pardot.com/l/100001/2026-02-03/xk2m is another document`,
      },
    ]);
  });

  it("skips Typeform and Formstack, and a form of no recognised provider", async () => {
    for (const body of [
      '<iframe src="https://form.typeform.com/to/AbC123"></iframe>',
      '<form action="https://www.formstack.com/forms/index.php"></form>',
      '<form action="/enquire"></form>',
    ]) {
      const { found, notes } = await run(crmNoCampaignFields, snap(body));
      expect(found).toEqual([]);
      expect(notes).toEqual([]);
    }
  });
});

// ---- unit: forms-many-providers -----------------------------------------------------------------

describe("forms-many-providers: unit", () => {
  const typeform = '<iframe src="https://form.typeform.com/to/AbC123"></iframe>';

  it("lists both providers when HubSpot and Typeform share a page", async () => {
    const { found } = await run(formsManyProviders, snap(HS_FORM + typeform));
    expect(found).toEqual([
      {
        checkId: "forms-many-providers",
        severity: "low",
        title: formsManyProviders.title,
        evidence: "Forms from 2 services are on this page: HubSpot and Typeform.",
        url: HTTPS,
      },
    ]);
  });

  it("lists three the same way", async () => {
    const { found } = await run(formsManyProviders, snap(HS_FORM + typeform + PARDOT_IFRAME));
    expect(found[0]?.evidence).toBe(
      `Forms from 3 services are on this page: HubSpot, Typeform and ${PARDOT_LABEL}.`,
    );
  });

  it("does not fire for one provider, however many of its forms and scripts are on the page", async () => {
    const hubspotScripts =
      '<script src="https://js.hsforms.net/forms/embed/v2.js"></script><script>hbspt.forms.create({});</script>';
    expect((await run(formsManyProviders, snap(HS_FORM + HS_FORM + hubspotScripts))).found).toEqual(
      [],
    );
  });

  it("does not count a form of no recognised provider, or a tracking script", async () => {
    expect(
      (await run(formsManyProviders, snap(HS_FORM + '<form action="/enquire"></form>'))).found,
    ).toEqual([]);
    expect((await run(formsManyProviders, snap(HS_FORM + PARDOT_TRACK))).found).toEqual([]);
  });
});

// ---- unit: mailto-cta ---------------------------------------------------------------------------

describe("mailto-cta: unit", () => {
  it("is registered once, in Leads, at medium", () => {
    expect(mailtoCta.area).toBe("Leads");
    expect(mailtoCta.severity).toBe("medium");
    expect(PAGE_CHECKS.filter((c) => c.id === "mailto-cta")).toHaveLength(1);
    expect(
      createPageRegistry()
        .all()
        .filter((c) => c.id === "mailto-cta"),
    ).toHaveLength(1);
  });

  it("yields exactly one finding for a Talk to an expert button with a mailto link", async () => {
    const body =
      '<a class="btn" href="mailto:sales@harbour-physio.example?subject=Hello">Talk to an expert</a>';
    const { found } = await run(mailtoCta, snap(body));
    expect(found).toEqual([
      {
        checkId: "mailto-cta",
        severity: "medium",
        title: mailtoCta.title,
        evidence:
          'Opens an email instead of a form: "Talk to an expert" (mailto:sales@harbour-physio.example).',
        url: HTTPS,
      },
    ]);
  });

  it("is still one finding when the same button appears twice, and lists distinct ones in one", async () => {
    const a = '<a href="mailto:sales@x.example">Talk to an expert</a>';
    const b = '<a href="mailto:hello@x.example">Get a quote</a>';
    expect((await run(mailtoCta, snap(a + a))).found).toHaveLength(1);
    const both = await run(mailtoCta, snap(a + b));
    expect(both.found).toHaveLength(1);
    expect(both.found[0]?.evidence).toContain('"Talk to an expert" (mailto:sales@x.example)');
    expect(both.found[0]?.evidence).toContain('"Get a quote" (mailto:hello@x.example)');
  });

  it("leaves a published address, an icon and a plain word alone", async () => {
    for (const body of [
      '<a href="mailto:hello@x.example">hello@x.example</a>',
      '<a href="mailto:hello@x.example"></a>',
      '<a href="mailto:hello@x.example">Opening hours</a>',
      '<a href="tel:+15550100">Call us</a>',
      '<a href="https://x.example/contact">Contact us</a>',
      '<a href="mailto:">Contact us</a>',
    ]) {
      expect((await run(mailtoCta, snap(body))).found, body).toEqual([]);
    }
  });

  it("finds contact words in the usual call-to-action wording", () => {
    for (const text of [
      "Contact us",
      "Email us",
      "Get in touch",
      "Book a consultation",
      "Request a demo",
      "Speak to sales",
    ]) {
      const found = findMailtoCtas(snap(`<a href="mailto:a@b.example">${text}</a>`));
      expect(found, text).toHaveLength(1);
    }
  });

  it("detects from forms/mailto.ts, which the check imports", () => {
    const found = findMailtoCtas(snap('<a href="mailto:Sales@X.example">Talk to an expert</a>'));
    expect(found).toEqual([{ text: "Talk to an expert", address: "Sales@X.example" }]);
  });
});

// ---- the page does not load as HTML / registry ---------------------------------------------------

describe("the form checks: registry", () => {
  it("registers six ids, all in Leads", () => {
    const ids = [
      "crm-insecure",
      "crm-late-tracking",
      "crm-no-campaign-fields",
      "crm-no-tracking",
      "forms-many-providers",
      "mailto-cta",
    ];
    for (const id of ids) {
      const c = PAGE_CHECKS.find((x) => x.id === id);
      expect(c?.area, id).toBe("Leads");
      expect(c?.what && c.why && c.fix && c.tech, id).toBeTruthy();
    }
  });

  it("only reads the snapshot: no check asks for a fetcher", async () => {
    for (const c of [
      crmNoTracking,
      crmLateTracking,
      crmInsecure,
      crmNoCampaignFields,
      formsManyProviders,
      mailtoCta,
    ]) {
      const { found } = await run(
        c,
        snap(HS_FORM + PARDOT_IFRAME + '<a href="mailto:a@b.example">Contact us</a>'),
      );
      expect(Array.isArray(found)).toBe(true);
    }
  });
});

// ---- edge cases ---------------------------------------------------------------------------------

describe("the form checks: edge cases", () => {
  const hubspotDrawn =
    '<div id="newsletter"></div><script src="https://js.hsforms.net/forms/embed/v2.js"></script><script>hbspt.forms.create({ portalId: "1", formId: "2", target: "#newsletter" });</script>';

  it("reports a form injected by JavaScript as not visible without JavaScript, never as missing tracking", async () => {
    const noTracking = await run(crmNoTracking, snap(hubspotDrawn));
    expect(noTracking.found).toEqual([]);
    expect(noTracking.notes).toHaveLength(1);
    expect(noTracking.notes[0]?.reason).toContain("HubSpot");
    expect(noTracking.notes[0]?.reason).toContain("JavaScript");
    const fields = await run(crmNoCampaignFields, snap(hubspotDrawn));
    expect(fields.found).toEqual([]);
    expect(fields.notes).toHaveLength(1);
    const late = await run(crmLateTracking, snap(hubspotDrawn + HS_TRACK));
    expect(late.found).toEqual([]);
    expect(late.notes).toHaveLength(1);
  });

  it("does not note a drawn form when the HTML holds that provider's own form", async () => {
    const { notes } = await run(crmNoTracking, snap(hubspotDrawn + HS_FORM));
    expect(notes).toEqual([]);
  });

  it("escapes what a page puts in an address", async () => {
    const s = page({
      finalUrl: HTTPS,
      forms: [
        { action: "http://crm.example:x/\u0007\u200Bleads?k=1", hiddenFields: [], position: 0 },
      ],
    });
    const { found } = await run(crmInsecure, s);
    expect(found[0]?.evidence).toContain("\\u{7}\\u{200B}");
    // eslint-disable-next-line no-control-regex -- the point is that none remain
    expect(found[0]?.evidence).not.toMatch(/[\u0000-\u0008\u200B]/);
  });

  it("a snapshot from an older run, with no iframes or scriptTags, gives no finding and no error", async () => {
    const s = page({ finalUrl: HTTPS });
    for (const c of [
      crmNoTracking,
      crmLateTracking,
      crmInsecure,
      crmNoCampaignFields,
      formsManyProviders,
      mailtoCta,
    ]) {
      expect((await run(c, s)).found, c.id).toEqual([]);
    }
  });
});

// ---- integration --------------------------------------------------------------------------------

describe("integration: the form-checks fixture", () => {
  it("fires late-tracking, not no-tracking, for the Pardot loader on window load with an iframed form", async () => {
    const site = await startFixture("form-checks");
    try {
      const fetcher = createFetcher({ allowPrivate: true });
      const { result } = await checkSite({
        address: site.origin,
        fetcher,
        only: [
          "crm-no-tracking",
          "crm-late-tracking",
          "crm-insecure",
          "crm-no-campaign-fields",
          "forms-many-providers",
          "mailto-cta",
        ],
      });
      const byId = (id: string) => result.findings.filter((f) => f.checkId === id);
      expect(byId("crm-late-tracking")).toHaveLength(1);
      expect(byId("crm-late-tracking")[0]?.evidence).toContain("Pardot");
      // Pardot's tracking is on the page; only the HubSpot form lacks its own.
      expect(byId("crm-no-tracking").map((f) => f.evidence)).toEqual([
        expect.stringContaining("HubSpot form posting to https://forms.hubspot.com/"),
      ]);
      // An http page: nothing is mixed content.
      expect(byId("crm-insecure")).toEqual([]);
      expect(byId("crm-no-campaign-fields")).toHaveLength(2);
      expect(
        result.couldNotCheck.filter((n) => n.id === "crm-no-campaign-fields").map((n) => n.reason),
      ).toEqual([expect.stringContaining("could not see inside the embedded form")]);
      expect(byId("forms-many-providers")[0]?.evidence).toContain("Salesforce Web-to-Lead");
      expect(byId("mailto-cta")).toHaveLength(1);
      expect(site.requests.every((l) => l.method === "GET" || l.method === "HEAD")).toBe(true);
      // Nothing was asked of a form provider: every request went to the fixture itself.
      expect(
        site.requests.every((l) => !/pardot|hubspot|salesforce/.test(`${l.host}${l.path}`)),
      ).toBe(true);
    } finally {
      await site.close();
    }
  });

  it("an https page with an http form action: insecure fires once", async () => {
    const s = snap(
      '<form action="http://webto.salesforce.com/servlet/servlet.WebToLead?encoding=UTF-8"><input type="hidden" name="oid" value="x"></form>',
    );
    const { found } = await run(crmInsecure, s);
    expect(found).toHaveLength(1);
    expect(found[0]?.evidence).toContain("Salesforce Web-to-Lead form action http://");
  });

  it("a page with HubSpot and Typeform: the many-providers finding lists both", async () => {
    const s = snap(
      HS_FORM + HS_TRACK + '<iframe src="https://form.typeform.com/to/AbC123"></iframe>',
    );
    const { found } = await run(formsManyProviders, s);
    expect(found).toHaveLength(1);
    expect(found[0]?.evidence).toContain("HubSpot");
    expect(found[0]?.evidence).toContain("Typeform");
  });

  it("the Pardot page with an async loader on window load and an iframed form", async () => {
    const s = snap(PARDOT_IFRAME, LOAD_LOADER);
    expect((await run(crmLateTracking, s)).found).toHaveLength(1);
    expect((await run(crmNoTracking, s)).found).toEqual([]);
  });

  it("is deterministic: the same page gives the same findings twice", async () => {
    const s = snap(
      W2L + '<input type="hidden" name="oid" value="x"></form>' + PARDOT_IFRAME,
      LOAD_LOADER,
    );
    const once = await Promise.all(
      PAGE_CHECKS.filter((c) => c.area === "Leads").map((c) => run(c as Check<PageSnapshot>, s)),
    );
    const twice = await Promise.all(
      PAGE_CHECKS.filter((c) => c.area === "Leads").map((c) => run(c as Check<PageSnapshot>, s)),
    );
    expect(twice).toEqual(once);
  });
});
