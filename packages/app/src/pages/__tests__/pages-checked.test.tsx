// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { checkedOf, request, result, runState, finding } from "../../__tests__/helpers";
import { PagesChecked } from "../../views/PagesChecked";
import type { RequestRow } from "../../types";

afterEach(cleanup);

const URL_ = "https://shop.example";
const mixed: RequestRow[] = [
  request({ url: `${URL_}/`, kind: "page" }),
  request({ url: `${URL_}/a`, kind: "link", method: "HEAD", status: 301, location: `${URL_}/b` }),
  request({ url: `${URL_}/b`, kind: "link", method: "HEAD", status: 200 }),
  request({ url: `${URL_}/gone`, kind: "link", method: "HEAD", status: 404 }),
  request({ url: `${URL_}/img/a.png`, kind: "image", method: "HEAD", status: 200 }),
  request({ url: `${URL_}/app.js`, kind: "script", status: 200 }),
  request({ url: `${URL_}/slow`, kind: "link", method: "HEAD", status: null, error: "timeout" }),
];

const view = (requests: RequestRow[] = mixed, over = {}) =>
  render(
    <PagesChecked
      run={runState({
        result: result({
          sampled: { links: { seen: 52, taken: 24, limit: 30 } },
        }),
        checked: checkedOf({ requests }),
        ...over,
      })}
    />,
  );
const table = () => screen.getByRole("table");
const bodyRows = () => within(table()).getAllByRole("row").slice(1);

