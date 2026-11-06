import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SITES_DIR, startFixture } from "../../../../fixtures/src/index.js";
import { ConfigError } from "../../errors.js";
import { createFetcher } from "../../fetcher.js";
import type { CheckContext } from "../../model.js";
import { checkSite } from "../../site.js";
import { buildSnapshot } from "../../snapshot.js";
import {
  analyseTags,
  compare,
  distance,
  duplicateTags,
  formatTagSummary,
  nearest,
  summarise,
} from "../../tags/analyse.js";
import {
  ALL_PAGES_TRIGGER_ID,
  readCondition,
  readContainer,
  type TagCondition,
} from "../../tags/read-container.js";
import { tagsDeadRules } from "../tags-dead-rules.js";
import { tagsDuplicate } from "../tags-duplicate.js";

const TAGS = ["tags-dead-rules", "tags-duplicate"];

/** A condition as Tag Manager exports it. */
function raw(type: string, variable: string, value: string, flags: Record<string, boolean> = {}) {
  return {
    type,
    parameter: [
      { type: "TEMPLATE", key: "arg0", value: `{{${variable}}}` },
      { type: "TEMPLATE", key: "arg1", value },
      ...Object.entries(flags).map(([key, v]) => ({ type: "BOOLEAN", key, value: String(v) })),
    ],
  };
}

function cond(type: string, variable: string, value: string, flags = {}): TagCondition {
  const c = readCondition(raw(type, variable, value, flags));
  if ("unreadable" in c) throw new Error(c.unreadable);
  return c;
}

function exportOf(triggers: unknown[], tags: unknown[] = []) {
  return {
    exportFormatVersion: 2,
    containerVersion: { container: { publicId: "GTM-UNIT" }, trigger: triggers, tag: tags },
  };
}

const page = (url: string, body: string) =>
  buildSnapshot([{ url, status: 200, headers: { "content-type": "text/html" }, body, ms: 1 }]);

const HOME = page(
  "https://books.example/",
  `<html><body><nav><a href="/events">Readings</a> <a href="/contact">Contact</a></nav>
   <a href="/files/catalogue.pdf" id="dl" class="btn download">Catalogue</a>
   <form id="newsletter-signup" class="signup" action="/subscribe"><button>Join</button></form>
   </body></html>`,
);

function ctxOf(input: Parameters<typeof readContainer>[0], pages = [HOME], known: string[] = []) {
  const container = readContainer(input);
  const unchecked: string[] = [];
  const ctx: CheckContext = {
    warn: () => undefined,
    tagContainer: container,
    tagRules: async () => analyseTags({ container, pages, known }),
    couldNotCheck: (_url, reason) => unchecked.push(reason),
  };
  return { ctx, unchecked };
}

