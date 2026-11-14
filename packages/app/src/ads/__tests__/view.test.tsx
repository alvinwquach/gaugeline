// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Shell } from "../../Shell";
import type { AdsData } from "../../types";
import { ADS_VIEWS, VIEWS, viewsFor } from "../../views";
import { Ads } from "../../views/Ads";
import {
  adsRun,
  doneRun,
  finding,
  installApi,
  installEventSource,
  result,
  runState,
} from "../../__tests__/helpers";

beforeEach(() => {
  installEventSource();
  window.location.hash = "";
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const SITE = "https://tapas-bar.example";
const ads: AdsData = {
  currencies: [
    {
      currency: "USD",
      destinations: [
        { url: `${SITE}/happy-hour`, ads: 5, spend: 120450 },
        { url: `${SITE}/book-a-table`, ads: 3, spend: 80000 },
        { url: `${SITE}/gift-cards`, ads: 3, spend: 15075 },
        { url: `${SITE}/old-menu`, ads: 1, spend: 99999 },
      ],
    },
  ],
};
const dead = finding({
  checkId: "page-dead",
  title: "The page does not load",
  url: `${SITE}/old-menu`,
  evidence: "404",
});
const lost = finding({
  checkId: "campaign-tags-lost",
  severity: "medium",
  title: "The campaign fields are lost",
  url: `${SITE}/gift-cards`,
});

const open = (over = {}) =>
  render(
    <Ads
      run={runState({
        kind: "ads",
        url: "ads-export.csv",
        result: result({ url: "ads-export.csv", findings: [dead, lost] }),
        ads,
        ...over,
      })}
    />,
  );

const rows = () =>
  within(screen.getByRole("table"))
    .getAllByRole("row")
    .slice(1)
    .map((r) =>
      within(r)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    );

describe("Ads: the summary and the table", () => {
  it("leads with the spend that went to pages with problems, out of the total", () => {
    open();
    expect(screen.getByRole("heading", { level: 1, name: "Ads" })).toBeTruthy();
    const summary = document.querySelector(".ads-summary");
    expect(summary?.textContent).toBe("$1,150.74 of $3,155.24 went to pages with problems.");
  });

  it("lists one row for each page: address, ads, spend, findings, the worst page first", () => {
    open();
    const heads = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(heads).toEqual(["Landing page", "Ads", "Spend", "Findings"]);
    const body = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(body.map((r) => within(r).getByRole("rowheader").textContent)).toEqual([
      `${SITE}/old-menu`,
      `${SITE}/gift-cards`,
      `${SITE}/happy-hour`,
      `${SITE}/book-a-table`,
    ]);
    expect(rows()).toEqual([
      ["1", "$999.99", "The page does not load"],
      ["3", "$150.75", "The campaign fields are lost"],
      ["5", "$1,204.50", "None"],
      ["3", "$800.00", "None"],
    ]);
  });

  it("a finding opens in Problems, on that finding", () => {
    open();
    const link = screen.getByRole("link", { name: "The campaign fields are lost" });
    expect(link.getAttribute("href")).toBe("#/run-1/problems/1");
  });

  it("an address is text, never a link", () => {
    open();
    expect(screen.queryByRole("link", { name: `${SITE}/old-menu` })).toBeNull();
    expect(within(screen.getByRole("table")).getAllByRole("link")).toHaveLength(2);
  });

  it("the filter shows only pages with problems and says how many", async () => {
    open();
    const user = userEvent.setup();
    const button = screen.getByRole("button", { name: "Only pages with problems (2)" });
    expect(button.getAttribute("aria-pressed")).toBe("false");
    await user.click(button);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("table").querySelector("caption")?.textContent).toBe(
      "Showing 2 of 4 pages",
    );
    expect(rows().map((r) => r[0])).toEqual(["1", "3"]);
    await user.click(button);
    expect(rows()).toHaveLength(4);
  });

  it("values from the export are text: markup in an address or a title is not parsed", () => {
    const evil = `${SITE}/<img src=x onerror=alert(1)>`;
    open({
      result: result({ findings: [finding({ url: evil, title: "<b>loud</b>" })] }),
      ads: { currencies: [{ currency: "USD", destinations: [{ url: evil, ads: 1, spend: 100 }] }] },
    });
    expect(screen.getByRole("table").querySelector("img, b")).toBeNull();
    expect(screen.getByText(evil)).toBeTruthy();
    expect(screen.getByText("<b>loud</b>")).toBeTruthy();
  });
});

describe("Ads: edge cases", () => {
  it("every page healthy: says no spend went to pages with problems, and still lists them", () => {
    open({ result: result({ url: "ads-export.csv" }) });
    expect(document.querySelector(".ads-summary")?.textContent).toBe(
      "No spend went to pages with problems. All $3,155.24 went to pages that looked right.",
    );
    expect(rows()).toHaveLength(4);
  });

  it("every page healthy: the filter says no page has a problem", async () => {
    open({ result: result() });
    await userEvent.setup().click(screen.getByRole("button", { name: /Only pages with problems/ }));
    expect(screen.getByText("No page has a problem.")).toBeTruthy();
  });

  it("mixed currencies: one section for each, each total in its own currency, never added", () => {
    open({
      result: result({ findings: [finding({ url: `${SITE}/a` })] }),
      ads: {
        currencies: [
          { currency: "USD", destinations: [{ url: `${SITE}/a`, ads: 2, spend: 100000 }] },
          { currency: "EUR", destinations: [{ url: `${SITE}/a`, ads: 1, spend: 70000 }] },
          { currency: "JPY", destinations: [{ url: `${SITE}/b`, ads: 1, spend: 5000 }] },
        ],
      },
    });
    expect(screen.getByText(/never added together/)).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      "USD",
      "EUR",
      "JPY",
    ]);
    const summaries = [...document.querySelectorAll(".ads-summary")].map((e) => e.textContent);
    expect(summaries).toEqual([
      "$1,000.00 of $1,000.00 went to pages with problems.",
      "€700.00 of €700.00 went to pages with problems.",
      "No spend went to pages with problems. All ¥5,000 went to pages that looked right.",
    ]);
  });

  it("a currency the export does not name is shown as a plain number", () => {
    open({
      result: result(),
      ads: {
        currencies: [{ currency: null, destinations: [{ url: `${SITE}/a`, ads: 1, spend: 1999 }] }],
      },
    });
    expect(document.querySelector(".ads-summary")?.textContent).toContain("19.99");
  });

  it("2,000 ads over 300 destinations: every row is drawn", () => {
    const destinations = Array.from({ length: 300 }, (_, i) => ({
      url: `${SITE}/p${String(i).padStart(3, "0")}`,
      ads: i < 200 ? 7 : 6,
      spend: 1000 + i,
    }));
    open({
      result: result({ findings: [finding({ url: `${SITE}/p007` })] }),
      ads: { currencies: [{ currency: "USD", destinations }] },
    });
    expect(rows()).toHaveLength(300);
    expect(destinations.reduce((n, d) => n + d.ads, 0)).toBe(2000);
    expect(rows()[0]?.[0]).toBe("7");
  });

  it("a finding about an address that is not a landing page is pointed to, not lost", () => {
    open({ result: result({ findings: [finding({ url: "https://elsewhere.example/" })] }) });
    expect(screen.getByText(/1 finding is about an address/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "See them in Problems" }).getAttribute("href")).toBe(
      "#/run-1/problems",
    );
  });

  it("an export with no ads that link anywhere says so", () => {
    open({ ads: { currencies: [] } });
    expect(screen.getByText(/no ads that link to a page/)).toBeTruthy();
  });

  it("while it runs, after a failure, and with no destinations kept, it says which", () => {
    const { rerender } = open({ state: "running", result: undefined, ads: undefined });
    expect(screen.getByText(/still being checked/)).toBeTruthy();
    rerender(<Ads run={runState({ kind: "ads", state: "failed", reason: "Nothing answered." })} />);
    expect(screen.getByText("Nothing answered.")).toBeTruthy();
    rerender(<Ads run={runState({ kind: "ads", result: result() })} />);
    expect(screen.getByText(/did not keep the list of landing pages/)).toBeTruthy();
    rerender(<Ads run={runState({ kind: "ads" })} />);
    expect(screen.getByText("Loading the results...")).toBeTruthy();
  });
});

