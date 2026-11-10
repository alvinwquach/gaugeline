// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Shell } from "../../Shell";
import { VIEWS } from "../../views";
import {
  checkedOf,
  doneRun,
  installApi,
  installEventSource,
  request,
  result,
} from "../../__tests__/helpers";

beforeEach(() => {
  installEventSource();
  window.location.hash = "";
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const run = {
  ...doneRun("a", "https://alpha.example/", result({ url: "https://alpha.example/" })),
  checked: checkedOf({
    requests: [
      request({ url: "https://alpha.example/" }),
      request({ url: "https://alpha.example/x", kind: "link", status: 404 }),
    ],
  }),
};

describe("Pages checked and Search data in the shell", () => {
  it("are registered after Problems, and the navigation names them", async () => {
    expect(VIEWS.map((v) => v.id)).toEqual([
      "overview",
      "problems",
      "pages",
      "search",
      "leaks",
      "pageCost",
      "automaticMessages",
      "content",
    ]);
    installApi([run]);
    render(<Shell />);
    const nav = await screen.findByRole("navigation", { name: "Views" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["Overview", "Problems", "Pages checked", "Search data", "Leaks & access"]);
  });

  it("each opens from the navigation, with the run it names in the address", async () => {
    const user = userEvent.setup();
    installApi([run]);
    render(<Shell />);
    await user.click(await screen.findByRole("link", { name: "Pages checked" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Pages checked" })).toBeTruthy();
    await waitFor(() => expect(window.location.hash).toBe("#/a/pages"));
    expect(await screen.findByRole("table")).toBeTruthy();
    expect(screen.getByText(/Showing 2 of 2 addresses/)).toBeTruthy();
    await user.click(screen.getByRole("link", { name: "Search data" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Search data" })).toBeTruthy();
    await waitFor(() => expect(window.location.hash).toBe("#/a/search"));
    expect(screen.getByText("Larkspur Pottery Studio", { selector: "dd span" })).toBeTruthy();
  });

  it("opening the address directly shows the view once the run is read", async () => {
    window.location.hash = "#/a/pages";
    installApi([run]);
    render(<Shell />);
    expect(await screen.findByRole("table")).toBeTruthy();
  });
});
