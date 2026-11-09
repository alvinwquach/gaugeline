// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Shell } from "../../Shell";
import { VIEWS } from "../../views";
import { doneRun, finding, installApi, installEventSource, result } from "../../__tests__/helpers";

beforeEach(() => {
  installEventSource();
  window.location.hash = "";
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const run = doneRun(
  "a",
  "https://alpha.example/",
  result({
    url: "https://alpha.example/",
    findings: [
      finding({ severity: "low", title: "A low one", checkId: "og-image-missing" }),
      finding({ severity: "high", title: "A high one", checkId: "images-broken" }),
    ],
  }),
);

describe("Problems in the shell", () => {
  it("is in the view registry after Overview, and the navigation shows it", async () => {
    expect(VIEWS.slice(0, 2).map((v) => v.id)).toEqual(["overview", "problems"]);
    installApi([run]);
    render(<Shell />);
    const nav = await screen.findByRole("navigation", { name: "Views" });
    expect(
      within(nav)
        .getAllByRole("link")
        .slice(0, 2)
        .map((l) => l.textContent),
    ).toEqual(["Overview", "Problems"]);
  });

  it("opens from the navigation, keeps the open finding in the address, and restores it", async () => {
    const user = userEvent.setup();
    installApi([run]);
    render(<Shell />);
    await user.click(await screen.findByRole("link", { name: "Problems" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Problems" })).toBeTruthy();
    await waitFor(() => expect(window.location.hash).toBe("#/a/problems"));
    await user.click(screen.getByRole("button", { name: "A high one" }));
    // The second finding in the result, whatever order the list shows it in.
    await waitFor(() => expect(window.location.hash).toBe("#/a/problems/1"));
    cleanup();

    // A reload: the same address, a fresh app.
    render(<Shell />);
    const row = await screen.findByRole("button", { name: "A high one" });
    expect(row.getAttribute("aria-expanded")).toBe("true");
    await waitFor(() => expect(window.location.hash).toBe("#/a/problems/1"));
  });

  it("selecting another run in the sidebar keeps the view and starts the filters over", async () => {
    const user = userEvent.setup();
    const other = doneRun(
      "b",
      "https://bravo.example/",
      result({ url: "https://bravo.example/", findings: [finding({ title: "B one" })] }),
    );
    installApi([run, other]);
    window.location.hash = "#/a/problems";
    render(<Shell />);
    await user.click(await screen.findByRole("button", { name: /^Worth knowing/ }));
    expect(screen.queryAllByRole("button", { expanded: false })).toHaveLength(1);
    await user.click(screen.getByRole("link", { name: /bravo\.example/ }));
    await waitFor(() => expect(window.location.hash).toBe("#/b/problems"));
    expect(await screen.findByRole("button", { name: "B one" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /^Fix this first/ }).getAttribute("aria-pressed"),
    ).toBe("false");
  });
});
