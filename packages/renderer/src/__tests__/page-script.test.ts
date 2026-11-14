import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { OBSERVER_SCRIPT, REFUSED_BINDING } from "../page-script.js";

/**
 * The click guard that runs in the page, run here against a small stand-in for the page, so what it stops is
 * tested without a browser: a click must land on a link to a web address, not in a form, and not on or in
 * anything that acts.
 */

interface Fake {
  /** What closest(selector) returns for the clicked node. */
  link?: { protocol: string; origin: string; closest: (s: string) => unknown } | null;
  acts?: boolean;
}

function click(f: Fake) {
  let handler: ((e: unknown) => void) | undefined;
  const refused = vi.fn();
  const window: Record<string, unknown> = {
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      if (type === "click") handler = fn;
    },
    [REFUSED_BINDING]: refused,
  };
  runInNewContext(OBSERVER_SCRIPT, { window, location: { origin: "https://site.example" } });
  const event = {
    target: {
      closest: (selector: string) =>
        selector === "a[href]" ? (f.link ?? null) : f.acts ? {} : null,
    },
    preventDefault: vi.fn(),
    stopImmediatePropagation: vi.fn(),
  };
  handler?.(event);
  return { event, refused };
}

const link = (over: Partial<NonNullable<Fake["link"]>> = {}) => ({
  protocol: "https:",
  origin: "https://site.example",
  closest: () => null,
  ...over,
});

describe("the click guard in the page", () => {
  it("lets a click on a link to a page on this site through, untouched", () => {
    const { event, refused } = click({ link: link() });
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
    expect(refused).not.toHaveBeenCalled();
  });

  it("cancels the move of a link to another site, and lets the page's own handlers run", () => {
    const { event, refused } = click({ link: link({ origin: "https://other.example" }) });
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
    expect(refused).not.toHaveBeenCalled();
  });

  it.each([
    ["not on a link", { link: null }],
    ["a link in a form", { link: link({ closest: (s: string) => (s === "form" ? {} : null) }) }],
    ["on or in a button, an input or anything that acts", { link: link(), acts: true }],
    ["a link whose address is not http or https now", { link: link({ protocol: "javascript:" }) }],
    ["a mailto: address", { link: link({ protocol: "mailto:" }) }],
  ] as [string, Fake][])("stops the click before any handler sees it: %s", (_name, fake) => {
    const { event, refused } = click(fake);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopImmediatePropagation).toHaveBeenCalled();
    expect(refused).toHaveBeenCalled();
  });
});
