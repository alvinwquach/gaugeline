import { describe, expect, it } from "vitest";
import type { A11yRead } from "../../a11y/types.js";
import { addRenderedA11yChecks } from "../../a11y/registry.js";
import type { CheckContext } from "../../model.js";
import type { RenderRequest, RenderResult } from "../../render/types.js";
import { emptyBlocked } from "../../render/types.js";
import { createPageRegistry } from "../index.js";
import {
  A11Y_CHECKS,
  a11yContrast,
  a11yFocusOrder,
  a11yLandmarks,
  a11yNamesRoles,
  a11yReducedMotion,
} from "../a11y-rendered.js";
import { page } from "./helpers.js";

const HOME = "https://quillfeather.example/";

const base = (over: Partial<A11yRead> = {}): A11yRead => ({
  text: [],
  textOmitted: 0,
  focusables: [],
  unreachable: [],
  landmarks: [{ role: "main", name: "" }],
  motion: { animations: 0, endless: 0, reducedMotionRule: false, unreadableSheets: 0 },
  ...over,
});

const renderedWith = (a11y: A11yRead | undefined): RenderResult => ({
  kind: "rendered",
  finalUrl: HOME,
  status: 200,
  title: "Quillfeather" as never,
  requests: [],
  blocked: emptyBlocked(),
  totals: { requests: 1, bytes: 1 },
  truncated: [],
  ...(a11y ? { a11y } : {}),
});

function setup(result: RenderResult | undefined) {
  const asked: Pick<RenderRequest, "expose">[] = [];
  const notes: { url: string; reason: string }[] = [];
  const ctx: CheckContext = {
    warn: () => undefined,
    couldNotCheck: (url, reason) => void notes.push({ url, reason }),
    ...(result
      ? {
          render: (o = {}) => {
            asked.push({ expose: o.expose });
            return Promise.resolve(result);
          },
        }
      : {}),
  };
  return { ctx, notes, asked };
}
const home = () => page({ finalUrl: HOME });
const ink = (over: object) =>
  ({
    tag: "p",
    text: "Fresh bread",
    fg: [0, 0, 0, 1],
    bg: [255, 255, 255],
    px: 16,
    bold: false,
    ...over,
  }) as never;
const link = (over: object) =>
  ({ tag: "a", role: "link", name: "Home", tabindex: null, x: 0, y: 0, ...over }) as never;

describe("the rendered accessibility checks: shape", () => {
  it("are five, in the registry only when a run renders", () => {
    expect(A11Y_CHECKS.map((c) => [c.id, c.severity])).toEqual([
      ["a11y-contrast", "medium"],
      ["a11y-focus-order", "medium"],
      ["a11y-landmarks", "medium"],
      ["a11y-names-roles", "medium"],
      ["a11y-reduced-motion", "medium"],
    ]);
    for (const c of A11Y_CHECKS) expect(c.what && c.why && c.fix && c.tech, c.id).toBeTruthy();
    const reg = createPageRegistry();
    for (const c of A11Y_CHECKS) expect(reg.has(c.id), c.id).toBe(false);
    addRenderedA11yChecks(reg);
    addRenderedA11yChecks(reg);
    for (const c of A11Y_CHECKS) expect(reg.has(c.id), c.id).toBe(true);
    expect(reg.all().filter((c) => c.id.startsWith("a11y-"))).toHaveLength(5);
  });

  it("all ask the renderer for the same thing, so one render serves them all", async () => {
    const s = setup(renderedWith(base()));
    for (const c of A11Y_CHECKS) await c.run(home(), s.ctx);
    expect(new Set(s.asked.map((a) => JSON.stringify(a))).size).toBe(1);
    expect(s.asked[0]?.expose).toEqual({ a11y: true, text: false, links: false });
  });

  it("say could not check, never a pass, when there is no renderer, no render or no accessibility facts", async () => {
    for (const result of [
      undefined,
      {
        kind: "could-not-check",
        reason: "the page took longer than the time cap allows",
      } as RenderResult,
      renderedWith(undefined),
    ]) {
      for (const c of A11Y_CHECKS) {
        const s = setup(result);
        expect(await c.run(home(), s.ctx), c.id).toEqual([]);
        expect(s.notes, c.id).toHaveLength(1);
        expect(s.notes[0]?.url).toBe(HOME);
      }
    }
  });
});

