// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FEATURES, isOff, type FeatureId } from "../features";
import { Shell } from "../Shell";
import { ViewNav } from "../ViewNav";
import { ViewPanel } from "../ViewPanel";
import { VIEWS, viewsFor, type View } from "../views";
import { doneRun, installApi, installEventSource, result, runState } from "./helpers";

const NOTE = "Needs your Sanity login. Coming in version 0.2.";
const IDS: FeatureId[] = ["pageCost", "automaticMessages", "content"];

beforeEach(() => {
  installEventSource();
  window.location.hash = "";
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  for (const id of IDS) FEATURES[id].enabled = false;
});

const run = doneRun("a", "https://clinic.example/", result({ url: "https://clinic.example/" }));
const views = () => screen.getByRole("navigation", { name: "Views" });

describe("FEATURES", () => {
  it("has exactly the three ids, all off, each with the note", () => {
    expect(Object.keys(FEATURES).sort()).toEqual([...IDS].sort());
    for (const id of IDS) {
      expect(FEATURES[id].enabled).toBe(false);
      expect(FEATURES[id].note).toBe(NOTE);
    }
    expect(FEATURES.pageCost.label).toBe("Page cost");
    expect(FEATURES.automaticMessages.label).toBe("Automatic messages");
    expect(FEATURES.content.label).toBe("Content");
  });

  it("is read when it is used, so a view follows its flag", () => {
    const view: View = { id: "x", label: "X", feature: "content", component: () => null };
    expect(isOff(view)).toBe(true);
    FEATURES.content.enabled = true;
    expect(isOff(view)).toBe(false);
    const plain: View = { id: "y", label: "Y", component: () => null };
    expect(isOff(plain)).toBe(false);
  });
});

describe("VIEWS", () => {
  it("names a feature that exists for every entry that has one, and puts the three last", () => {
    for (const v of VIEWS) if (v.feature !== undefined) expect(FEATURES).toHaveProperty(v.feature);
    expect(VIEWS.map((v) => v.label)).toEqual([
      "Overview",
      "Problems",
      "Pages checked",
      "Search data",
      "Leaks & access",
      "Page cost",
      "Automatic messages",
      "Content",
    ]);
    expect(VIEWS.filter((v) => v.feature).map((v) => v.id)).toEqual(IDS);
  });

  it("takes each label from the flag it names, so the two cannot drift apart", () => {
    for (const v of VIEWS) if (v.feature) expect(v.label).toBe(FEATURES[v.feature].label);
  });

  it("leaves an ads run with only its own two views", () => {
    expect(viewsFor({ kind: "ads" }).map((v) => v.id)).toEqual(["ads", "problems"]);
  });
});

