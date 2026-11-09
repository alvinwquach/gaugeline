// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { VIEWS } from "../../views";
import { LeaksAccess } from "../../views/LeaksAccess";
import type { Result } from "../../types";
import { checkedOf, finding, result, runState } from "../../__tests__/helpers";
import { ELLIPSIS, MASKED, PLANTED_KEY, keyFinding, publicDataset, script } from "./helpers";

afterEach(cleanup);

const ALL_RAN = [
  "dataset-public",
  "dataset-private-types",
  "secret-in-js",
  "temp-host-links",
  "temp-host-canonical",
  "staging-indexable",
];

const panel = (name: string) => {
  const heading = screen.getByRole("heading", { name });
  return within(heading.closest("section") as HTMLElement);
};
const open = (r: Result, leaks = {}, extra = {}) =>
  render(
    <LeaksAccess
      run={runState({
        result: r,
        checked: checkedOf({
          leaks: { datasets: [], scripts: [], previews: [], ...leaks },
          ...extra,
        }),
      })}
    />,
  );

describe("the view in the app", () => {
  it("is registered after Search data", () => {
    expect(VIEWS.map((v) => v.id)).toContain("leaks");
    expect(VIEWS.find((v) => v.id === "leaks")?.label).toBe("Leaks & access");
  });
});

describe("Leaks & access: structure", () => {
  it("has one h1, the four panels in order, and the sample in the footer", () => {
    open(result({ passed: ALL_RAN }), { datasets: [publicDataset()], scripts: [script("/a.js")] });
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      "Sanity dataset",
      "Types it holds",
      "JavaScript scanned for keys",
      "Staging copies",
    ]);
    expect(screen.getByText("1 of up to 15 JavaScript files scanned")).toBeTruthy();
  });

  it("each panel says what was read, in the words of the privacy page", () => {
    open(result({ passed: ALL_RAN }), { datasets: [publicDataset()], scripts: [script("/a.js")] });
    const said = "Only the number of documents and the names of their types. Never their contents.";
    expect(panel("Sanity dataset").getByText(new RegExp(said))).toBeTruthy();
    expect(panel("Types it holds").getByText(new RegExp(said))).toBeTruthy();
    expect(panel("JavaScript scanned for keys").getByText(/masked/i)).toBeTruthy();
    expect(panel("Staging copies").getByText(/read/i)).toBeTruthy();
  });
});

