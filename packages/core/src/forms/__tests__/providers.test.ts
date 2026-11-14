import { describe, expect, it } from "vitest";
import type { Hop } from "../../fetcher.js";
import { buildSnapshot, type PageSnapshot } from "../../snapshot.js";
import {
  FORM_JS_NOTE,
  FORM_PROVIDER_IDS,
  PROVIDERS,
  detectForms,
  formNotes,
} from "../providers.js";
import type { FormProviderId } from "../types.js";

const URL0 = "https://tide-clinic.example/book/";
function snap(body: string): PageSnapshot {
  const hops: Hop[] = [
    { url: URL0, status: 200, headers: { "content-type": "text/html" }, body, ms: 1 },
  ];
  return buildSnapshot(hops);
}

/** A snapshot built by hand, for hosts the HTML parser would already have lower-cased. */
function bare(parts: Partial<PageSnapshot>): PageSnapshot {
  return { ...snap("<p>x</p>"), ...parts };
}

// ---- unit: the table of providers -------------------------------------------------------------------

describe("PROVIDERS", () => {
  it("is an array of six records, each with an id, a label, detect and campaignFields", () => {
    expect(PROVIDERS).toHaveLength(6);
    expect(PROVIDERS.map((p) => p.id)).toEqual([...FORM_PROVIDER_IDS]);
    expect(new Set(PROVIDERS.map((p) => p.id)).size).toBe(6);
    for (const p of PROVIDERS) {
      expect(p.label.length).toBeGreaterThan(0);
      expect(typeof p.detect).toBe("function");
      expect(Array.isArray(p.campaignFields)).toBe(true);
      if (p.trackingScript) expect(p.trackingScript).toBeInstanceOf(RegExp);
    }
  });

  it("labels Pardot as Pardot (Marketing Cloud Account Engagement)", () => {
    expect(PROVIDERS.find((p) => p.id === "pardot")?.label).toBe(
      "Pardot (Marketing Cloud Account Engagement)",
    );
  });

  it("gives the providers with a known tracking code a pattern that matches it", () => {
    const tracking = (id: FormProviderId) => PROVIDERS.find((p) => p.id === id)?.trackingScript;
    expect(tracking("pardot")?.test("https://pi.pardot.com/pd.js")).toBe(true);
    expect(tracking("pardot")?.test("piAId = '123456'; piCId = '1234';")).toBe(true);
    expect(tracking("hubspot")?.test("https://js.hs-scripts.com/1234567.js")).toBe(true);
    expect(tracking("marketo")?.test("//munchkin.marketo.net/munchkin.js")).toBe(true);
    expect(tracking("marketo")?.test('Munchkin.init("123-ABC-456");')).toBe(true);
    expect(tracking("pardot")?.test("https://example.com/app.js")).toBe(false);
  });
});

// ---- unit: two real-shaped snippets per provider, each matching only its own provider --------------