describe("tag rules: unit (reading each condition type)", () => {
  it("reads equals, contains, starts with, ends with, RegEx and CSS conditions", () => {
    expect(cond("EQUALS", "Form ID", "contact-form")).toMatchObject({
      subject: "form-id",
      operator: "equals",
      value: "contact-form",
      negate: false,
      text: '{{Form ID}} equals "contact-form"',
    });
    expect(cond("CONTAINS", "Click URL", "/wp-content/").operator).toBe("contains");
    expect(cond("STARTS_WITH", "Page Path", "/events").subject).toBe("page-path");
    expect(cond("ENDS_WITH", "Page URL", ".pdf").operator).toBe("ends-with");
    expect(cond("MATCH_REGEX", "Click URL", "\\.pdf$", { ignore_case: true })).toMatchObject({
      operator: "regex",
      ignoreCase: true,
    });
    expect(cond("CSS_SELECTOR", "Click Element", "a.download").operator).toBe("css");
    expect(cond("EQUALS", "Click Text", "Renew", { negate: true }).text).toBe(
      '{{Click Text}} does not equal "Renew"',
    );
  });

  it("each operator compares as Tag Manager does, negate and ignore case included", () => {
    expect(compare(cond("EQUALS", "Page Path", "/a"), "/a")).toBe(true);
    expect(compare(cond("CONTAINS", "Page Path", "wp-"), "/wp-content/x")).toBe(true);
    expect(compare(cond("STARTS_WITH", "Page Path", "/ev"), "/events")).toBe(true);
    expect(compare(cond("ENDS_WITH", "Page Path", ".pdf"), "/x.PDF")).toBe(false);
    expect(compare(cond("ENDS_WITH", "Page Path", ".pdf", { ignore_case: true }), "/x.PDF")).toBe(
      true,
    );
    expect(compare(cond("MATCH_REGEX", "Page Path", "^/(en|es)/"), "/es/menu")).toBe(true);
    expect(compare(cond("CONTAINS", "Page Path", "/admin", { negate: true }), "/menu")).toBe(true);
  });

  it("a variable, comparison or trigger type it doesn't read is unreadable, never guessed", () => {
    expect(readCondition(raw("EQUALS", "DLV - plan", "pro"))).toEqual({
      unreadable: "a condition reads {{DLV - plan}}, a variable this doesn't read",
    });
    expect(readCondition(raw("GREATER", "Page Path", "3"))).toEqual({
      unreadable: "{{Page Path}} uses the GREATER comparison, which this doesn't read",
    });
    const c = readContainer(exportOf([{ triggerId: "9", name: "Timer", type: "TIMER" }]));
    expect(c.triggers[0]).toMatchObject({ unreadable: "TIMER triggers are not read" });
  });

  it("the built-in All Pages trigger is added when a tag uses it", () => {
    const c = readContainer(
      exportOf(
        [],
        [
          {
            tagId: "1",
            name: "Google tag",
            type: "googtag",
            firingTriggerId: [ALL_PAGES_TRIGGER_ID],
          },
        ],
      ),
    );
    expect(c.triggers).toEqual([
      {
        id: ALL_PAGES_TRIGGER_ID,
        name: "All Pages",
        type: "PAGEVIEW",
        kind: "page-view",
        conditions: [],
      },
    ]);
    expect(analyseTags({ container: c, pages: [HOME] }).verdicts[0]?.state).toBe("can-fire");
  });

  it("a file that isn't a container export is a ConfigError", () => {
    expect(() => readContainer({ hello: "world" }, "gtm.json")).toThrow(ConfigError);
    expect(() => readContainer({ hello: "world" }, "gtm.json")).toThrow(
      /^gtm\.json is not a Tag Manager container export: containerVersion:/,
    );
  });

  it("nearest is the smallest edit distance, ties broken alphabetically", () => {
    expect(distance("contact-form", "contact-form-2024")).toBe(5);
    expect(nearest("contact-form", ["newsletter-signup", "contact-form-2024"])).toBe(
      "contact-form-2024",
    );
    expect(nearest("ab", ["ac", "aa"])).toBe("aa");
    expect(nearest("x", [])).toBeUndefined();
  });

  it("duplicates: same event and destination on a shared trigger; paused tags left out", () => {
    const ga4 = (id: string, name: string, event: string, to: string, paused = false) => ({
      tagId: id,
      name,
      type: "gaawe",
      firingTriggerId: ["5"],
      ...(paused ? { paused: true } : {}),
      parameter: [
        { type: "TEMPLATE", key: "eventName", value: event },
        { type: "TEMPLATE", key: "measurementIdOverride", value: to },
      ],
    });
    const c = readContainer(
      exportOf(
        [{ triggerId: "5", name: "Form", type: "FORM_SUBMISSION" }],
        [
          ga4("1", "A", "generate_lead", "G-1"),
          ga4("2", "B", "generate_lead", "G-1"),
          ga4("3", "C", "generate_lead", "G-2"),
          ga4("4", "D", "generate_lead", "G-1", true),
        ],
      ),
    );
    expect(duplicateTags(c).map((d) => [d.trigger.name, d.tags, d.label])).toEqual([
      ["Form", ["A", "B"], "generate_lead to G-1"],
    ]);
  });
});

