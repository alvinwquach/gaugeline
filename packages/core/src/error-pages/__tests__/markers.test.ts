import { describe, expect, it } from "vitest";
import { page } from "../../checks/__tests__/helpers.js";
import { classifyErrorShell, ERROR_SHELL_BODY_MAX, SHELL_LABEL } from "../markers.js";

/** A page whose first hop carries `body`, with the words the snapshot would have counted. */
function withBody(body: string, over: Parameters<typeof page>[0] = {}) {
  const p = page({ contentWordCount: 12, wordCount: 12, ...over });
  p.hops = [{ ...p.hops[0]!, body }];
  return p;
}

describe("classifyErrorShell: framework shells", () => {
  it("reads the Next.js error page by the id on its html element", () => {
    const p = withBody('<!DOCTYPE html><html id="__next_error__" lang="en"><body>x</body></html>');
    expect(classifyErrorShell(p)).toEqual({ kind: "next-error-page" });
  });

  it("does not read an id that only appears in the body text of a long page", () => {
    const p = withBody('<html lang="en"><body><p>the id __next_error__ on html</p></body></html>');
    expect(classifyErrorShell(p)).toEqual({});
  });

  it("reads the Next.js client exception text on a short page", () => {
    const p = withBody("<html><body></body></html>", {
      visibleText:
        "Application error: a client-side exception has occurred (see the browser console)",
    });
    expect(classifyErrorShell(p).kind).toBe("next-client-exception");
  });

  it("does not read the same text in a long article about the error", () => {
    const p = withBody("<html><body></body></html>", {
      contentWordCount: 900,
      visibleText:
        "Why you see Application error: a client-side exception has occurred in production",
    });
    expect(classifyErrorShell(p)).toEqual({});
  });

  it("reads the Nuxt error page: a status title and its back-home link", () => {
    const p = withBody('<html><body><a data-back-home href="/">Go back home</a></body></html>', {
      title: "404 - Page not found | Hartley Joinery",
    });
    expect(classifyErrorShell(p).kind).toBe("nuxt-error-page");
  });

  it("does not read a status-looking title without the Nuxt link", () => {
    const p = withBody("<html><body>menu</body></html>", { title: "404 - Page not found | Cafe" });
    expect(classifyErrorShell(p).kind).toBe("error-title");
  });

  it("reads the SvelteKit error template: a status span and the message as heading and title", () => {
    const p = withBody(
      '<html><body><span class="status">500</span><div class="message"><h1>Internal Error</h1></div></body></html>',
      { title: "Internal Error", headings: [{ level: 1, text: "Internal Error" }] },
    );
    expect(classifyErrorShell(p).kind).toBe("sveltekit-error-page");
  });

  it("reads the React Router default error boundary text on a short page", () => {
    const p = withBody("<html><body></body></html>", {
      visibleText: "Unexpected Application Error! 404 Not Found",
    });
    expect(classifyErrorShell(p).kind).toBe("react-router-error-boundary");
  });
});

describe("classifyErrorShell: generic titles and headings", () => {
  const title = (t: string, words = 12) =>
    classifyErrorShell(withBody("<html></html>", { title: t, contentWordCount: words }));

  it.each([
    "Page not found",
    "404",
    "404 Not Found",
    "Error 404",
    "404: Page not found",
    "Oops! Page not found",
    "Page Not Found | Harbour Lane Books",
    "Harbour Lane Books - Page not found",
    "Something went wrong",
    "Internal Server Error",
    "P\u00E1gina no encontrada",
    "Page introuvable",
    "Seite nicht gefunden",
    "Pagina non trovata",
    "P\u00E1gina n\u00E3o encontrada",
    "Pagina niet gevonden",
  ])("reads %j as an error title on a short page", (t) => {
    expect(title(t).kind).toBe("error-title");
  });

  it.each(["Home", "Not found? Ask the librarian", "Menu | Bar 404", "Our story"])(
    "does not read %j",
    (t) => {
      expect(title(t)).toEqual({});
    },
  );

  it("does not read a real article titled 'Page not found: a history'", () => {
    expect(title("Page not found: a history", 12)).toEqual({});
    expect(title("Page not found: a history", 1800)).toEqual({});
  });

  it("does not read an error title on a page with a full page of words", () => {
    expect(title("Page not found", 400)).toEqual({});
  });

  it("reads the first h1 when the title says nothing", () => {
    const p = withBody("<html></html>", {
      title: "Harbour Lane Books",
      headings: [
        { level: 1, text: "Sorry, this page does not exist" },
        { level: 1, text: "Home" },
      ],
    });
    expect(classifyErrorShell(p)).toEqual({});
    const q = withBody("<html></html>", {
      title: "Harbour Lane Books",
      headings: [{ level: 1, text: "Page not found" }],
    });
    expect(classifyErrorShell(q).kind).toBe("error-heading");
  });

  it("never reports the page's own words: the result holds a kind and nothing else", () => {
    const r = title("Page not found | Secret Client Name Ltd");
    expect(Object.keys(r)).toEqual(["kind"]);
    expect(SHELL_LABEL[r.kind!]).not.toMatch(/Secret/);
  });
});

describe("classifyErrorShell: edge cases", () => {
  it("is unread when the body was cut and nothing was found", () => {
    const p = withBody("<html><body>menu", { title: "Menu" });
    p.hops[0] = { ...p.hops[0]!, truncated: true };
    expect(classifyErrorShell(p)).toEqual({ unread: true });
  });

  it("still reports a marker found in a body that was cut", () => {
    const p = withBody('<html id="__next_error__"><body>', {});
    p.hops[0] = { ...p.hops[0]!, truncated: true };
    expect(classifyErrorShell(p).kind).toBe("next-error-page");
  });

  it("scans a hostile multi-megabyte body in bounded time and finds no marker past the cap", () => {
    const filler = "<div ".repeat(1_000_000);
    const p = withBody(`<html>${filler}<body data-back-home></body>`, {
      title: "404 - Page not found | x",
    });
    const t0 = Date.now();
    const r = classifyErrorShell(p);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(filler.length).toBeGreaterThan(ERROR_SHELL_BODY_MAX);
    expect(r.kind).toBe("error-title");
  });

  it("handles a pathological title of many separators without hanging", () => {
    const t = "a | ".repeat(50_000);
    const t0 = Date.now();
    expect(classifyErrorShell(withBody("<html></html>", { title: t }))).toEqual({});
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it("returns nothing for a page with no title, no heading and no body", () => {
    const p = page({ contentWordCount: 5 });
    delete (p as { title?: string }).title;
    expect(classifyErrorShell(p)).toEqual({});
  });
});