describe("Ads in the shell", () => {
  const exportRun = adsRun(
    "ads-1",
    "ads-export.csv",
    result({ url: "ads-export.csv", findings: [dead, lost] }),
    ads,
  );
  const pageRun = doneRun("page-1", "https://tapas-bar.example/", result({ findings: [] }));

  it("the Ads view exists only for an ads run; page runs keep their five views and the three still to come", () => {
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
    expect(ADS_VIEWS.map((v) => v.id)).toEqual(["ads", "problems"]);
    expect(viewsFor({ kind: "ads" })).toBe(ADS_VIEWS);
    expect(viewsFor({ kind: "page" })).toBe(VIEWS);
    expect(viewsFor(undefined)).toBe(VIEWS);
  });

  it("an ads run opens on Ads, appears in the sidebar under the file's name, and has no Overview link", async () => {
    installApi([exportRun]);
    render(<Shell />);
    expect(await screen.findByRole("heading", { level: 1, name: "Ads" })).toBeTruthy();
    const sidebar = screen.getByRole("navigation", { name: "Pages checked this session" });
    expect(within(sidebar).getByText("ads-export.csv")).toBeTruthy();
    const views = screen.getByRole("navigation", { name: "Views" });
    expect(
      within(views)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["Ads", "Problems"]);
  });

  it("a session with only page runs shows no Ads link", async () => {
    installApi([pageRun]);
    render(<Shell />);
    await screen.findByRole("heading", { level: 1, name: "Overview" });
    expect(screen.queryByRole("link", { name: "Ads" })).toBeNull();
  });

  it("opening a finding from the table lands in Problems on that finding", async () => {
    installApi([exportRun]);
    render(<Shell />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("link", { name: "The page does not load" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Problems" })).toBeTruthy();
    expect(
      await screen.findByRole("button", { name: "The page does not load", expanded: true }),
    ).toBeTruthy();
    expect(window.location.hash).toBe("#/ads-1/problems/0");
  });

  it("the sidebar link to an ads run goes to a view it has", async () => {
    installApi([pageRun, exportRun]);
    window.location.hash = "#/page-1/pages";
    render(<Shell />);
    await screen.findByRole("heading", { level: 1, name: "Pages checked" });
    const link = screen.getByRole("link", { name: /ads-export\.csv/ });
    expect(link.getAttribute("href")).toBe("#/ads-1/ads");
    await userEvent.setup().click(link);
    expect(await screen.findByRole("heading", { level: 1, name: "Ads" })).toBeTruthy();
  });

  it("an address that names the Ads view for a page run opens that run's first view", async () => {
    installApi([pageRun]);
    window.location.hash = "#/page-1/ads";
    render(<Shell />);
    expect(await screen.findByRole("heading", { level: 1, name: "Overview" })).toBeTruthy();
    await vi.waitFor(() => expect(window.location.hash).toBe("#/page-1/overview"));
  });

  it("the download is hidden for an ads run with no report, and offered when the server has one", async () => {
    installApi([exportRun]);
    const first = render(<Shell />);
    await screen.findByRole("heading", { level: 1, name: "Ads" });
    expect(screen.queryByRole("link", { name: "Download the report" })).toBeNull();
    first.unmount();
    window.location.hash = "";
    installApi([{ ...exportRun, hasReport: true }]);
    render(<Shell />);
    const link = await screen.findByRole("link", { name: "Download the report" });
    expect(link.getAttribute("href")).toBe("/api/runs/ads-1/report");
  });
});