describe("Leaks & access: the dataset", () => {
  it("a site with no Sanity says so in one line and has no type panel", () => {
    open(result({ passed: ALL_RAN }));
    expect(panel("Sanity dataset").getByText("This page does not use Sanity.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Types it holds" })).toBeNull();
  });

  it("a public dataset shows project, dataset, type names and the document count", () => {
    open(result({ passed: ALL_RAN }), { datasets: [publicDataset()] });
    const dataset = panel("Sanity dataset");
    expect(dataset.getByText("ab12cd34")).toBeTruthy();
    expect(dataset.getByText("production")).toBeTruthy();
    expect(dataset.getByText(/Public/)).toBeTruthy();
    const types = panel("Types it holds");
    expect(types.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "author",
      "category",
      "page",
      "post",
      "product",
      "siteSettings",
    ]);
    expect(types.getByText("412 documents in 6 types")).toBeTruthy();
  });

  it("a private dataset shows Private and no type panel", () => {
    open(result({ passed: ALL_RAN }), {
      datasets: [{ projectId: "ab12cd34", dataset: "production", state: "private" }],
    });
    expect(panel("Sanity dataset").getByText(/Private/)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Types it holds" })).toBeNull();
  });

  it("a dataset that could not be read is not shown as private or as fine", () => {
    open(result({ passed: ALL_RAN }), {
      datasets: [{ projectId: "ab12cd34", dataset: "production", state: "unknown" }],
    });
    const dataset = panel("Sanity dataset");
    expect(dataset.getByText(/could not be read/i)).toBeTruthy();
    expect(dataset.queryByText(/Private/)).toBeNull();
  });

  it("links the finding about a dataset into Problems", () => {
    const f = finding({
      checkId: "dataset-public",
      evidence: 'project ab12cd34, dataset "production": 412 documents in 6 types (a)',
    });
    open(result({ findings: [finding(), f], passed: ALL_RAN }), { datasets: [publicDataset()] });
    const link = within(
      panel("Sanity dataset").getByRole("link", { name: /finding/i }) as HTMLElement,
    );
    expect(link).toBeTruthy();
    expect(
      panel("Sanity dataset")
        .getByRole("link", { name: /finding/i })
        .getAttribute("href"),
    ).toBe("#/run-1/problems/1");
  });

  it("type names with HTML in them are shown as text", () => {
    const types = ['<img src=x onerror="alert(1)">', "<script>alert(2)</script>"];
    const { container } = open(result({ passed: ALL_RAN }), {
      datasets: [publicDataset({ types, count: 2 })],
    });
    const list = panel("Types it holds").getAllByRole("listitem");
    expect(list.map((li) => li.textContent)).toEqual(types);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
  });

  it("200 types sit in a list that scrolls inside its panel", () => {
    const types = Array.from({ length: 200 }, (_, i) => `type${i}`);
    open(result({ passed: ALL_RAN }), { datasets: [publicDataset({ types, count: 900 })] });
    const list = panel("Types it holds").getByRole("list");
    expect(list.classList.contains("type-list")).toBe(true);
    expect(within(list).getAllByRole("listitem")).toHaveLength(200);
  });
});

