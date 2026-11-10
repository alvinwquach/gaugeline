// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Shell } from "../Shell";
import type { RunDetail } from "../types";
import { doneRun, finding, installApi, installEventSource, result } from "./helpers";

beforeEach(() => {
  installEventSource();
  window.location.hash = "";
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const done = doneRun(
  "run-1",
  "https://clinic.example/",
  result({ url: "https://clinic.example/", findings: [finding()] }),
);
const running: RunDetail = {
  id: "run-2",
  url: "https://bar.example/",
  state: "running",
  startedAt: "2026-11-09T11:00:00.000Z",
};

describe("Download the report", () => {
  it("is a plain link to the report route with the download attribute on a finished run", async () => {
    installApi([done]);
    render(<Shell />);
    const link = await screen.findByRole("link", { name: "Download the report" });
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("/api/runs/run-1/report");
    expect(link.getAttribute("download")).toBe("gaugeline-report.html");
  });

  it("builds no Blob and no object URL", async () => {
    const create = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: create }));
    installApi([done]);
    const blob = vi.spyOn(globalThis, "Blob");
    render(<Shell />);
    await screen.findByRole("link", { name: "Download the report" });
    await userEvent.setup().tab();
    expect(create).not.toHaveBeenCalled();
    expect(blob).not.toHaveBeenCalled();
    blob.mockRestore();
  });

  it("is not offered while the run is still going", async () => {
    installApi([running]);
    render(<Shell />);
    await screen.findByText("https://bar.example/", { selector: ".run-url" });
    expect(screen.queryByRole("link", { name: "Download the report" })).toBeNull();
  });

  it("names the open run, so the file is the one on screen", async () => {
    installApi([done, { ...done, id: "run 3", url: "https://clinic.example/b" }]);
    render(<Shell />);
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Download the report" }).getAttribute("href")).toBe(
        "/api/runs/run%203/report",
      ),
    );
  });
});

describe("the demo", () => {
  it("shows the Example results banner with the sentence, and switches the address form off", async () => {
    const api = installApi([done]);
    api.session = { demo: true, version: "0.2.0" };
    render(<Shell />);
    const banner = await screen.findByRole("note");
    expect(banner.textContent).toContain("Example results");
    expect(banner.textContent).toContain(
      "This is the demo. Run npx gaugeline open yoursite.com to check a real page.",
    );
    await waitFor(() =>
      expect((screen.getByLabelText("Address to check") as HTMLInputElement).disabled).toBe(true),
    );
    expect((screen.getByRole("button", { name: "Check" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("a normal session has no banner and a working form", async () => {
    installApi([done]);
    render(<Shell />);
    await screen.findByRole("link", { name: "Download the report" });
    expect(screen.queryByRole("note")).toBeNull();
    expect((screen.getByLabelText("Address to check") as HTMLInputElement).disabled).toBe(false);
  });

  it("an answer that cannot be read leaves the app as a normal session", async () => {
    const api = installApi([done]);
    api.session = "fails";
    render(<Shell />);
    await screen.findByRole("link", { name: "Download the report" });
    expect(screen.queryByRole("note")).toBeNull();
    expect((screen.getByLabelText("Address to check") as HTMLInputElement).disabled).toBe(false);
  });
});
