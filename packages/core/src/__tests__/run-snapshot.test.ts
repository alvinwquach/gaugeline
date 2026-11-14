import { describe, expect, it } from "vitest";
import { formChanged, parseMinorUnits, providerFor } from "../run-snapshot.js";
import { buildRunSnapshot, diffSnapshots, type RunSnapshot } from "../run-snapshot.js";
import { buildSnapshot } from "../snapshot.js";
import { formDestinationChanged } from "../checks/form-destination-changed.js";
import { formProviderChanged } from "../checks/form-provider-changed.js";
import { priceChanged } from "../checks/price-changed.js";

const TAKEN = "2026-11-05T20:00:00.000Z";
const snap = (prices: RunSnapshot["prices"], forms: RunSnapshot["forms"] = {}): RunSnapshot => ({
  schema: 1,
  url: "https://pop.example/",
  takenAt: TAKEN,
  prices,
  forms,
});

function page(body: string) {
  return buildSnapshot([
    {
      url: "https://pop.example/",
      status: 200,
      headers: { "content-type": "text/html" },
      body,
      ms: 1,
    },
  ]);
}
const ld = (o: unknown) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;

describe("run snapshot: unit", () => {
  it("diffSnapshots table: price up, price down, product added (no finding), product removed (no finding)", () => {
    const prev = snap({ "TAMAL-BOX USD": 1200, "ATOLE USD": 300, "OLD USD": 500 });
    const next = snap({ "TAMAL-BOX USD": 1400, "ATOLE USD": 250, "NEW USD": 900 });
    expect(diffSnapshots(prev, next).map((d) => [d.checkId, d.evidence])).toEqual([
      ["price-changed", "TAMAL-BOX: 12.00 USD last run, 14.00 USD now"],
      ["price-changed", "ATOLE: 3.00 USD last run, 2.50 USD now"],
    ]);
  });

  it("a provider change HubSpot -> Formstack is one high finding, and the destination is not also reported", () => {
    const prev = snap({}, { "#signup": { provider: "HubSpot", actionHost: "forms.hsforms.com" } });
    const next = snap(
      {},
      { "#signup": { provider: "Formstack", actionHost: "acme.formstack.com" } },
    );
    expect(diffSnapshots(prev, next).map((d) => [d.checkId, d.severity, d.evidence])).toEqual([
      [
        "form-provider-changed",
        "high",
        "#signup posts to Formstack (acme.formstack.com) now; last run it was HubSpot (forms.hsforms.com)",
      ],
    ]);
    const moved = snap({}, { "#signup": { provider: "HubSpot", actionHost: "api.hsforms.com" } });
    expect(diffSnapshots(prev, moved).map((d) => [d.checkId, d.severity])).toEqual([
      ["form-destination-changed", "medium"],
    ]);
    expect(formChanged).toBeTypeOf("function");
  });

  it("buildRunSnapshot is deterministic: the same HTML twice gives deep-equal output", () => {
    const html = `${ld({ "@type": "Product", sku: "BOX", offers: { price: "48.00", priceCurrency: "USD" } })}<form id="signup" action="https://forms.hsforms.com/submissions/v3/x"><input name="email"></form>`;
    const a = buildRunSnapshot(page(html), () => new Date(TAKEN));
    const b = buildRunSnapshot(page(html), () => new Date(TAKEN));
    expect(a).toEqual(b);
    expect(a).toEqual({
      schema: 1,
      url: "https://pop.example/",
      takenAt: TAKEN,
      prices: { "BOX USD": 4800 },
      forms: { "#signup": { provider: "HubSpot", actionHost: "forms.hsforms.com" } },
      // The header and footer menus (nav-changed): this page has none.
      nav: [],
      // Third-party scripts and security headers (script-changed and the header checks): none here.
      baseline: { scripts: {}, headers: {} },
    });
  });

  it('prices parse "48.00" USD to 4800; "1.234,50" style strings are rejected, not guessed', () => {
    expect(parseMinorUnits("48.00")).toBe(4800);
    expect(parseMinorUnits(48)).toBe(4800);
    expect(parseMinorUnits("48.5")).toBe(4850);
    for (const bad of ["1.234,50", "48,00", "$48", "about 48", "48.005", ""])
      expect(parseMinorUnits(bad), bad).toBeUndefined();
  });

  it("form keys: id, else name, else position; providers from a frozen table, else unknown", () => {
    const s = buildRunSnapshot(
      page(
        '<form name="newsletter" action="https://app.kit.com/forms/1/subscriptions"></form><form action="/contact"></form><form id="x" action="https://hooks.example/y"></form>',
      ),
      () => new Date(TAKEN),
    );
    expect(s.forms).toEqual({
      "name:newsletter": { provider: "Kit", actionHost: "app.kit.com" },
      "form 2": { provider: "unknown", actionHost: "pop.example" },
      "#x": { provider: "unknown", actionHost: "hooks.example" },
    });
    expect(providerFor("go.pardot.com")).toBe("Pardot");
    expect(providerFor("hsforms.com.evil.example")).toBe("unknown");
  });

  it("the checks report what diffSnapshots produced, only with a previous run in the context", async () => {
    const p = page(
      ld({ "@type": "Product", sku: "BOX", offers: { price: "14.00", priceCurrency: "USD" } }),
    );
    const previous = snap({ "BOX USD": 1200 });
    expect(await priceChanged.run(p, { warn: () => undefined })).toEqual([]);
    const out = await priceChanged.run(p, {
      warn: () => undefined,
      previous,
      now: () => new Date(TAKEN),
    });
    expect(out.map((f) => f.evidence)).toEqual(["BOX: 12.00 USD last run, 14.00 USD now"]);
    expect(await formProviderChanged.run(p, { warn: () => undefined, previous })).toEqual([]);
    expect(await formDestinationChanged.run(p, { warn: () => undefined, previous })).toEqual([]);
  });

  it("two forms with no id or name that swap position look like a change (a known false change)", () => {
    const prev = snap(
      {},
      {
        "form 1": { provider: "HubSpot", actionHost: "forms.hsforms.com" },
        "form 2": { provider: "Kit", actionHost: "app.kit.com" },
      },
    );
    const next = snap(
      {},
      {
        "form 1": { provider: "Kit", actionHost: "app.kit.com" },
        "form 2": { provider: "HubSpot", actionHost: "forms.hsforms.com" },
      },
    );
    expect(diffSnapshots(prev, next).map((d) => d.checkId)).toEqual([
      "form-provider-changed",
      "form-provider-changed",
    ]);
  });
});