type Row = { name: string; html: string; kind: "form" | "iframe" | "embed-script" };
const TABLE: Record<FormProviderId, Row[]> = {
  pardot: [
    {
      name: "a form handler action",
      kind: "form",
      html: '<form action="https://go.pardot.com/l/123456/2026-01-12/abcd" method="post"><input type="hidden" name="utm_source"><input name="email"></form>',
    },
    {
      name: "an iframe on the go.pardot.com page",
      kind: "iframe",
      html: '<iframe src="https://go.pardot.com/l/123456/2026-01-12/wxyz" width="500" height="500" type="text/html" frameborder="0"></iframe>',
    },
  ],
  "salesforce-web-to-lead": [
    {
      name: "the production servlet",
      kind: "form",
      html: '<form action="https://webto.salesforce.com/servlet/servlet.WebToLead?encoding=UTF-8" method="POST"><input type="hidden" name="oid" value="00Dxx0000000000"><input type="hidden" name="retURL" value="https://tide-clinic.example/thanks"></form>',
    },
    {
      name: "the sandbox servlet",
      kind: "form",
      html: '<form action="https://test.salesforce.com/servlet/servlet.WebToLead?encoding=UTF-8" method="POST"><input type="hidden" name="oid" value="00Dxx0000000001"></form>',
    },
  ],
  hubspot: [
    {
      name: "the forms embed script",
      kind: "embed-script",
      html: '<script charset="utf-8" type="text/javascript" src="//js.hsforms.net/forms/embed/v2.js"></script>',
    },
    {
      name: "an inline hbspt.forms.create call",
      kind: "embed-script",
      html: '<script>hbspt.forms.create({ region: "na1", portalId: "1234567", formId: "11111111-2222-3333-4444-555555555555" });</script>',
    },
  ],
  formstack: [
    {
      name: "an iframe on the account subdomain",
      kind: "iframe",
      html: '<iframe src="https://baybakery.formstack.com/forms/?1234567-AbCdEf" title="Order form"></iframe>',
    },
    {
      name: "a form posting to formstack.com",
      kind: "form",
      html: '<form action="https://www.formstack.com/forms/index.php" method="post"><input type="hidden" name="form" value="1234567"></form>',
    },
  ],
  marketo: [
    {
      name: "the Forms 2.0 script",
      kind: "embed-script",
      html: '<script src="//app-ab12.marketo.com/js/forms2/js/forms2.min.js"></script>',
    },
    {
      name: "an inline MktoForms2.loadForm call",
      kind: "embed-script",
      html: '<script>MktoForms2.loadForm("//app-ab12.marketo.com", "123-ABC-456", 1001);</script>',
    },
  ],
  typeform: [
    {
      name: "an iframe on form.typeform.com",
      kind: "iframe",
      html: '<iframe src="https://form.typeform.com/to/AbC123" style="width:100%;height:500px"></iframe>',
    },
    {
      name: "the embed script",
      kind: "embed-script",
      html: '<div data-tf-live="AbC123"></div><script src="//embed.typeform.com/next/embed.js"></script>',
    },
  ],
};

describe("detectForms: the detector table", () => {
  for (const id of FORM_PROVIDER_IDS) {
    for (const row of TABLE[id]) {
      it(`${id}: ${row.name} matches only ${id}`, () => {
        const sightings = detectForms(snap(row.html));
        expect(sightings).toHaveLength(1);
        expect(sightings[0]?.provider).toBe(id);
        expect(sightings[0]?.kind).toBe(row.kind);
        // Each provider record, asked alone, finds it; every other record finds nothing.
        for (const p of PROVIDERS) {
          expect(p.detect(snap(row.html)).length).toBe(p.id === id ? 1 : 0);
        }
      });
    }
  }

  it("keeps the form's action, its hidden fields, and an iframe's or script's src", () => {
    const [form] = detectForms(snap(TABLE.pardot[0]!.html));
    expect(form).toMatchObject({
      action: "https://go.pardot.com/l/123456/2026-01-12/abcd",
      hiddenFields: ["utm_source"],
    });
    const [frame] = detectForms(snap(TABLE.typeform[0]!.html));
    expect(frame?.src).toBe("https://form.typeform.com/to/AbC123");
    const [script] = detectForms(snap(TABLE.hubspot[0]!.html));
    expect(script?.src).toBe("https://js.hsforms.net/forms/embed/v2.js");
    const [inline] = detectForms(snap(TABLE.hubspot[1]!.html));
    expect(inline?.src).toBeUndefined();
  });

  it("recognises a HubSpot form action and a HubSpot share iframe too", () => {
    const form = detectForms(
      snap(
        '<form action="https://forms.hsforms.com/submissions/v3/public/submit/formsnext"></form>',
      ),
    );
    expect(form.map((s) => [s.provider, s.kind])).toEqual([["hubspot", "form"]]);
    const frame = detectForms(snap('<iframe src="https://share.hsforms.com/1AbCdEfG"></iframe>'));
    expect(frame.map((s) => [s.provider, s.kind])).toEqual([["hubspot", "iframe"]]);
  });
});

