// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHECK_TEXT } from "../../check-titles";
import { finding, result, runState } from "../../__tests__/helpers";
import { Problems } from "../../views/Problems";
import { buildNote } from "../note";

beforeEach(() => {
  window.location.hash = "";
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "clipboard");
});

const f0 = finding({ checkId: "canonical-elsewhere", severity: "high", title: "Canonical one" });
const f1 = finding({ checkId: "images-heavy", severity: "medium", title: "Heavy images" });
const f2 = finding({ checkId: "og-image-missing", severity: "low", title: "No share picture" });
const f3 = finding({ checkId: "images-broken", severity: "high", title: "Broken images" });
const f4 = finding({ checkId: "email-spf-missing", severity: "medium", title: "No SPF" });
const mixed = [f0, f1, f2, f3, f4];

const runOf = (findings = mixed, id = "run-1") =>
  runState({ id, url: "https://shop.example/", result: result({ findings }) });

const heading = (n: number) =>
  screen.getByRole("heading", {
    level: 2,
    name: new RegExp(n === 0 ? "^No problems" : `^Showing ${n}`),
  });
/** The button that opens each finding, in page order. */
const rows = () => [...document.querySelectorAll<HTMLButtonElement>("button.finding-toggle")];
const levelButton = (label: string) =>
  screen.getByRole("button", { name: new RegExp(`^${label}`) });

/** A clipboard that records what it is given. */
function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
}

describe("the Problems view: list and filters", () => {
  it("has one h1 and groups every finding by level in the order Fix this first, Fix soon, Worth knowing", () => {
    render(<Problems run={runOf()} />);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    const groups = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(groups).toEqual(["Fix this first (2)", "Fix soon (2)", "Worth knowing (1)"]);
    expect(rows().map((r) => r.textContent)).toEqual([
      "Canonical one",
      "Broken images",
      "Heavy images",
      "No SPF",
      "No share picture",
    ]);
    expect(heading(5)).toBeTruthy();
  });

  it("toggling a level updates the list and the count in the heading", async () => {
    const user = userEvent.setup();
    render(<Problems run={runOf()} />);
    const fixFirst = levelButton("Fix this first");
    expect(fixFirst.getAttribute("aria-pressed")).toBe("false");
    await user.click(fixFirst);
    expect(fixFirst.getAttribute("aria-pressed")).toBe("true");
    expect(rows().map((r) => r.textContent)).toEqual(["Canonical one", "Broken images"]);
    expect(heading(2).textContent).toBe("Showing 2 of 5 problems");
    expect(screen.queryByRole("heading", { level: 3, name: /Fix soon/ })).toBeNull();
    // A second level: either one.
    await user.click(levelButton("Worth knowing"));
    expect(rows()).toHaveLength(3);
    expect(heading(3).textContent).toBe("Showing 3 of 5 problems");
    // Off again: all.
    await user.click(fixFirst);
    await user.click(levelButton("Worth knowing"));
    expect(rows()).toHaveLength(5);
  });

  it("offers only the areas this run has findings in, with counts", () => {
    render(<Problems run={runOf()} />);
    const areas = within(screen.getByRole("group", { name: "Area" }));
    expect(areas.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Search & sharing (2)",
      "Visitors (2)",
      "Security & email (1)",
    ]);
    expect(areas.queryByRole("button", { name: /Launch day/ })).toBeNull();
    const levels = within(screen.getByRole("group", { name: "Urgency" }));
    expect(levels.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Fix this first (2)",
      "Fix soon (2)",
      "Worth knowing (1)",
    ]);
  });

  it("a level and an area combine with AND; two areas combine with OR", async () => {
    const user = userEvent.setup();
    render(<Problems run={runOf()} />);
    await user.click(levelButton("Fix this first"));
    await user.click(screen.getByRole("button", { name: /^Visitors/ }));
    expect(rows().map((r) => r.textContent)).toEqual(["Broken images"]);
    await user.click(screen.getByRole("button", { name: /^Search & sharing/ }));
    expect(rows().map((r) => r.textContent)).toEqual(["Canonical one", "Broken images"]);
  });

  it("a combination that matches nothing says so and offers to clear the filters", async () => {
    const user = userEvent.setup();
    render(<Problems run={runOf()} />);
    await user.click(levelButton("Worth knowing"));
    await user.click(screen.getByRole("button", { name: /^Security/ }));
    expect(rows()).toHaveLength(0);
    expect(screen.getByText("No problems match these filters.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(rows()).toHaveLength(5);
  });

  it("filters reset when the selected run changes", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Problems run={runOf(mixed, "a")} />);
    await user.click(levelButton("Fix soon"));
    expect(rows()).toHaveLength(2);
    rerender(<Problems run={runOf(mixed, "b")} />);
    expect(rows()).toHaveLength(5);
    expect(levelButton("Fix soon").getAttribute("aria-pressed")).toBe("false");
  });

  it("filter buttons are toggle buttons in the tab order that Enter and Space press", async () => {
    const user = userEvent.setup();
    render(<Problems run={runOf()} />);
    const fixSoon = levelButton("Fix soon");
    fixSoon.focus();
    await user.keyboard("{Enter}");
    expect(fixSoon.getAttribute("aria-pressed")).toBe("true");
    await user.keyboard(" ");
    expect(fixSoon.getAttribute("aria-pressed")).toBe("false");
    for (const b of within(screen.getByRole("group", { name: "Urgency" })).getAllByRole("button"))
      expect(b.getAttribute("aria-pressed")).not.toBeNull();
  });

  it("renders 500 findings, and a filter changes the list at once", async () => {
    const many = Array.from({ length: 500 }, (_, i) =>
      finding({
        checkId: i % 2 === 0 ? "images-broken" : "og-image-missing",
        severity: i % 5 === 0 ? "high" : "low",
        title: `Finding ${i}`,
      }),
    );
    const user = userEvent.setup();
    render(<Problems run={runOf(many)} />);
    expect(rows()).toHaveLength(500);
    const start = performance.now();
    await act(async () => {
      levelButton("Fix this first").click();
    });
    const took = performance.now() - start;
    expect(rows()).toHaveLength(100);
    expect(heading(100).textContent).toBe("Showing 100 of 500 problems");
    // jsdom is far slower than a browser; this is a ceiling for a hung render, not the frame budget
    // (the filter itself is held to 16 ms in filter.test.ts).
    expect(took).toBeLessThan(1500);
    await user.click(levelButton("Fix this first"));
    expect(rows()).toHaveLength(500);
  });
});

