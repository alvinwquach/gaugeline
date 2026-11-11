import { describe, expect, it } from "vitest";
import { page } from "../../checks/__tests__/helpers.js";
import { collectsDetails, pathMeets, sensitiveReason } from "../sensitive.js";

const at = (path: string, over: Parameters<typeof page>[0] = {}) =>
  page({ finalUrl: `https://meadowlark.example${path}`, ...over });

const form = (over: Partial<ReturnType<typeof page>["forms"][number]> = {}) => ({
  hiddenFields: [],
  fieldNames: ["full_name"],
  position: 0,
  ...over,
});

describe("which pages count: unit", () => {
  it("a page with no form and no listed path does not count", () => {
    expect(sensitiveReason(at("/blog"))).toBeUndefined();
  });

  it("a page with a form counts, and says so", () => {
    expect(sensitiveReason(at("/intake", { forms: [form({ method: "post" })] }))).toBe(
      "a page with a form",
    );
  });

  it("a form that sends to another site names the host", () => {
    const p = at("/intake", {
      forms: [form({ method: "post", action: "https://intake.carelink-forms.example/submit" })],
    });
    expect(sensitiveReason(p)).toBe(
      "a page with a form that sends to intake.carelink-forms.example",
    );
  });

  it("a form to this site's own host, or to www of it, is not another site", () => {
    for (const action of [
      "https://meadowlark.example/api/intake",
      "https://www.meadowlark.example/x",
    ])
      expect(sensitiveReason(at("/intake", { forms: [form({ action })] }))).toBe(
        "a page with a form",
      );
  });

  it("a mailto action is not a host", () => {
    const p = at("/x", { forms: [form({ action: "mailto:?subject=intake" })] });
    expect(sensitiveReason(p)).toBe("a page with a form");
  });

  it("a search box is not a form that collects details", () => {
    expect(collectsDetails(form({ method: "get", fieldNames: ["q"] }))).toBe(false);
    expect(collectsDetails(form({ fieldNames: ["s"] }))).toBe(false);
    expect(
      collectsDetails(form({ method: "get", fieldNames: ["q", "token"], hiddenFields: ["token"] })),
    ).toBe(false);
    expect(
      sensitiveReason(at("/", { forms: [form({ method: "get", fieldNames: ["search"] })] })),
    ).toBeUndefined();
  });

  it("a newsletter form, a booking form and a POST form named q all count", () => {
    expect(collectsDetails(form({ method: "post", fieldNames: ["email"] }))).toBe(true);
    expect(collectsDetails(form({ method: "get", fieldNames: ["date", "time"] }))).toBe(true);
    expect(collectsDetails(form({ method: "post", fieldNames: ["q"] }))).toBe(true);
    expect(collectsDetails(form({ method: "get", fieldNames: [] }))).toBe(true);
  });

  it("an embedded form service counts when the HTML holds no form", () => {
    const p = at("/book", {
      iframes: [{ src: "https://form.typeform.com/to/abc123", position: 0 }],
    });
    expect(sensitiveReason(p)).toBe("a page with an embedded form (typeform)");
  });

  it("a listed path counts: exactly, or under a folder", () => {
    expect(sensitiveReason(at("/intake"), ["/intake"])).toBe(
      "a page listed in gaugeline.trackers.json (/intake)",
    );
    expect(sensitiveReason(at("/conditions/asthma"), ["/conditions/*"])).toBe(
      "a page listed in gaugeline.trackers.json (/conditions/*)",
    );
    expect(sensitiveReason(at("/intake/thanks"), ["/intake"])).toBeUndefined();
    expect(sensitiveReason(at("/conditions"), ["/conditions/*"])).toBeUndefined();
  });

  it("a form and a listed path give both reasons", () => {
    expect(sensitiveReason(at("/intake", { forms: [form()] }), ["/intake"])).toBe(
      "a page with a form, listed in gaugeline.trackers.json (/intake)",
    );
  });

  it("the query is not part of a path rule", () => {
    expect(pathMeets("/intake", "/intake")).toBe(true);
    expect(sensitiveReason(at("/intake?utm_source=x"), ["/intake"])).toBeDefined();
  });
});