// ---- unit: look-alikes that must not match -----------------------------------------------------------

describe("detectForms: look-alikes", () => {
  it("a blog post that mentions typeform and hubspot is not a sighting", () => {
    const s = snap(
      "<article><h1>Typeform vs HubSpot forms</h1><p>We moved our sign-up from Typeform to HubSpot. Pardot and Marketo came up too.</p></article>",
    );
    expect(detectForms(s)).toEqual([]);
    expect(formNotes(s)).toEqual([]);
  });

  it("a link to hubspot.com, typeform.com or pardot.com is not a sighting", () => {
    const s = snap(
      '<a href="https://www.hubspot.com/">HubSpot</a><a href="https://www.typeform.com/">Typeform</a><a href="https://www.pardot.com/">Pardot</a>',
    );
    expect(detectForms(s)).toEqual([]);
  });

  it("scripts, iframes and actions from similarly named hosts do not match", () => {
    const hosts = [
      "https://example-hubspot.com/forms/v2.js",
      "https://js.hsforms.net.example.com/forms/embed/v2.js",
      "https://hsforms.net.example.com/forms/v2.js",
      "https://notpardot.com/l/1/2/3",
      "https://pardot.com.example.com/l/1/2/3",
      "https://my-typeform.com/to/abc",
      "https://typeform.com.example.org/to/abc",
      "https://xformstack.com/forms/js.php/x",
      "https://marketo.com.example.net/js/forms2/js/forms2.min.js",
      `https://hsforms.com${"@"}elsewhere.example/forms/v2.js`,
    ];
    for (const h of hosts) {
      expect(detectForms(snap(`<script src="${h}"></script>`)), `script ${h}`).toEqual([]);
      expect(detectForms(snap(`<iframe src="${h}"></iframe>`)), `iframe ${h}`).toEqual([]);
      const form = detectForms(snap(`<form action="${h}"></form>`));
      expect(
        form.map((s) => s.provider),
        `form ${h}`,
      ).toEqual(["unknown"]);
    }
  });

  it("a provider's host alone is not enough where the path names the product", () => {
    // salesforce.com serves much more than Web-to-Lead; formstack.com and marketo.com serve other scripts.
    const s = snap(
      '<form action="https://webto.salesforce.com/servlet/servlet.WebToCase"></form><script src="https://www.formstack.com/analytics.js"></script><script src="https://app-ab12.marketo.com/other.js"></script><script src="https://js.hsforms.net/analytics.js"></script>',
    );
    expect(detectForms(s).map((x) => x.provider)).toEqual(["unknown"]);
  });

  it("a ld+json block or a template that quotes an embed call is not a script call", () => {
    const s = snap(
      '<script type="application/ld+json">{"description":"hbspt.forms.create({}) and MktoForms2.loadForm(1)"}</script><script type="text/template">hbspt.forms.create({})</script>',
    );
    expect(detectForms(s)).toEqual([]);
  });

  it("inline text that only names a provider is not an embed call", () => {
    expect(
      detectForms(snap("<script>var note = 'typeform and hubspot and MktoForms2';</script>")),
    ).toEqual([]);
  });
});

// ---- unit: unknown forms --------------------------------------------------------------------------------

describe("detectForms: a form with no recognised provider", () => {
  it("is returned as provider unknown, with its action and hidden fields", () => {
    const s = snap(
      '<form action="/api/contact" method="post"><input type="hidden" name="gclid"><input type="hidden" name="utm_medium"></form><form><input name="q"></form>',
    );
    const got = detectForms(s);
    expect(got.map((x) => [x.provider, x.kind])).toEqual([
      ["unknown", "form"],
      ["unknown", "form"],
    ]);
    expect(got[0]).toMatchObject({
      action: "https://tide-clinic.example/api/contact",
      hiddenFields: ["gclid", "utm_medium"],
    });
    expect(got[1]?.action).toBeUndefined();
  });
});