describe("a11y-contrast", () => {
  it("reports text under 4.5 to 1, grouped, with the ratio and the colours", async () => {
    const s = setup(
      renderedWith(
        base({
          text: [
            ink({ text: "One", fg: [200, 200, 200, 1] }),
            ink({ text: "Two", fg: [200, 200, 200, 1] }),
            ink({ text: "Fine" }),
          ],
        }),
      ),
    );
    const out = await a11yContrast.run(home(), s.ctx);
    expect(out).toEqual([
      {
        checkId: "a11y-contrast",
        severity: "medium",
        title: a11yContrast.title,
        evidence:
          '2 text elements fall short of WCAG contrast: "One", "Two" at 1.67:1 (needs 4.5:1, #c8c8c8 on #ffffff)',
        url: HOME,
      },
    ]);
  });

  it("is quiet when every text passes, and says text on an image was not computed", async () => {
    const s = setup(renderedWith(base({ text: [ink({}), ink({ bg: null }), ink({ bg: null })] })));
    expect(await a11yContrast.run(home(), s.ctx)).toEqual([]);
    expect(s.notes).toEqual([
      { url: HOME, reason: expect.stringContaining("2 text elements sit on an image or gradient") },
    ]);
  });

  it("says when the page had more text than was sampled", async () => {
    const s = setup(renderedWith(base({ text: [ink({})], textOmitted: 40 })));
    await a11yContrast.run(home(), s.ctx);
    expect(s.notes[0]?.reason).toContain("40 more text elements were not sampled");
  });

  it("lists the three worst groups and counts the rest", async () => {
    const greys = [190, 195, 200, 205, 210].map((g) => ink({ text: `T${g}`, fg: [g, g, g, 1] }));
    const s = setup(renderedWith(base({ text: greys })));
    const out = await a11yContrast.run(home(), s.ctx);
    expect(out[0]?.evidence).toContain("5 text elements fall short");
    expect(out[0]?.evidence).toContain("and 2 more groups");
  });
});

describe("a11y-focus-order", () => {
  it("reports a positive tabindex, naming where", async () => {
    const s = setup(
      renderedWith(base({ focusables: [link({ tabindex: 2, name: "Order" }), link({ y: 50 })] })),
    );
    const out = await a11yFocusOrder.run(home(), s.ctx);
    expect(out.map((f) => [f.severity, f.evidence])).toEqual([
      ["medium", 'Positive tabindex values reorder keyboard focus: tabindex 2 on "Order".'],
    ]);
  });

  it("reports focus that jumps back up the page twice or more, as low", async () => {
    const f = [
      link({ y: 100, name: "A" }),
      link({ y: 600, name: "B" }),
      link({ y: 50, name: "C" }),
      link({ y: 700, name: "D" }),
      link({ y: 100, name: "E" }),
    ];
    const s = setup(renderedWith(base({ focusables: f })));
    const out = await a11yFocusOrder.run(home(), s.ctx);
    expect(out.map((x) => [x.severity, x.evidence])).toEqual([
      ["low", 'Keyboard focus jumps back up the page 2 times: from "B" to "C", from "D" to "E".'],
    ]);
  });

  it("leaves a single jump alone, since a skip link or a sticky bar is one", async () => {
    const s = setup(renderedWith(base({ focusables: [link({ y: 600 }), link({ y: 10 })] })));
    expect(await a11yFocusOrder.run(home(), s.ctx)).toEqual([]);
  });
});