describe("tag rules: integration (the tag-rules fixture and its container export)", () => {
  it("finds the /wp-content/ download trigger and the removed form id, and counts the rest", async () => {
    const site = await startFixture("tag-rules");
    try {
      const tags = readContainer(
        JSON.parse(readFileSync(`${SITES_DIR}../gtm/harbour-books.json`, "utf8")),
      );
      const { result, tags: summary } = await checkSite({
        address: site.origin,
        fetcher: createFetcher({ allowPrivate: true }),
        only: TAGS,
        tags,
      });
      expect(result.findings.map((f) => [f.checkId, f.evidence])).toEqual([
        [
          "tags-dead-rules",
          'Trigger "PDF downloads (old)" (link click): {{Click URL}} contains "/wp-content/uploads/" matches no link on the 3 pages read; nearest that exists: /files/catalogue.pdf',
        ],
        [
          "tags-dead-rules",
          'Trigger "Contact form sent" (form submission): {{Form ID}} equals "contact-form" matches no form on the 3 pages read; nearest that exists: contact-form-2024',
        ],
        [
          "tags-duplicate",
          '"GA4 - generate_lead" and "GA4 - generate_lead (copy)" both send generate_lead to G-TEST0001 on trigger "Newsletter"',
        ],
      ]);
      expect(result.couldNotCheck.map((c) => [c.id, c.reason])).toEqual([
        [
          "tags-dead-rules",
          'trigger "Members renew": it fires only on pages this run did not read (/members/renew)',
        ],
        ["tags-dead-rules", 'trigger "Scroll depth": SCROLL_DEPTH triggers are not read'],
      ]);
      expect(summary).toEqual({
        publicId: "GTM-TEST01",
        triggers: 8,
        canFire: 4,
        dead: 2,
        unchecked: 2,
      });
      expect(formatTagSummary(summary!)).toBe(
        "Tag rules: read 8 triggers from GTM-TEST01; 4 can fire, 2 cannot, 2 could not be checked.",
      );
      // Read-only: GET and HEAD only, and nothing was ever submitted to a form.
      expect([...site.methods.keys()].every((m) => m === "GET" || m === "HEAD")).toBe(true);
      expect(site.hits.get("/subscribe") ?? 0).toBe(0);
    } finally {
      await site.close();
    }
  });

  it("without gaugeline.tags.json the checks find nothing and no summary is made", async () => {
    const site = await startFixture("tag-rules");
    try {
      const { result, tags } = await checkSite({
        address: site.origin,
        fetcher: createFetcher({ allowPrivate: true }),
        only: TAGS,
      });
      expect(result.findings).toEqual([]);
      expect(result.passed).toEqual(TAGS);
      expect(tags).toBeUndefined();
    } finally {
      await site.close();
    }
  });
});