describe("the navigation", () => {
  it("shows the three as buttons with aria-disabled and the note as their description", async () => {
    installApi([run]);
    render(<Shell />);
    await screen.findByRole("heading", { level: 1, name: "Overview" });
    const nav = within(views());
    for (const id of IDS) {
      const item = nav.getByRole("button", { name: FEATURES[id].label, description: NOTE });
      expect(item.getAttribute("aria-disabled")).toBe("true");
      // The attribute that would take it out of the Tab order is not used.
      expect(item.hasAttribute("disabled")).toBe(false);
      // The note is said once: a description, not also a title or part of the name.
      expect(item.hasAttribute("title")).toBe(false);
      expect(item.textContent).toBe(FEATURES[id].label);
      expect(item.tabIndex).toBe(0);
    }
    // The other five stay links.
    expect(nav.getAllByRole("link").map((a) => a.textContent)).toEqual([
      "Overview",
      "Problems",
      "Pages checked",
      "Search data",
      "Leaks & access",
    ]);
  });

  it("keeps the note visible as text under its label", async () => {
    installApi([run]);
    render(<Shell />);
    await screen.findByRole("heading", { level: 1, name: "Overview" });
    expect(within(views()).getAllByText(NOTE)).toHaveLength(3);
  });

  it("puts the three in the Tab order, after the links, and announces each note", async () => {
    installApi([run]);
    render(<Shell />);
    await screen.findByRole("heading", { level: 1, name: "Overview" });
    const user = userEvent.setup();
    const focused: string[] = [];
    // Form (2), the one sidebar link, then the eight views.
    for (let i = 0; i < 11; i++) {
      await user.tab();
      focused.push(document.activeElement?.textContent ?? "");
    }
    expect(focused.slice(3)).toEqual([
      "Overview",
      "Problems",
      "Pages checked",
      "Search data",
      "Leaks & access",
      "Page cost",
      "Automatic messages",
      "Content",
    ]);
  });

  it("does nothing when a disabled item is clicked or Enter or Space is pressed on it", async () => {
    installApi([run]);
    render(<Shell />);
    await screen.findByRole("heading", { level: 1, name: "Overview" });
    await waitFor(() => expect(window.location.hash).toBe("#/a/overview"));
    const user = userEvent.setup();
    const item = within(views()).getByRole("button", { name: "Page cost" });
    await user.click(item);
    item.focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(window.location.hash).toBe("#/a/overview");
    expect(screen.getByRole("heading", { level: 1, name: "Overview" })).toBeTruthy();
  });

  it("renders a view whose flag is on as a normal link and mounts its component", () => {
    FEATURES.pageCost.enabled = true;
    const Probe = () => <p>The real page cost view</p>;
    const list: View[] = [
      { id: "overview", label: "Overview", component: () => null },
      { id: "pageCost", label: "Page cost", feature: "pageCost", component: Probe },
      { id: "content", label: "Content", feature: "content", component: Probe },
    ];
    render(
      <>
        <ViewNav views={list} runId="a" currentId="pageCost" />
        <ViewPanel view={list[1]!} run={runState()} />
      </>,
    );
    const link = screen.getByRole("link", { name: "Page cost" });
    expect(link.getAttribute("href")).toBe("#/a/pageCost");
    expect(link.getAttribute("aria-current")).toBe("page");
    expect(screen.getByText("The real page cost view")).toBeTruthy();
    // The one still off is a button, and its panel is the placeholder, not Probe.
    expect(screen.getByRole("button", { name: "Content" })).toBeTruthy();
    cleanup();
    render(<ViewPanel view={list[2]!} run={runState()} />);
    expect(screen.queryByText("The real page cost view")).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Content" })).toBeTruthy();
  });
});

describe("the panel for a disabled view", () => {
  it.each([
    ["pageCost", "Page cost", "what each page asks Sanity for, compared with what it shows"],
    ["automaticMessages", "Automatic messages", "things Sanity does by itself when you publish"],
    [
      "content",
      "Content",
      "everything on your site as a table, with the pages each item appears on",
    ],
  ] as const)(
    "%s: states the label, the note and one sentence about what it will show",
    async (id, label, sentence) => {
      installApi([run]);
      window.location.hash = `#/a/${id}`;
      render(<Shell />);
      expect(await screen.findByRole("heading", { level: 1, name: label })).toBeTruthy();
      const main = within(screen.getByRole("main"));
      expect(main.getByText(NOTE)).toBeTruthy();
      expect(
        main.getByText((text) => text.toLowerCase().includes(sentence.toLowerCase())),
      ).toBeTruthy();
      // The address keeps the view: nothing corrects it away.
      await waitFor(() => expect(window.location.hash).toBe(`#/a/${id}`));
      // Nothing in it is a table, a list of rows or a picture: no sample data.
      expect(main.queryByRole("table")).toBeNull();
      expect(main.queryByRole("img")).toBeNull();
      expect(main.queryAllByRole("listitem")).toEqual([]);
    },
  );

  it("asks the server for the session and nothing else: no request names Sanity or the site", async () => {
    const api = installApi([run]);
    window.location.hash = "#/a/content";
    render(<Shell />);
    await screen.findByRole("heading", { level: 1, name: "Content" });
    const fetchMock = vi.mocked(globalThis.fetch);
    const asked = fetchMock.mock.calls.map((c) => String(c[0]));
    for (const url of asked) expect(url.startsWith("/api/")).toBe(true);
    expect(asked.join(" ")).not.toMatch(/sanity|clinic\.example/i);
    expect(api.calls.every((c) => c.startsWith("GET "))).toBe(true);
  });
});
