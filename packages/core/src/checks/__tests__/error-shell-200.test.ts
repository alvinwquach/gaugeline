import { describe, expect, it } from "vitest";
import { buildSnapshot, type PageSnapshot } from "../../snapshot.js";
import { UNREAD_REASON, errorShell200 } from "../error-shell-200.js";
import { createPageRegistry } from "../index.js";
import type { CheckContext } from "../../model.js";
import { URL0, ctx, page } from "./helpers.js";

/** Harbour Lane Books is an invented bookshop. */
function html(
  url: string,
  body: string,
  over: { status?: number; type?: string; truncated?: boolean } = {},
): PageSnapshot {
  return buildSnapshot([
    {
      url,
      status: over.status ?? 200,
      headers: { "content-type": over.type ?? "text/html" },
      body,
      ms: 1,
      ...(over.truncated ? { truncated: true } : {}),
    },
  ]);
}

const nextShell = html(
  "https://harbour.example/events/readings",
  '<!DOCTYPE html><html id="__next_error__"><head><title>Events</title></head><body><h1>This page couldn\'t load</h1></body></html>',
);
const goodPage = html(
  "https://harbour.example/books/tide",
  `<html><head><title>Tide and Thistle</title></head><body><h1>Tide and Thistle</h1><p>${"word ".repeat(200)}</p></body></html>`,
);

describe("error-shell-200: unit", () => {
  it("is registered with the other page checks", () => {
    expect(
      createPageRegistry()
        .all()
        .map((c) => c.id),
    ).toContain("error-shell-200");
  });

  it("passes a page with content", async () => {
    expect(await errorShell200.run(goodPage, ctx)).toEqual([]);
  });

  it("finds a framework error page, evidence names the kind and never the page's words", async () => {
    const found = await errorShell200.run(nextShell, ctx);
    expect(found).toEqual([
      {
        checkId: "error-shell-200",
        severity: "high",
        title: "A page that is an error says everything is fine",
        evidence:
          "answers 200 but shows the Next.js error page (an html element with the id __next_error__)",
        url: "https://harbour.example/events/readings",
      },
    ]);
  });

  it("judges only 2xx HTML: a real 404 is the right answer and a PDF is not a page", async () => {
    const real404 = html(
      "https://harbour.example/x",
      "<html><head><title>Page not found</title></head></html>",
      { status: 404 },
    );
    const pdf = html("https://harbour.example/y", "<html><title>Page not found</title></html>", {
      type: "application/pdf",
    });
    expect(await errorShell200.run(real404, ctx)).toEqual([]);
    expect(await errorShell200.run(pdf, ctx)).toEqual([]);
  });

  it("reads every page the run already fetched, not only the checked one", async () => {
    const withPages: CheckContext = {
      warn: () => undefined,
      pages: async () => [goodPage, nextShell],
    };
    const found = await errorShell200.run(goodPage, withPages);
    expect(found.map((f) => f.url)).toEqual(["https://harbour.example/events/readings"]);
  });

  it("makes no request of its own", async () => {
    const calls: string[] = [];
    const spy: CheckContext = {
      warn: () => undefined,
      fetcher: new Proxy({}, { get: (_t, k) => () => calls.push(String(k)) }) as never,
    };
    await errorShell200.run(page(), spy);
    expect(calls).toEqual([]);
  });

  it("lists a cut body with no marker as could not check, never as a pass", async () => {
    const notes: [string, string][] = [];
    const cut = html("https://harbour.example/z", "<html><head><title>Menu</title></head><body>", {
      truncated: true,
    });
    const found = await errorShell200.run(cut, {
      warn: () => undefined,
      couldNotCheck: (u, r) => notes.push([u, r]),
    });
    expect(found).toEqual([]);
    expect(notes).toEqual([["https://harbour.example/z", UNREAD_REASON]]);
  });

  it("does not flag a real article titled 'Page not found: a history'", async () => {
    const article = html(
      URL0,
      `<html><head><title>Page not found: a history</title></head><body><h1>Page not found: a history</h1><p>${"word ".repeat(900)}</p></body></html>`,
    );
    expect(await errorShell200.run(article, ctx)).toEqual([]);
  });

  it("finds a Spanish and a French not-found title on a short page", async () => {
    for (const title of [
      "P\u00E1gina no encontrada | Librer\u00EDa Faro",
      "Page introuvable - Librairie du Port",
    ]) {
      const p = html(
        URL0,
        `<html><head><title>${title}</title></head><body><h1>Oups</h1><p>Retour</p></body></html>`,
      );
      expect((await errorShell200.run(p, ctx)).map((f) => f.checkId)).toEqual(["error-shell-200"]);
    }
  });

  it("handles a 6 MB hostile body without hanging", async () => {
    const big = page({ title: "Shop", contentWordCount: 20 });
    big.hops = [{ ...big.hops[0]!, body: "<div ".repeat(1_200_000) }];
    const t0 = Date.now();
    expect(await errorShell200.run(big, ctx)).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});