// ---- unit: position ---------------------------------------------------------------------------------------

describe("detectForms: position", () => {
  const html = `<html><body>
    <script src="/app.js"></script>
    <iframe src="https://form.typeform.com/to/AbC123"></iframe>
    <p>text</p>
    <form action="https://webto.salesforce.com/servlet/servlet.WebToLead?encoding=UTF-8"></form>
    <script>hbspt.forms.create({ portalId: "1" });</script>
    <iframe src="https://go.pardot.com/l/1/2/3"></iframe>
    </body></html>`;

  it("returns three or more sightings in document order, not provider order", () => {
    const got = detectForms(snap(html));
    expect(got.map((x) => x.provider)).toEqual([
      "typeform",
      "salesforce-web-to-lead",
      "hubspot",
      "pardot",
    ]);
    const positions = got.map((x) => x.position);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(new Set(positions).size).toBe(positions.length);
  });

  it("counts every form, iframe and script element, so a script's index matches the snapshot", () => {
    const s = snap(html);
    expect(detectForms(s).map((x) => x.position)).toEqual([1, 2, 3, 4]);
    expect(s.scriptTags?.map((t) => t.position)).toEqual([0, 3]);
    expect(s.iframes?.map((t) => t.position)).toEqual([1, 4]);
    expect(s.forms.map((f) => f.position)).toEqual([2]);
  });

  it("sorts a hand-built snapshot whose lists are out of order", () => {
    const s = bare({
      forms: [{ action: "https://go.pardot.com/l/1/2/3", hiddenFields: [], position: 9 }],
      iframes: [{ src: "https://form.typeform.com/to/x", position: 2 }],
      scriptTags: [{ src: "https://js.hsforms.net/forms/embed/v2.js", position: 5 }],
    });
    expect(detectForms(s).map((x) => [x.provider, x.position])).toEqual([
      ["typeform", 2],
      ["hubspot", 5],
      ["pardot", 9],
    ]);
  });
});

// ---- integration ------------------------------------------------------------------------------------------

describe("detectForms: a page with a Pardot iframe and a HubSpot embed script", () => {
  const page = `<!doctype html><html><head><title>Book a first visit</title>
    <script src="https://pi.pardot.com/pd.js"></script></head>
    <body><h1>Book a first visit</h1>
    <iframe src="https://go.pardot.com/l/483920/2026-02-03/xk2m" width="100%" height="520"></iframe>
    <script charset="utf-8" src="https://js.hsforms.net/forms/embed/v2.js"></script></body></html>`;

  it("finds two sightings of the right kinds, in order", () => {
    const got = detectForms(snap(page));
    expect(got.map((x) => [x.provider, x.kind])).toEqual([
      ["pardot", "iframe"],
      ["hubspot", "embed-script"],
    ]);
  });

  it("does not count the Pardot tracking script as a form", () => {
    expect(detectForms(snap(page)).filter((x) => x.src?.includes("pd.js"))).toEqual([]);
  });
});

// ---- edge cases -----------------------------------------------------------------------------------------