describe("a11y-names-roles", () => {
  it("reports controls with no accessible name", async () => {
    const s = setup(
      renderedWith(
        base({
          focusables: [
            link({ tag: "button", role: "button", name: "" }),
            link({ tag: "input", role: "textbox", name: "" }),
            link({}),
          ],
        }),
      ),
    );
    const out = await a11yNamesRoles.run(home(), s.ctx);
    expect(out.map((f) => f.evidence)).toEqual([
      "2 controls the keyboard reaches have no accessible name: <button>, <input>.",
    ]);
  });

  it("reports elements with a widget role that the keyboard cannot reach", async () => {
    const s = setup(
      renderedWith(base({ unreachable: [{ tag: "div", role: "button", name: "Buy" }] })),
    );
    const out = await a11yNamesRoles.run(home(), s.ctx);
    expect(out.map((f) => f.evidence)).toEqual([
      'An element with the role button cannot be reached with the keyboard: <div> "Buy".',
    ]);
  });

  it("is quiet when every control has a name and every widget can be reached", async () => {
    const s = setup(renderedWith(base({ focusables: [link({})] })));
    expect(await a11yNamesRoles.run(home(), s.ctx)).toEqual([]);
  });
});

describe("a11y-landmarks", () => {
  it("reports a page with no main landmark", async () => {
    const s = setup(renderedWith(base({ landmarks: [{ role: "navigation", name: "" }] })));
    const out = await a11yLandmarks.run(home(), s.ctx);
    expect(out.map((f) => [f.severity, f.evidence])).toEqual([
      [
        "medium",
        "The page has no main landmark (a main element), so a screen reader user cannot jump to its content.",
      ],
    ]);
  });

  it("reports two mains, and several landmarks of one role that nothing tells apart, as low", async () => {
    const s = setup(
      renderedWith(
        base({
          landmarks: [
            { role: "main", name: "" },
            { role: "main", name: "" },
            { role: "navigation", name: "" },
            { role: "navigation", name: "" },
          ],
        }),
      ),
    );
    const out = await a11yLandmarks.run(home(), s.ctx);
    expect(out.map((f) => [f.severity, f.evidence])).toEqual([
      [
        "low",
        "The page has 2 main landmarks; it should have one. 2 navigation landmarks have no names to tell them apart (give each an aria-label).",
      ],
    ]);
  });

  it("is quiet for a well-formed page", async () => {
    const s = setup(
      renderedWith(
        base({
          landmarks: [
            { role: "banner", name: "" },
            { role: "main", name: "" },
            { role: "contentinfo", name: "" },
          ],
        }),
      ),
    );
    expect(await a11yLandmarks.run(home(), s.ctx)).toEqual([]);
  });
});

describe("a11y-reduced-motion", () => {
  const motion = (over: object) =>
    base({
      motion: { animations: 0, endless: 0, reducedMotionRule: false, unreadableSheets: 0, ...over },
    });

  it("reports motion with no prefers-reduced-motion rule: medium when some never ends, low otherwise", async () => {
    const a = setup(renderedWith(motion({ animations: 3, endless: 1 })));
    expect(
      (await a11yReducedMotion.run(home(), a.ctx)).map((f) => [f.severity, f.evidence]),
    ).toEqual([
      [
        "medium",
        "3 animations run on the page (1 never ends) and no prefers-reduced-motion rule was found in its stylesheets.",
      ],
    ]);
    const b = setup(renderedWith(motion({ animations: 1 })));
    expect((await a11yReducedMotion.run(home(), b.ctx))[0]?.severity).toBe("low");
  });

  it("is quiet for a still page and for motion with a rule", async () => {
    for (const m of [motion({}), motion({ animations: 4, endless: 2, reducedMotionRule: true })])
      expect(await a11yReducedMotion.run(home(), setup(renderedWith(m)).ctx)).toEqual([]);
  });

  it("is could-not-check when a stylesheet from another origin could not be read", async () => {
    const s = setup(renderedWith(motion({ animations: 2, unreadableSheets: 1 })));
    expect(await a11yReducedMotion.run(home(), s.ctx)).toEqual([]);
    expect(s.notes[0]?.reason).toContain("1 stylesheet from another origin could not be read");
  });
});