describe("the Pages checked view", () => {
  it("is a real table: a caption, column headers with scope, and each address a row header in a code element", () => {
    view();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Pages checked");
    expect(within(table()).getByText(/Showing 7 of 7 addresses/).tagName).toBe("CAPTION");
    const heads = within(table()).getAllByRole("columnheader");
    expect(heads.map((h) => h.textContent)).toEqual([
      "Address",
      "Kind",
      "Request",
      "Answer",
      "Time",
    ]);
    expect(heads.every((h) => h.getAttribute("scope") === "col")).toBe(true);
    const first = bodyRows()[0] as HTMLElement;
    const cell = within(first).getByRole("rowheader");
    expect(cell.getAttribute("scope")).toBe("row");
    expect(cell.querySelector("code")?.textContent).toBe(`${URL_}/`);
  });

  it("lists the rows by kind, then in the order given, with the answer phrase", () => {
    view();
    expect(
      bodyRows().map((r) => [
        within(r).getByRole("rowheader").textContent,
        within(r).getAllByRole("cell")[2]?.textContent,
      ]),
    ).toEqual([
      [`${URL_}/`, "Loaded"],
      [`${URL_}/a`, `Moved to ${URL_}/b`],
      [`${URL_}/b`, "Loaded"],
      [`${URL_}/gone`, "Not found"],
      [`${URL_}/slow`, "No answer"],
      [`${URL_}/img/a.png`, "Loaded"],
      [`${URL_}/app.js`, "Loaded"],
    ]);
  });

  it("addresses are text: no link, no button in the table, so a stray click cannot leave the app", () => {
    view();
    expect(within(table()).queryAllByRole("link")).toHaveLength(0);
    expect(within(table()).queryAllByRole("button")).toHaveLength(0);
    expect(table().querySelectorAll("a, [onclick]")).toHaveLength(0);
  });

  it("an address with a javascript: scheme is shown as text and is not clickable", () => {
    view([request({ url: "javascript:alert(1)", kind: "link" })]);
    const code = within(table()).getByText("javascript:alert(1)");
    expect(code.tagName).toBe("CODE");
    expect(code.closest("a")).toBeNull();
    expect(within(table()).queryAllByRole("link")).toHaveLength(0);
  });

  it("'Only problems' hides the rows that ended in a 2xx, and the caption count follows", async () => {
    const user = userEvent.setup();
    view();
    const button = screen.getByRole("button", { name: /^Only problems/ });
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.textContent).toBe("Only problems (3)");
    await user.click(button);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(bodyRows().map((r) => within(r).getByRole("rowheader").textContent)).toEqual([
      `${URL_}/a`,
      `${URL_}/gone`,
      `${URL_}/slow`,
    ]);
    expect(within(table()).getByText(/Showing 3 of 7 addresses/).tagName).toBe("CAPTION");
    await user.click(button);
    expect(bodyRows()).toHaveLength(7);
    expect(within(table()).getByText(/Showing 7 of 7 addresses/)).toBeTruthy();
  });

  it("with nothing to show under 'Only problems' it says everything loaded, and keeps the count", async () => {
    const user = userEvent.setup();
    view([request(), request({ url: `${URL_}/b`, kind: "link", status: 200 })]);
    await user.click(screen.getByRole("button", { name: /^Only problems/ }));
    expect(screen.getByText("Every address loaded.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText(/Showing 0 of 2 addresses/)).toBeTruthy();
  });

  it("a request that was not followed says why, in words", () => {
    view([
      request({
        url: "http://10.0.0.5/x",
        kind: "link",
        status: null,
        error: "private-address-refused",
      }),
    ]);
    expect(within(table()).getByText("Not followed (private address)")).toBeTruthy();
  });

  it("the footer states what was read against the published limits", () => {
    view();
    const footer = screen.getByText(/24 of up to 30 same-site links \(52 found\)/);
    expect(footer.closest(".table-footer")).not.toBeNull();
  });

  it("the full limits make about 95 rows in one table, each kind in its place", () => {
    const counts = [
      ["page", 1],
      ["link", 30],
      ["image", 20],
      ["sitemap", 25],
      ["feed", 3],
      ["script", 15],
    ] as const;
    view(
      counts.flatMap(([kind, n]) =>
        Array.from({ length: n }, (_, i) => request({ kind, url: `${URL_}/${kind}/${i}` })),
      ),
    );
    expect(bodyRows()).toHaveLength(94);
    expect(within(table()).getByText(/Showing 94 of 94 addresses/)).toBeTruthy();
    expect(table().querySelectorAll("colgroup col")).toHaveLength(5);
  });

  it("an address in a right-to-left script keeps its direction", () => {
    view([request({ url: `${URL_}/\u05E9\u05DC\u05D5\u05DD`, kind: "link" })]);
    expect(within(table()).getByRole("rowheader").querySelector("code")?.getAttribute("dir")).toBe(
      "auto",
    );
  });

  it("an address with markup in it is text", () => {
    view([request({ url: `${URL_}/</script><script>alert(1)</script>`, kind: "link" })]);
    expect(table().querySelectorAll("script")).toHaveLength(0);
    expect(within(table()).getByRole("rowheader").textContent).toContain("</script><script>");
  });

  it("says so when the run is still going, failed, not loaded, or recorded no list", () => {
    const { rerender } = render(<PagesChecked run={runState({ state: "running" })} />);
    expect(screen.getByText(/still checking/i)).toBeTruthy();
    rerender(
      <PagesChecked run={runState({ state: "failed", reason: "The site did not answer." })} />,
    );
    expect(screen.getByText("The site did not answer.")).toBeTruthy();
    rerender(<PagesChecked run={runState({ state: "done", loadError: "Lost the connection." })} />);
    expect(screen.getByText("Lost the connection.")).toBeTruthy();
    rerender(<PagesChecked run={runState({ state: "done", result: result() })} />);
    expect(screen.getByText(/did not keep a list of its addresses/i)).toBeTruthy();
    rerender(
      <PagesChecked run={runState({ state: "done", checked: checkedOf({ requests: [] }) })} />,
    );
    expect(screen.getByText("No addresses were requested.")).toBeTruthy();
  });

  it("starts over for another run", async () => {
    const user = userEvent.setup();
    const a = runState({ id: "a", checked: checkedOf({ requests: mixed }) });
    const { rerender } = render(<PagesChecked run={a} />);
    await user.click(screen.getByRole("button", { name: /^Only problems/ }));
    rerender(<PagesChecked run={{ ...a, id: "b" }} />);
    expect(
      screen.getByRole("button", { name: /^Only problems/ }).getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("does not use the findings: the table needs only the addresses", () => {
    view(mixed, { result: result({ findings: [finding()] }) });
    expect(bodyRows()).toHaveLength(7);
  });
});