describe("tag rules: edge cases", () => {
  it("a regular-expression condition: a match can fire, no match is dead, a bad pattern is unchecked", async () => {
    const { ctx, unchecked } = ctxOf(
      exportOf([
        {
          triggerId: "1",
          name: "PDFs",
          type: "LINK_CLICK",
          filter: [raw("MATCH_REGEX", "Click URL", "\\.PDF$", { ignore_case: true })],
        },
        {
          triggerId: "2",
          name: "Zips",
          type: "LINK_CLICK",
          filter: [raw("MATCH_REGEX", "Click URL", "\\.zip$")],
        },
        {
          triggerId: "3",
          name: "Broken",
          type: "LINK_CLICK",
          filter: [raw("MATCH_REGEX", "Click URL", "(")],
        },
      ]),
    );
    const found = await tagsDeadRules.run(HOME, ctx);
    expect(found.map((f) => f.evidence)).toEqual([
      'Trigger "Zips" (link click): {{Click URL}} matches RegEx "\\.zip$" matches no link on the 1 page read; nearest that exists: /files/catalogue.pdf',
    ]);
    expect(unchecked).toEqual([
      'trigger "Broken": {{Click URL}} matches RegEx "(", which is not a valid expression',
    ]);
  });

  it("a trigger limited to pages not included in the run is unchecked, not dead", async () => {
    const { ctx, unchecked } = ctxOf(
      exportOf([
        {
          triggerId: "1",
          name: "Shop buttons",
          type: "CLICK",
          autoEventFilter: [raw("STARTS_WITH", "Page Path", "/shop/")],
          filter: [raw("CSS_SELECTOR", "Click Element", "button.add-to-cart")],
        },
      ]),
      [HOME],
      ["https://books.example/shop/novels"],
    );
    expect(await tagsDeadRules.run(HOME, ctx)).toEqual([]);
    expect(unchecked).toEqual([
      'trigger "Shop buttons": it fires only on pages this run did not read (/shop/novels)',
    ]);
  });

  it("a page condition no known address meets is dead, with the nearest page", async () => {
    const { ctx } = ctxOf(
      exportOf([
        {
          triggerId: "1",
          name: "Old blog",
          type: "PAGEVIEW",
          filter: [raw("STARTS_WITH", "Page Path", "/blog/")],
        },
        {
          triggerId: "2",
          name: "Not admin",
          type: "PAGEVIEW",
          filter: [raw("CONTAINS", "Page Path", "/admin", { negate: true })],
        },
      ]),
    );
    expect((await tagsDeadRules.run(HOME, ctx)).map((f) => f.evidence)).toEqual([
      'Trigger "Old blog" (page view): {{Page Path}} starts with "/blog/" matches no page on the site (4 addresses known); nearest that exists: /',
    ]);
  });

  it("CSS selectors on click and form elements; an unreadable selector is unchecked", async () => {
    const { ctx, unchecked } = ctxOf(
      exportOf([
        {
          triggerId: "1",
          name: "Download button",
          type: "CLICK",
          filter: [raw("CSS_SELECTOR", "Click Element", "a.download")],
        },
        {
          triggerId: "2",
          name: "Old button",
          type: "CLICK",
          filter: [raw("CSS_SELECTOR", "Click Element", "#download")],
        },
        {
          triggerId: "3",
          name: "Signup",
          type: "FORM_SUBMISSION",
          filter: [raw("CSS_SELECTOR", "Form Element", "form.signup")],
        },
        {
          triggerId: "4",
          name: "Weird",
          type: "CLICK",
          filter: [raw("CSS_SELECTOR", "Click Element", "a[[")],
        },
      ]),
    );
    expect((await tagsDeadRules.run(HOME, ctx)).map((f) => f.evidence)).toEqual([
      'Trigger "Old button" (click): {{Click Element}} matches CSS selector "#download" matches no element on the 1 page read; nearest that exists: #dl',
    ]);
    expect(unchecked).toEqual(['trigger "Weird": "a[[" is not a CSS selector this can read']);
  });

  it("conditions each met by different elements, never by one, is dead", async () => {
    const { ctx } = ctxOf(
      exportOf([
        {
          triggerId: "1",
          name: "Catalogue in nav",
          type: "LINK_CLICK",
          filter: [raw("CONTAINS", "Click URL", ".pdf"), raw("EQUALS", "Click Text", "Readings")],
        },
      ]),
    );
    expect((await tagsDeadRules.run(HOME, ctx)).map((f) => f.evidence)).toEqual([
      'Trigger "Catalogue in nav" (link click): {{Click URL}} contains ".pdf" and {{Click Text}} equals "Readings" matches no single link meets every condition on the 1 page read',
    ]);
  });

  it("custom events need the site's scripts to run, so they are unchecked", async () => {
    const { ctx, unchecked } = ctxOf(
      exportOf([
        {
          triggerId: "1",
          name: "Purchase",
          type: "CUSTOM_EVENT",
          customEventFilter: [raw("EQUALS", "_event", "purchase")],
        },
      ]),
    );
    expect(await tagsDeadRules.run(HOME, ctx)).toEqual([]);
    expect(unchecked).toEqual([
      "trigger \"Purchase\": custom events are pushed by the site's own scripts, which a read without JavaScript doesn't run",
    ]);
  });

  it("the same input gives the same findings, run after run", async () => {
    const input = exportOf([
      {
        triggerId: "1",
        name: "Old form",
        type: "FORM_SUBMISSION",
        filter: [raw("EQUALS", "Form ID", "signup")],
      },
    ]);
    const a = await tagsDeadRules.run(HOME, ctxOf(input).ctx);
    const b = await tagsDeadRules.run(HOME, ctxOf(input).ctx);
    expect(a).toEqual(b);
    expect(summarise(analyseTags({ container: readContainer(input), pages: [HOME] }))).toEqual({
      publicId: "GTM-UNIT",
      triggers: 1,
      canFire: 0,
      dead: 1,
      unchecked: 0,
    });
  });

  it("three tags sending the same event are one finding", async () => {
    const tag = (id: string) => ({
      tagId: id,
      name: `HTML ${id}`,
      type: "html",
      firingTriggerId: ["1"],
      parameter: [{ type: "TEMPLATE", key: "html", value: "<script>track()</script>" }],
    });
    const { ctx } = ctxOf(
      exportOf([{ triggerId: "1", name: "Clicks", type: "CLICK" }], [tag("1"), tag("2"), tag("3")]),
    );
    expect((await tagsDuplicate.run(HOME, ctx)).map((f) => f.evidence)).toEqual([
      '"HTML 1" and "HTML 2" and "HTML 3" all send the same html tag on trigger "Clicks"',
    ]);
  });
});
