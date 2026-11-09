// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkedOf, finding, result, runState } from "../../__tests__/helpers";
import { SearchData } from "../../views/SearchData";
import type { PageData, StructuredBlock } from "../../types";

beforeEach(() => {
  window.location.hash = "";
});
afterEach(cleanup);

const page = (over: Partial<PageData> = {}): PageData => ({ ...checkedOf().page, ...over });
const view = (p: PageData, over = {}) =>
  render(<SearchData run={runState({ checked: { page: p }, ...over })} />);

const product: StructuredBlock = {
  ok: true,
  value: {
    "@type": "Product",
    name: "Speckled mug",
    offers: { "@type": "Offer", price: "24.00", priceCurrency: "USD" },
  },
};
const broken: StructuredBlock = {
  ok: false,
  raw: '{"@type": "LocalBusiness", ',
  error: "Expected double-quoted property name in JSON at position 27",
};

/** The value shown next to a label in the page's summary list. */
const summary = (label: string) => {
  const dt = screen.getByText(label, { selector: "dt" });
  return (dt.nextElementSibling as HTMLElement).textContent;
};

describe("the Search data view: title, canonical and words", () => {
  it("shows the title, the canonical and the readable word count, with one h1", () => {
    view(page({ words: 412 }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Search data");
    expect(summary("Title")).toBe("Larkspur Pottery Studio");
    expect(summary("Canonical")).toBe("https://shop.example/");
    expect(summary("Readable words")).toBe("412");
  });

  it("a missing title is 'Not set' and an empty canonical is 'Empty'", () => {
    const { title: _t, ...noTitle } = page();
    view({ ...noTitle, canonical: "" });
    expect(summary("Title")).toBe("Not set");
    expect(summary("Canonical")).toBe("Empty");
  });

  it("a missing canonical is 'Not set' and an empty title is 'Empty'", () => {
    const { canonical: _c, ...noCanonical } = page();
    view({ ...noCanonical, title: "" });
    expect(summary("Title")).toBe("Empty");
    expect(summary("Canonical")).toBe("Not set");
  });

  it("a title in a right-to-left script keeps its direction", () => {
    view(
      page({
        title:
          "\u05D4\u05E1\u05D8\u05D5\u05D3\u05D9\u05D5 \u05DC\u05E7\u05E8\u05DE\u05D9\u05E7\u05D4",
      }),
    );
    const dd = screen.getByText("Title", { selector: "dt" }).nextElementSibling as HTMLElement;
    expect(dd.querySelector("[dir='auto']")?.textContent).toContain(
      "\u05D4\u05E1\u05D8\u05D5\u05D3\u05D9\u05D5",
    );
  });

  it("the first words are text, in a block that keeps its direction", () => {
    view(page({ words: 3, firstWords: "<b>Mugs</b> bowls planters" }));
    const preview = screen.getByText("<b>Mugs</b> bowls planters");
    expect(preview.getAttribute("dir")).toBe("auto");
    expect(document.querySelectorAll("b")).toHaveLength(0);
  });

  it("a page with no readable words says so and points to the finding in Problems", () => {
    const thin = finding({ checkId: "thin-html", title: "Google sees an almost empty page" });
    view(page({ words: 0, firstWords: "" }), {
      id: "run-9",
      result: result({ findings: [finding(), thin] }),
    });
    expect(screen.getByText(/no words a visitor can read without JavaScript/i)).toBeTruthy();
    const link = screen.getByRole("link", { name: /Google sees an almost empty page/ });
    expect(link.getAttribute("href")).toBe("#/run-9/problems/1");
  });

  it("with no matching finding, it still says so and links to Problems", () => {
    view(page({ words: 0, firstWords: "" }), { result: result() });
    expect(screen.getByRole("link", { name: "Problems" }).getAttribute("href")).toBe(
      "#/run-1/problems",
    );
  });
});

describe("the Search data view: structured data", () => {
  it("two blocks, one invalid: the tree for the first, the raw text and the error for the second", () => {
    view(page({ blocks: [product, broken] }));
    const section = screen.getByRole("heading", { name: "Structured data" }).closest("section");
    const blocks = within(section as HTMLElement).getAllByRole("listitem", { name: /^Block/ });
    expect(blocks).toHaveLength(2);
    expect(within(blocks[0] as HTMLElement).getByText("Block 1: Product")).toBeTruthy();
    expect(within(blocks[0] as HTMLElement).getByText("Speckled mug")).toBeTruthy();
    expect(within(blocks[1] as HTMLElement).getByText("Block 2: Could not be read")).toBeTruthy();
    const raw = within(blocks[1] as HTMLElement).getByText('{"@type": "LocalBusiness",');
    expect(raw.closest("pre")).not.toBeNull();
    expect(
      within(blocks[1] as HTMLElement).getByText(
        "Expected double-quoted property name in JSON at position 27",
      ),
    ).toBeTruthy();
  });

  it("types and fields read without braces; a node can be opened and closed", async () => {
    const user = userEvent.setup();
    view(page({ blocks: [product] }));
    const offers = screen.getByRole("button", { name: /^offers/ });
    expect(offers.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("24.00")).toBeTruthy();
    await user.click(offers);
    expect(offers.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("24.00")).toBeNull();
    await user.keyboard("{Enter}");
    expect(offers.getAttribute("aria-expanded")).toBe("true");
    expect(document.body.textContent).not.toContain("{");
  });

  it("nodes below the third level start collapsed", () => {
    let deep: unknown = { leaf: "bottom" };
    for (const k of ["c", "b", "a"]) deep = { [k]: deep };
    view(page({ blocks: [{ ok: true, value: deep }] }));
    // a (level 1) b (2) c (3) are open; leaf is the fourth level, a value, shown; one more down is not.
    expect(screen.getByRole("button", { name: /^a/ }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: /^c/ }).getAttribute("aria-expanded")).toBe("true");
    cleanup();
    let deeper: unknown = { leaf: "bottom" };
    for (const k of ["d", "c", "b", "a"]) deeper = { [k]: deeper };
    view(page({ blocks: [{ ok: true, value: deeper }] }));
    expect(screen.getByRole("button", { name: /^d/ }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("bottom")).toBeNull();
  });

  it("a value containing </script><script>alert(1)</script> is shown as text", () => {
    const evil = "</script><script>alert(1)</script>";
    view(
      page({
        blocks: [
          { ok: true, value: { "@type": "Product", name: evil } },
          { ok: false, raw: evil, error: evil },
        ],
      }),
    );
    expect(document.querySelectorAll("script")).toHaveLength(0);
    expect(screen.getAllByText(evil).length).toBeGreaterThanOrEqual(2);
  });

  it("a block whose type is a string where an object was expected still reads", () => {
    view(page({ blocks: [{ ok: true, value: { "@type": "Product", offers: "InStock" } }] }));
    expect(screen.getByText("offers")).toBeTruthy();
    expect(screen.getByText("InStock")).toBeTruthy();
  });

  it("says when the page declares none", () => {
    view(page({ blocks: [] }));
    expect(screen.getByText(/declares no structured data/i)).toBeTruthy();
  });

  it("values keep their direction and an empty value says so", () => {
    view(
      page({
        blocks: [{ ok: true, value: { "@type": "Product", name: "", sku: "\u05D0\u05D1" } }],
      }),
    );
    expect(screen.getByText("\u05D0\u05D1").getAttribute("dir")).toBe("auto");
    expect(screen.getByText("Empty")).toBeTruthy();
  });
});

describe("the Search data view: states", () => {
  it("says so when the run is still going, failed, not loaded, or kept no page data", () => {
    const { rerender } = render(<SearchData run={runState({ state: "running" })} />);
    expect(screen.getByText(/still checking/i)).toBeTruthy();
    rerender(
      <SearchData run={runState({ state: "failed", reason: "The site did not answer." })} />,
    );
    expect(screen.getByText("The site did not answer.")).toBeTruthy();
    rerender(<SearchData run={runState({ state: "done", loadError: "Lost the connection." })} />);
    expect(screen.getByText("Lost the connection.")).toBeTruthy();
    rerender(<SearchData run={runState({ state: "done", result: result() })} />);
    expect(screen.getByText(/did not keep what the page declares/i)).toBeTruthy();
  });
});