describe("the Problems view: an open finding", () => {
  it("opens with Enter and with Space, and shows what was found, why it matters and how to fix it", async () => {
    const user = userEvent.setup();
    render(<Problems run={runOf()} />);
    const [what, why, fix] = CHECK_TEXT["canonical-elsewhere"] as readonly string[];
    const row = screen.getByRole("button", { name: "Canonical one" });
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(why as string)).toBeNull();
    row.focus();
    await user.keyboard("{Enter}");
    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(what as string)).toBeTruthy();
    expect(screen.getByText(why as string)).toBeTruthy();
    expect(screen.getByText(fix as string)).toBeTruthy();
    expect(screen.getByText(f0.evidence)).toBeTruthy();
    await user.keyboard(" ");
    expect(row.getAttribute("aria-expanded")).toBe("false");
    await user.keyboard(" ");
    expect(row.getAttribute("aria-expanded")).toBe("true");
  });

  it("opening one finding closes the one before, and the open one is in the address", async () => {
    const user = userEvent.setup();
    render(<Problems run={runOf()} />);
    await user.click(screen.getByRole("button", { name: "Canonical one" }));
    expect(window.location.hash).toBe("#/run-1/problems/0");
    await user.click(screen.getByRole("button", { name: "Broken images" }));
    expect(window.location.hash).toBe("#/run-1/problems/3");
    expect(
      screen.getByRole("button", { name: "Canonical one" }).getAttribute("aria-expanded"),
    ).toBe("false");
    await user.click(screen.getByRole("button", { name: "Broken images" }));
    expect(window.location.hash).toBe("#/run-1/problems");
  });

  it("opens the finding the address names, and ignores an index that is not one", () => {
    window.location.hash = "#/run-1/problems/1";
    render(<Problems run={runOf()} />);
    expect(screen.getByRole("button", { name: "Heavy images" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
    cleanup();
    for (const bad of ["99", "-1", "x", "1.5"]) {
      window.location.hash = `#/run-1/problems/${bad}`;
      render(<Problems run={runOf()} />);
      for (const r of rows()) expect(r.getAttribute("aria-expanded")).toBe("false");
      cleanup();
    }
  });

  it("closes the open finding when a filter hides it", async () => {
    const user = userEvent.setup();
    render(<Problems run={runOf()} />);
    await user.click(screen.getByRole("button", { name: "Heavy images" }));
    await user.click(levelButton("Fix this first"));
    expect(window.location.hash).toBe("#/run-1/problems");
  });

  it("keeps the technical line out of the DOM until the button is pressed", async () => {
    const user = userEvent.setup();
    render(<Problems run={runOf()} />);
    const tech = (CHECK_TEXT["canonical-elsewhere"] as readonly string[])[3] as string;
    await user.click(screen.getByRole("button", { name: "Canonical one" }));
    expect(screen.queryByText(tech)).toBeNull();
    const show = screen.getByRole("button", { name: "Show technical detail" });
    expect(show.getAttribute("aria-expanded")).toBe("false");
    await user.click(show);
    expect(screen.getByText(tech)).toBeTruthy();
    const hide = screen.getByRole("button", { name: "Hide technical detail" });
    expect(hide.getAttribute("aria-expanded")).toBe("true");
    await user.click(hide);
    expect(screen.queryByText(tech)).toBeNull();
  });

  it("shows every value from the page as text, never as markup", async () => {
    const user = userEvent.setup();
    const hostile = finding({
      title: "<img src=x onerror=alert(1)>",
      evidence: "<script>alert(2)</script>",
      url: "https://shop.example/<b>x</b>",
    });
    const { container } = render(<Problems run={runOf([hostile])} />);
    await user.click(screen.getByRole("button", { name: "<img src=x onerror=alert(1)>" }));
    expect(screen.getByText("<script>alert(2)</script>")).toBeTruthy();
    expect(container.querySelector("img, script, b")).toBeNull();
  });

  it("wraps a 5,000-character address in the evidence and keeps all of it", async () => {
    const user = userEvent.setup();
    const long = `https://shop.example/${"a".repeat(5000)}`;
    render(<Problems run={runOf([finding({ title: "Long", evidence: `404: ${long}` })])} />);
    await user.click(screen.getByRole("button", { name: "Long" }));
    const evidence = screen.getByText(`404: ${long}`);
    expect(evidence.className).toContain("evidence");
    expect(evidence.textContent).toBe(`404: ${long}`);
  });

  it("a finding with no evidence shows no empty evidence block", async () => {
    const user = userEvent.setup();
    render(<Problems run={runOf([finding({ title: "Bare", evidence: "" })])} />);
    await user.click(screen.getByRole("button", { name: "Bare" }));
    expect(screen.queryByRole("heading", { name: "Evidence" })).toBeNull();
  });

  it("for a check this build has no text for, shows the evidence and says why there is nothing more", async () => {
    const user = userEvent.setup();
    render(
      <Problems run={runOf([finding({ checkId: "from-a-newer-version", title: "Newer" })])} />,
    );
    await user.click(screen.getByRole("button", { name: "Newer" }));
    expect(screen.queryByRole("button", { name: "Show technical detail" })).toBeNull();
    expect(screen.getByText(/does not know this check/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy note for your developer" })).toBeTruthy();
  });
});

describe("copy note for your developer", () => {
  const open = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole("button", { name: "Canonical one" }));
  };

  it("writes buildNote to the clipboard and confirms in a polite live region", async () => {
    const user = userEvent.setup();
    const written: string[] = [];
    render(<Problems run={runOf()} />);
    stubClipboard(async (t) => void written.push(t));
    await open(user);
    const live = document.querySelector('[aria-live="polite"].copy-status') as HTMLElement;
    expect(live).not.toBeNull();
    expect(live.textContent).toBe("");
    await user.click(screen.getByRole("button", { name: "Copy note for your developer" }));
    expect(written).toEqual([buildNote(f0, { url: "https://shop.example/" })]);
    await waitFor(() => expect(live.textContent).toBe("Note copied to the clipboard."));
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("a rejected clipboard promise shows the note in a read-only, selected textarea", async () => {
    const user = userEvent.setup();
    render(<Problems run={runOf()} />);
    stubClipboard(() => Promise.reject(new DOMException("denied", "NotAllowedError")));
    await open(user);
    await user.click(screen.getByRole("button", { name: "Copy note for your developer" }));
    const box = (await screen.findByRole("textbox", { name: /note/i })) as HTMLTextAreaElement;
    const note = buildNote(f0, { url: "https://shop.example/" });
    expect(box.value).toBe(note);
    expect(box.readOnly).toBe(true);
    expect(document.activeElement).toBe(box);
    expect(box.selectionStart).toBe(0);
    expect(box.selectionEnd).toBe(note.length);
    const live = document.querySelector(".copy-status") as HTMLElement;
    expect(live.textContent).toMatch(/copy it by hand/i);
  });

  it("without navigator.clipboard it shows the same fallback", async () => {
    const user = userEvent.setup();
    render(<Problems run={runOf()} />);
    // userEvent.setup() puts its own clipboard in place; take it away, as an old browser or a plain-http page would.
    Reflect.deleteProperty(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    await open(user);
    await user.click(screen.getByRole("button", { name: "Copy note for your developer" }));
    expect(await screen.findByRole("textbox", { name: /note/i })).toBeTruthy();
    expect(document.querySelector(".copy-status")?.textContent).toMatch(/copy it by hand/i);
  });

  it("a clipboard that throws at once is treated like one that rejects", async () => {
    const user = userEvent.setup();
    render(<Problems run={runOf()} />);
    stubClipboard(() => {
      throw new Error("not allowed");
    });
    await open(user);
    await user.click(screen.getByRole("button", { name: "Copy note for your developer" }));
    expect(await screen.findByRole("textbox", { name: /note/i })).toBeTruthy();
  });
});

describe("a run with nothing to show", () => {
  it("with zero findings says nothing needs fixing and links to the Overview", () => {
    render(<Problems run={runOf([])} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Problems");
    expect(screen.getByText("Nothing needs fixing.")).toBeTruthy();
    const link = screen.getByRole("link", { name: /Overview/ });
    expect(link.getAttribute("href")).toBe("#/run-1/overview");
    expect(screen.queryByRole("group", { name: "Urgency" })).toBeNull();
  });

  it("while it runs, or when it could not run, says so instead of listing", () => {
    const { unmount } = render(<Problems run={runState({ state: "running" })} />);
    expect(screen.getByText(/still checking/i)).toBeTruthy();
    unmount();
    render(<Problems run={runState({ state: "failed", reason: "The site refused." })} />);
    expect(screen.getByText("The site refused.")).toBeTruthy();
  });
});