describe("detectForms: edge cases", () => {
  it("a Web-to-Lead action with an uppercase host and a trailing dot", () => {
    const action = "https://WEBTO.SALESFORCE.COM./servlet/servlet.WebToLead?encoding=UTF-8";
    const bareSnap = bare({ forms: [{ action, hiddenFields: ["oid"], position: 0 }] });
    expect(detectForms(bareSnap).map((x) => x.provider)).toEqual(["salesforce-web-to-lead"]);
    // The parser reaches the same answer from the HTML.
    const html = snap(`<form action="${action}"><input type="hidden" name="oid"></form>`);
    expect(detectForms(html).map((x) => x.provider)).toEqual(["salesforce-web-to-lead"]);
  });

  it("an uppercase servlet path still matches", () => {
    const s = snap('<form action="https://webto.salesforce.com/SERVLET/servlet.webtolead"></form>');
    expect(detectForms(s).map((x) => x.provider)).toEqual(["salesforce-web-to-lead"]);
  });

  it("an iframe with a protocol-relative src", () => {
    const html = snap('<iframe src="//go.pardot.com/l/1/2/3"></iframe>');
    expect(detectForms(html)).toMatchObject([{ provider: "pardot", kind: "iframe" }]);
    const raw = bare({ iframes: [{ src: "//go.pardot.com/l/1/2/3", position: 0 }] });
    expect(detectForms(raw)).toMatchObject([{ provider: "pardot", kind: "iframe" }]);
  });

  it("an iframe that loads lazily through data-src is still recognised", () => {
    const s = snap(
      '<iframe data-src="https://form.typeform.com/to/AbC123" loading="lazy"></iframe>',
    );
    expect(detectForms(s)).toMatchObject([{ provider: "typeform", kind: "iframe" }]);
  });

  it("a form injected by JavaScript: no form in the HTML, one note", () => {
    const s = snap(
      '<div id="enquiry"></div><script src="https://js.hsforms.net/forms/embed/v2.js"></script><script>hbspt.forms.create({ target: "#enquiry" });</script>',
    );
    // Both script elements are embed-script sightings; no form or iframe sighting exists.
    expect(detectForms(s).every((x) => x.kind === "embed-script")).toBe(true);
    expect(detectForms(s).some((x) => x.kind === "form" || x.kind === "iframe")).toBe(false);
    expect(formNotes(s)).toEqual([FORM_JS_NOTE]);
    expect(FORM_JS_NOTE).toBe("forms may be added by JavaScript");
  });

  it("no note when the embed script has its form or iframe in the HTML", () => {
    const s = snap(
      '<iframe src="https://form.typeform.com/to/AbC123"></iframe><script src="https://embed.typeform.com/next/embed.js"></script>',
    );
    expect(formNotes(s)).toEqual([]);
  });

  it("no note for a page with no embed script at all", () => {
    expect(formNotes(snap('<form action="/x"></form>'))).toEqual([]);
    expect(formNotes(snap("<p>hello</p>"))).toEqual([]);
  });

  it("the same HubSpot embed twice on one page: two sightings, not one", () => {
    const one = '<script src="https://js.hsforms.net/forms/embed/v2.js"></script>';
    const got = detectForms(snap(`${one}<p>between</p>${one}`));
    expect(got).toHaveLength(2);
    expect(got.map((x) => x.provider)).toEqual(["hubspot", "hubspot"]);
    expect(got[0]?.position).not.toBe(got[1]?.position);
  });

  it("two identical Pardot iframes are two sightings", () => {
    const frame = '<iframe src="https://go.pardot.com/l/1/2/3"></iframe>';
    expect(detectForms(snap(`${frame}${frame}`))).toHaveLength(2);
  });

  it("an empty page, an empty src and a missing snapshot list return nothing", () => {
    expect(detectForms(snap(""))).toEqual([]);
    expect(detectForms(snap('<script src=""></script><iframe src=""></iframe>'))).toEqual([]);
    const old = bare({});
    delete (old as { iframes?: unknown }).iframes;
    delete (old as { scriptTags?: unknown }).scriptTags;
    expect(detectForms(old)).toEqual([]);
  });

  it("reads a large inline script only up to the stored cap, never throwing", () => {
    const big = `<script>${"x".repeat(200_000)}</script>`;
    expect(detectForms(snap(big))).toEqual([]);
  });

  it("sends no requests: detection is a pure function of the snapshot", () => {
    const s = snap(TABLE.pardot[0]!.html);
    expect(detectForms(s)).toEqual(detectForms(s));
  });
});
