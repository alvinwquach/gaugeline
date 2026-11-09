// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Overview } from "../views/Overview";
import { finding, result, runState } from "./helpers";

afterEach(cleanup);

const mixed = result({
  findings: [
    finding({ checkId: "a-low", severity: "low", title: "Low one" }),
    finding({ checkId: "a-med", severity: "medium", title: "Medium one" }),
    finding({ checkId: "a-high-1", severity: "high", title: "High one" }),
    finding({ checkId: "a-high-2", severity: "high", title: "High two" }),
    finding({ checkId: "a-med-2", severity: "medium", title: "Medium two" }),
  ],
  passed: ["canonical-elsewhere", "no-such-check-in-this-build"],
  couldNotCheck: [
    { id: "broken-links", reason: "The site refused the request.", url: "https://shop.example/x" },
  ],
  sampled: {
    links: { seen: 112, taken: 30, limit: 30 },
    images: { seen: 14, taken: 14, limit: 20 },
    feeds: { seen: 1, taken: 1, limit: 5 },
    calendars: { seen: 0, taken: 0, limit: 5 },
    frameworkAddresses: { seen: 3, taken: 0, limit: 0 },
  },
});

const section = (name: string) => {
  const heading = screen.getByRole("heading", { name });
  return within(heading.closest("section") as HTMLElement);
};

describe("Overview with a mixed result", () => {
  const view = () => render(<Overview run={runState({ result: mixed })} />);

  it("has one h1 and names the address", () => {
    view();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Overview");
    expect(screen.getByText("https://shop.example/", { selector: ".subject" })).toBeTruthy();
  });

  it("counts by urgency, in the three levels' words", () => {
    view();
    const counts = section("What was found");
    expect(counts.getByText("Fix this first").parentElement?.textContent).toContain("2");
    expect(counts.getByText("Fix soon").parentElement?.textContent).toContain("2");
    expect(counts.getByText("Worth knowing").parentElement?.textContent).toContain("1");
  });

  it("where to start: the first three findings by level, then by the order in the result", () => {
    view();
    const items = section("Where to start").getAllByRole("listitem");
    expect(items.map((li) => li.querySelector("h3")?.textContent)).toEqual([
      "High one",
      "High two",
      "Medium one",
    ]);
    expect(items[0]?.textContent).toContain("Fix this first");
    expect(items[2]?.textContent).toContain("Fix soon");
  });

  it("what looked right: a passed check by its title, and an unknown id as the id", () => {
    view();
    const right = section("What looked right");
    expect(right.getByText("This page tells Google to show a different page")).toBeTruthy();
    expect(right.getByText("no-such-check-in-this-build")).toBeTruthy();
  });

  it("how much was checked: one line per kind with something found", () => {
    view();
    const checked = section("How much was checked");
    expect(checked.getByText("30 of 112 links checked")).toBeTruthy();
    expect(checked.getByText("all 14 images checked")).toBeTruthy();
    expect(checked.getByText("the 1 feed checked")).toBeTruthy();
    expect(checked.getByText("3 framework addresses ignored (never requested)")).toBeTruthy();
    expect(checked.queryByText(/calendar/)).toBeNull();
  });

  it("lists what could not be checked, with the reason", () => {
    view();
    const text = section("Could not check").getByRole("listitem").textContent ?? "";
    expect(text).toContain("The site refused the request.");
    expect(text).toContain("https://shop.example/x");
  });
});

describe("Overview with zero findings", () => {
  it("says nothing needs fixing and still shows what was verified", () => {
    render(
      <Overview
        run={runState({
          result: result({
            passed: ["canonical-elsewhere"],
            sampled: { links: { seen: 2, taken: 2, limit: 30 } },
          }),
        })}
      />,
    );
    expect(screen.getByText(/Nothing to fix/)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Where to start" })).toBeNull();
    expect(section("What looked right").getAllByRole("listitem")).toHaveLength(1);
    expect(section("How much was checked").getByText("all 2 links checked")).toBeTruthy();
    expect(section("What was found").getAllByText("0").length).toBe(3);
  });

  it("says when nothing was sampled", () => {
    render(<Overview run={runState({ result: result({ passed: ["canonical-elsewhere"] }) })} />);
    expect(screen.getByText(/Nothing was sampled/)).toBeTruthy();
  });
});

describe("Overview with a run that could not run", () => {
  it("shows the reason from the failed event, as text", () => {
    render(
      <Overview
        run={runState({
          state: "failed",
          reason: "The address <b>shop.example</b> did not answer.",
        })}
      />,
    );
    expect(screen.getByRole("heading", { name: "This check could not run" })).toBeTruthy();
    expect(screen.getByText("The address <b>shop.example</b> did not answer.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "What looked right" })).toBeNull();
  });
});

describe("Overview while a run is going", () => {
  it("shows the step lines in a polite live region", () => {
    render(
      <Overview
        run={runState({
          state: "running",
          steps: [
            { id: 1, text: "Loading the page without JavaScript" },
            { id: 2, text: "Reading robots.txt and the sitemap" },
          ],
        })}
      />,
    );
    const live = screen.getByRole("list", { name: "Progress" });
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(
      within(live)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Loading the page without JavaScript", "Reading robots.txt and the sitemap"]);
    expect(screen.queryByRole("heading", { name: "What looked right" })).toBeNull();
  });

  it("has the live region before the first step arrives", () => {
    render(<Overview run={runState({ state: "running" })} />);
    expect(screen.getByRole("list", { name: "Progress" }).getAttribute("aria-live")).toBe("polite");
  });
});

describe("Overview when the result is not here yet", () => {
  it("says it is loading, then says why it could not be read", () => {
    const { rerender } = render(<Overview run={runState({ state: "done" })} />);
    expect(screen.getByText("Loading the results...")).toBeTruthy();
    rerender(
      <Overview
        run={runState({
          state: "done",
          loadError: "This app reads schema 2; this result is schema 3.",
        })}
      />,
    );
    expect(screen.getByText("This app reads schema 2; this result is schema 3.")).toBeTruthy();
  });
});

describe("Overview shows page values as text", () => {
  it("never turns a title or evidence into markup", () => {
    const hostile = "<img src=x onerror=alert(1)>";
    const { container } = render(
      <Overview
        run={runState({
          url: `https://shop.example/?q=${hostile}`,
          result: result({
            findings: [
              finding({
                title: `Title ${hostile}`,
                evidence: `title: ${hostile}`,
                url: `https://shop.example/${hostile}`,
              }),
            ],
            couldNotCheck: [{ id: "x", reason: hostile, url: hostile }],
          }),
        })}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[onerror]")).toBeNull();
    expect(screen.getByText(`Title ${hostile}`)).toBeTruthy();
    expect(screen.getByText(`title: ${hostile}`)).toBeTruthy();
  });
});
