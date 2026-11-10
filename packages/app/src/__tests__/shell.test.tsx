// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Shell } from "../Shell";
import type { RunDetail } from "../types";
import {
  FakeEventSource,
  countsOf,
  doneRun,
  finding,
  installApi,
  installEventSource,
  result,
} from "./helpers";

beforeEach(() => {
  installEventSource();
  window.location.hash = "";
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const high = finding({ severity: "high", title: "A high one" });
const med = finding({ severity: "medium", title: "A medium one", checkId: "m" });
const low = finding({ severity: "low", title: "A low one", checkId: "l" });
const runA = doneRun(
  "a",
  "https://alpha.example/",
  result({ url: "https://alpha.example/", findings: [high, high, low] }),
);
const runB = doneRun(
  "b",
  "https://bravo.example/",
  result({ url: "https://bravo.example/", findings: [med], passed: ["canonical-elsewhere"] }),
);

const sidebar = () => screen.getByRole("navigation", { name: "Pages checked this session" });
const sidebarLinks = () => within(sidebar()).getAllByRole("link");

describe("the sidebar", () => {
  it("lists the session in the order listRuns gives, with state and counts by level", async () => {
    installApi([runA, runB]);
    render(<Shell />);
    await waitFor(() => expect(sidebarLinks()).toHaveLength(2));
    const [first, second] = sidebarLinks();
    expect(first?.textContent).toContain("https://alpha.example/");
    expect(second?.textContent).toContain("https://bravo.example/");
    expect(first?.textContent).toContain("Done");
    expect(first?.textContent).toMatch(/2\s*Fix this first/);
    expect(first?.textContent).toMatch(/0\s*Fix soon/);
    expect(first?.textContent).toMatch(/1\s*Worth knowing/);
    expect(second?.textContent).toMatch(/1\s*Fix soon/);
  });

  it("keeps the whole address in the text and marks it for truncation by style", async () => {
    const long = `https://long.example/${"a".repeat(280)}`;
    expect(long.length).toBeGreaterThanOrEqual(300);
    installApi([doneRun("l", long, result({ url: long }))]);
    render(<Shell />);
    await waitFor(() => expect(sidebarLinks()).toHaveLength(1));
    const address = sidebarLinks()[0]?.querySelector(".run-url");
    expect(address?.textContent).toBe(long);
    expect(address?.getAttribute("title")).toBe(long);
    expect(address?.getAttribute("style")).toBeNull();
  });

  it("marks a run that could not run", async () => {
    const failed: RunDetail = {
      id: "f",
      url: "https://down.example/",
      state: "failed",
      startedAt: runA.startedAt,
    };
    installApi([failed]);
    render(<Shell />);
    await waitFor(() => expect(sidebarLinks()[0]?.textContent).toContain("Could not run"));
  });
});

describe("loading the session", () => {
  it("selects the newest run when the address has no hash, and writes it into the hash", async () => {
    installApi([runA, runB]);
    render(<Shell />);
    await waitFor(() => expect(sidebarLinks()[1]?.getAttribute("aria-current")).toBe("page"));
    await waitFor(() => expect(window.location.hash).toBe("#/b/overview"));
    expect(await screen.findByText("A medium one")).toBeTruthy();
  });

  it("restores the run named in the hash", async () => {
    window.location.hash = "#/a/overview";
    installApi([runA, runB]);
    render(<Shell />);
    expect(await screen.findAllByText("A high one")).toHaveLength(2);
    expect(sidebarLinks()[0]?.getAttribute("aria-current")).toBe("page");
    await waitFor(() => expect(window.location.hash).toBe("#/a/overview"));
  });

  it("falls back to the newest run when the hash names one that is gone", async () => {
    window.location.hash = "#/gone/overview";
    installApi([runA, runB]);
    render(<Shell />);
    await waitFor(() => expect(sidebarLinks()[1]?.getAttribute("aria-current")).toBe("page"));
    await waitFor(() => expect(window.location.hash).toBe("#/b/overview"));
  });

  it("shows the empty state, with the form, when the session has no runs", async () => {
    window.location.hash = "#/gone/overview";
    installApi([]);
    render(<Shell />);
    expect(await screen.findByRole("heading", { level: 1, name: "Check a page" })).toBeTruthy();
    expect(screen.getByLabelText("Address to check")).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Views" })).toBeNull();
  });

  it("an unknown view in the hash opens the first view", async () => {
    window.location.hash = "#/a/not-a-view";
    installApi([runA]);
    render(<Shell />);
    await screen.findByRole("heading", { level: 1, name: "Overview" });
    await waitFor(() => expect(window.location.hash).toBe("#/a/overview"));
  });

  it("follows the back button: a hash change selects that run", async () => {
    installApi([runA, runB]);
    render(<Shell />);
    await waitFor(() => expect(sidebarLinks()[1]?.getAttribute("aria-current")).toBe("page"));
    // The app writes the newest run into the address a moment after it selects it. Changing the address
    // before that write would be overwritten by it, so wait for it first.
    await waitFor(() => expect(window.location.hash).toBe("#/b/overview"));
    act(() => {
      window.location.hash = "#/a/overview";
    });
    await waitFor(() => expect(sidebarLinks()[0]?.getAttribute("aria-current")).toBe("page"));
  });
});

describe("the page structure", () => {
  it("has a banner, two navigations, a main region and one h1", async () => {
    installApi([runA]);
    render(<Shell />);
    await screen.findByRole("heading", { level: 1, name: "Overview" });
    expect(screen.getByRole("banner")).toBeTruthy();
    expect(screen.getByRole("main")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Views" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Pages checked this session" })).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("reaches the form, the sidebar and the navigation in that order with the keyboard", async () => {
    installApi([runA, runB]);
    render(<Shell />);
    await screen.findByRole("heading", { level: 1, name: "Overview" });
    const user = userEvent.setup();
    const order: string[] = [];
    for (let i = 0; i < 6; i++) {
      await user.tab();
      const el = document.activeElement as HTMLElement;
      const label = (el as HTMLInputElement).labels?.[0]?.textContent;
      order.push(label ?? el.textContent ?? el.tagName);
    }
    expect(order[0]).toBe("Address to check");
    expect(order[1]).toBe("Check");
    expect(order[2]).toContain("alpha.example");
    expect(order[3]).toContain("bravo.example");
    expect(order[4]).toBe("Overview");
  });
});

describe("starting a check", () => {
  it("posts the address, adds the run to the sidebar, selects it and shows its steps as they arrive", async () => {
    const api = installApi([runA]);
    render(<Shell />);
    await screen.findByRole("heading", { level: 1, name: "Overview" });
    const user = userEvent.setup();
    const field = screen.getByLabelText<HTMLInputElement>("Address to check");
    await user.type(field, "charlie.example{enter}");

    await waitFor(() => expect(sidebarLinks()).toHaveLength(2));
    expect(api.calls).toContain("POST /api/check");
    expect(sidebarLinks()[1]?.getAttribute("aria-current")).toBe("page");
    expect(sidebarLinks()[1]?.textContent).toContain("Checking");
    await waitFor(() => expect(window.location.hash).toBe("#/new-1/overview"));
    expect(field.value).toBe("");

    // Only the active run is watched.
    await waitFor(() => expect(FakeEventSource.sources).toHaveLength(1));
    const source = FakeEventSource.sources[0]!;
    expect(source.url).toBe("/api/runs/new-1/events");
    act(() => source.emit("step", 1, { text: "Loading the page without JavaScript" }));
    act(() => source.emit("step", 2, { text: "Reading robots.txt and the sitemap" }));
    const live = await screen.findByRole("list", { name: "Progress" });
    expect(within(live).getAllByRole("listitem")).toHaveLength(2);

    // It finishes: the server now has the result, the stream says done.
    const finished = doneRun(
      "new-1",
      "https://charlie.example/",
      result({ findings: [low], passed: ["canonical-elsewhere"] }),
    );
    api.runs[1] = finished;
    act(() => source.emit("done", 3, { counts: countsOf([low]) }));
    expect(await screen.findByText("A low one")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Progress" })).toBeNull();
    expect(sidebarLinks()[1]?.textContent).toMatch(/1\s*Worth knowing/);
  });

  it("shows the server's 400 next to the field and adds nothing to the sidebar", async () => {
    const api = installApi([runA]);
    api.onCheck = () =>
      new Response(JSON.stringify({ error: "That doesn't look like an address." }), {
        status: 400,
      });
    render(<Shell />);
    await screen.findByRole("heading", { level: 1, name: "Overview" });
    await userEvent.type(screen.getByLabelText("Address to check"), "nope nope{enter}");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "That doesn't look like an address.",
    );
    expect(screen.getByLabelText<HTMLInputElement>("Address to check").value).toBe("nope nope");
    expect(sidebarLinks()).toHaveLength(1);
  });

  it("watches only the active run, and watches another one after you select it", async () => {
    const running: RunDetail = {
      id: "r1",
      url: "https://run.example/",
      state: "running",
      startedAt: runA.startedAt,
    };
    installApi([runA, running]);
    render(<Shell />);
    await waitFor(() => expect(FakeEventSource.sources).toHaveLength(1));
    expect(FakeEventSource.sources[0]?.url).toBe("/api/runs/r1/events");
    await userEvent.click(sidebarLinks()[0]!);
    await waitFor(() => expect(FakeEventSource.sources[0]?.closed).toBe(true));
    expect(FakeEventSource.sources).toHaveLength(1);
  });

  it("a failed run shows the reason from the failed event", async () => {
    const running: RunDetail = {
      id: "r1",
      url: "https://run.example/",
      state: "running",
      startedAt: runA.startedAt,
    };
    const api = installApi([running]);
    render(<Shell />);
    await waitFor(() => expect(FakeEventSource.sources).toHaveLength(1));
    api.runs[0] = { ...running, state: "failed", reason: "The site did not answer." };
    act(() =>
      FakeEventSource.sources[0]!.emit("failed", 1, { reason: "The site did not answer." }),
    );
    expect(await screen.findByText("The site did not answer.")).toBeTruthy();
    expect(sidebarLinks()[0]?.textContent).toContain("Could not run");
  });
});

describe("a stream that drops", () => {
  it("recovers from getRun and shows each step line once", async () => {
    const running: RunDetail = {
      id: "r1",
      url: "https://run.example/",
      state: "running",
      startedAt: runA.startedAt,
    };
    const api = installApi([running]);
    render(<Shell />);
    await waitFor(() => expect(FakeEventSource.sources).toHaveLength(1));
    act(() =>
      FakeEventSource.sources[0]!.emit("step", 1, { text: "Loading the page without JavaScript" }),
    );
    act(() =>
      FakeEventSource.sources[0]!.emit("step", 2, { text: "Reading robots.txt and the sitemap" }),
    );
    act(() => FakeEventSource.sources[0]!.drop());
    // The app asks the server about the run again, then opens the stream again, which replays from the start.
    await waitFor(() => expect(FakeEventSource.sources).toHaveLength(2), { timeout: 4000 });
    expect(api.calls.filter((c) => c === "GET /api/runs/r1").length).toBeGreaterThanOrEqual(1);
    const again = FakeEventSource.sources[1]!;
    act(() => again.emit("step", 1, { text: "Loading the page without JavaScript" }));
    act(() => again.emit("step", 2, { text: "Reading robots.txt and the sitemap" }));
    act(() => again.emit("step", 3, { text: "Checking 4 links on the page" }));
    const items = within(screen.getByRole("list", { name: "Progress" })).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([
      "Loading the page without JavaScript",
      "Reading robots.txt and the sitemap",
      "Checking 4 links on the page",
    ]);
  });

  it("a run that finished while the stream was down shows its result", async () => {
    const running: RunDetail = {
      id: "r1",
      url: "https://run.example/",
      state: "running",
      startedAt: runA.startedAt,
    };
    const api = installApi([running]);
    render(<Shell />);
    await waitFor(() => expect(FakeEventSource.sources).toHaveLength(1));
    api.runs[0] = doneRun("r1", "https://run.example/", result({ findings: [med] }));
    act(() => FakeEventSource.sources[0]!.drop());
    expect(await screen.findByText("A medium one", {}, { timeout: 4000 })).toBeTruthy();
    expect(FakeEventSource.sources).toHaveLength(1);
  });
});

describe("runs that are not selected", () => {
  it("are refreshed from listRuns while they are running, so the sidebar does not go stale", async () => {
    const running: RunDetail = {
      id: "r1",
      url: "https://run.example/",
      state: "running",
      startedAt: runA.startedAt,
    };
    const api = installApi([running, runA]);
    window.location.hash = "#/a/overview";
    render(<Shell />);
    await screen.findAllByText("A high one");
    expect(sidebarLinks()[0]?.textContent).toContain("Checking");
    api.runs[0] = doneRun("r1", "https://run.example/", result({ findings: [med] }));
    await waitFor(() => expect(sidebarLinks()[0]?.textContent).toContain("Done"), {
      timeout: 5000,
    });
  });
});