describe("Leaks & access: JavaScript scanned for keys", () => {
  it("a finding shows the kind, the masked value and a link, and the full key is nowhere in the page", () => {
    const { container } = open(
      result({
        findings: [keyFinding("/assets/chunk-2.js")],
        passed: ALL_RAN.filter((i) => i !== "secret-in-js"),
      }),
      { scripts: [script("/assets/chunk-1.js"), script("/assets/chunk-2.js")] },
    );
    const rows = within(panel("JavaScript scanned for keys").getByRole("table")).getAllByRole(
      "row",
    );
    const [, first, second] = rows;
    expect(first?.textContent).toContain("Nothing found");
    expect(second?.textContent).toContain("Stripe secret key");
    expect(second?.textContent).toContain(MASKED);
    expect(
      within(second as HTMLElement)
        .getByRole("link")
        .getAttribute("href"),
    ).toBe("#/run-1/problems/0");
    expect(container.textContent).not.toContain(PLANTED_KEY);
    expect(MASKED).toContain(ELLIPSIS);
  });

  it("two keys in one file: two entries, each with its own link", () => {
    open(
      result({
        findings: [keyFinding("/a.js", 5), keyFinding("/a.js", 9, `rk_liv${ELLIPSIS}7Q`)],
        passed: ALL_RAN.filter((i) => i !== "secret-in-js"),
      }),
      { scripts: [script("/a.js")] },
    );
    const row = within(panel("JavaScript scanned for keys").getByRole("table")).getAllByRole(
      "row",
    )[1] as HTMLElement;
    expect(within(row).getAllByRole("listitem")).toHaveLength(2);
    expect(
      within(row)
        .getAllByRole("link")
        .map((a) => a.getAttribute("href")),
    ).toEqual(["#/run-1/problems/0", "#/run-1/problems/1"]);
  });

  it("more than 15 files on the page: 15 rows and a line saying the rest were not scanned", () => {
    const files = Array.from({ length: 15 }, (_, i) => script(`/a/${i}.js`));
    open(result({ passed: ALL_RAN, sampled: { scripts: { seen: 21, taken: 15, limit: 15 } } }), {
      scripts: files,
    });
    const table = panel("JavaScript scanned for keys").getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(16);
    expect(screen.getByText("15 of up to 15 JavaScript files scanned")).toBeTruthy();
    expect(screen.getByText(/6 more JavaScript files on the page were not scanned/)).toBeTruthy();
  });

  it("a file that could not be read says so instead of Nothing found", () => {
    open(result({ passed: ALL_RAN }), { scripts: [script("/gone.js", { status: 404 })] });
    const row = within(panel("JavaScript scanned for keys").getByRole("table")).getAllByRole(
      "row",
    )[1];
    expect(row?.textContent).toContain("Not scanned");
    expect(row?.textContent).not.toContain("Nothing found");
    expect(screen.getByText("0 of up to 15 JavaScript files scanned")).toBeTruthy();
  });

  it("addresses are text: no link goes anywhere but Problems", () => {
    const { container } = open(result({ passed: ALL_RAN }), {
      scripts: [script("/a.js")],
      previews: ["https://shop-git-main.vercel.app/"],
    });
    for (const a of container.querySelectorAll("a")) expect(a.getAttribute("href")).toMatch(/^#\//);
  });
});

describe("Leaks & access: staging copies", () => {
  it("lists a staging address that answers, with the finding", () => {
    open(
      result({
        findings: [
          finding({
            checkId: "staging-indexable",
            evidence:
              "https://staging.shop.example/ answers 200 with no noindex in meta robots or X-Robots-Tag",
          }),
        ],
        passed: ALL_RAN.filter((i) => i !== "staging-indexable"),
      }),
    );
    const row = within(panel("Staging copies").getByRole("table")).getAllByRole("row")[1];
    expect(row?.textContent).toContain("https://staging.shop.example/");
    expect(row?.textContent).toContain("Answers publicly");
    expect(
      within(row as HTMLElement)
        .getByRole("link")
        .getAttribute("href"),
    ).toBe("#/run-1/problems/0");
  });

  it("nothing found says so in a line, not as a table", () => {
    open(result({ passed: ALL_RAN }));
    expect(panel("Staging copies").queryByRole("table")).toBeNull();
    expect(panel("Staging copies").getByText(/No preview links/)).toBeTruthy();
  });
});

describe("Leaks & access: a check that did not run", () => {
  const refused = result({
    couldNotCheck: [
      "dataset-public",
      "dataset-private-types",
      "secret-in-js",
      "temp-host-links",
    ].map((id) => ({
      id,
      reason: "the page refused the request (status 403)",
      url: "https://shop.example/",
    })),
  });

  it("shows the reason in the result for each panel and no success state", () => {
    const { container } = open(refused);
    for (const name of ["Sanity dataset", "JavaScript scanned for keys", "Staging copies"])
      expect(panel(name).getByText(/the page refused the request \(status 403\)/)).toBeTruthy();
    expect(container.textContent).not.toMatch(/Nothing found|does not use Sanity|No preview links/);
    expect(container.querySelector(".all-clear")).toBeNull();
    expect(screen.queryByText(/of up to 15 JavaScript files scanned/)).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("a check that is in no list is said not to have run", () => {
    open(result());
    expect(panel("Sanity dataset").getByText(/did not run/)).toBeTruthy();
  });
});

describe("Leaks & access: before there is a result", () => {
  it("a running check says it is still checking", () => {
    render(<LeaksAccess run={runState({ state: "running" })} />);
    expect(screen.getByText(/still checking/)).toBeTruthy();
  });

  it("a server that sent no lists says so, and keeps what the findings say", () => {
    render(
      <LeaksAccess
        run={runState({
          result: result({
            findings: [keyFinding("/assets/app.js")],
            passed: ALL_RAN.filter((i) => i !== "secret-in-js"),
          }),
          checked: { page: checkedOf().page },
        })}
      />,
    );
    expect(screen.getByText(/did not keep the list of files/)).toBeTruthy();
    expect(screen.getByText(MASKED, { exact: false })).toBeTruthy();
  });
});
