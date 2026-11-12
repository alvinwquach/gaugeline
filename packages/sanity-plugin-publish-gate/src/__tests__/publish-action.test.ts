// @vitest-environment jsdom
/// <reference lib="dom" />
import { createElement, type ReactNode } from "react";
import { act, cleanup, render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gateRequestHandler } from "../function.js";
import { publishGate } from "../plugin.js";
import { SITE, barSite, downSite, memorySite } from "./helpers.js";

afterEach(cleanup);

const FN = "https://gate.lantern-yard.example/check";
const STUDIO = "https://lantern-yard.sanity.studio";
const pages = { page: "/{slug}", siteSettings: null } as const;

const draft = (rev: string, slug: unknown = { current: "menu" }) => ({
  _id: "drafts.menu-page",
  _type: "page",
  _rev: rev,
  slug,
});
const propsFor = (doc: ReturnType<typeof draft> | null, type = "page") => ({
  id: "menu-page",
  type,
  draft: doc,
  published: null,
  onComplete: () => undefined,
});

interface Description {
  label: string;
  disabled?: boolean;
  tone?: string;
  title?: ReactNode;
  onHandle?: () => void;
  dialog?: {
    type: string;
    message?: ReactNode;
    onConfirm?: () => void;
    onCancel?: () => void;
    confirmButtonText?: string;
  } | null;
}

/** Sanity's own Publish action, as far as the gate sees it: a label, a handler and a name. */
function fakeSanity() {
  const published = vi.fn();
  /** Sanity can disable Publish at any moment (validation errors arrive, the document is published elsewhere). */
  const sanity = { disabled: false };
  const Publish = Object.assign(
    (): Description => ({
      label: "Publish",
      onHandle: published,
      tone: "positive",
      ...(sanity.disabled ? { disabled: true } : {}),
    }),
    { action: "publish", displayName: "PublishAction" },
  );
  const Delete = Object.assign((): Description => ({ label: "Delete" }), { action: "delete" });
  return { published, Publish, Delete, sanity };
}

/** The Studio, the Function and the bar's site, wired together in memory. */
function world(
  over: { body?: string; down?: boolean; failOpen?: boolean; delay?: Promise<void> } = {},
) {
  const site = { body: over.body ?? '<a href="/menu/old-cocktails">Old cocktails</a>' };
  const seen: { method: string; url: string }[] = [];
  const handler = gateRequestHandler({
    site: SITE,
    allowOrigin: STUDIO,
    cacheMs: 0,
    now: () => new Date("2026-11-12T10:00:00Z"),
    transport: (url, req) =>
      over.down ? downSite(url, req) : memorySite(barSite(site.body), seen)(url, req),
  });
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    await over.delay;
    return handler(new Request(String(url), { headers: { origin: STUDIO } }));
  }) as typeof globalThis.fetch;
  const { published, Publish, Delete, sanity } = fakeSanity();
  const plugin = publishGate({
    site: SITE,
    functionUrl: FN,
    pages,
    fetch,
    ...(over.failOpen ? { failOpen: true } : {}),
  });
  const [Gated, Other] = plugin.document.actions([Publish, Delete], { schemaType: "page" });
  const mount = (doc = draft("r1"), type = "page") =>
    renderHook((p: ReturnType<typeof propsFor>) => (Gated as (p: unknown) => Description)(p), {
      initialProps: propsFor({ ...doc, _type: type }, type),
    });
  return { site, calls, seen, published, sanity, plugin, Gated, Other, Delete, Publish, mount };
}

const click = async (r: { current: Description }) => {
  await act(async () => {
    r.current.onHandle?.();
  });
};
/** The dialog's message drawn as the Studio would draw it. */
const draw = (d: Description) => render(createElement("div", null, d.dialog?.message));

describe("publishGate: the plugin", () => {
  it("replaces Sanity's Publish action and leaves every other action as it was", () => {
    const { Other, Delete, Gated, Publish } = world();
    expect(Other).toBe(Delete);
    expect(Gated).not.toBe(Publish);
    expect((Gated as { action?: string }).action).toBe("publish");
  });

  it("is a plugin with a name and a document actions resolver", () => {
    const { plugin } = world();
    expect(plugin.name).toBe("sanity-plugin-publish-gate");
    expect(typeof plugin.document.actions).toBe("function");
  });

  it.each([
    ["no Function address", { functionUrl: "" }],
    ["an http Function address", { functionUrl: "http://gate.lantern-yard.example/check" }],
    ["a wildcard Function address", { functionUrl: "https://*.lantern-yard.example/check" }],
    ["a Function address with a password", { functionUrl: "https://a:b@gate.example/check" }],
    ["no site", { site: "" }],
    ["a site that is not http", { site: "ftp://lantern-yard.example" }],
  ])("refuses %s when the Studio loads", (_name, over) => {
    expect(() => publishGate({ site: SITE, functionUrl: FN, pages, ...over })).toThrow();
  });
});

describe("publishGate: a document that renders to no page", () => {
  it("is not gated: Sanity's own Publish is returned and nothing is requested", async () => {
    const w = world();
    const { result } = w.mount(draft("r1"), "siteSettings");
    expect(result.current.label).toBe("Publish");
    await click(result);
    expect(w.published).toHaveBeenCalledTimes(1);
    expect(w.calls).toEqual([]);
  });

  it("a type with no rule is not gated either", async () => {
    const w = world();
    const { result } = w.mount(draft("r1"), "coupon");
    await click(result);
    expect(w.published).toHaveBeenCalledTimes(1);
    expect(w.calls).toEqual([]);
  });

  it("when Sanity itself has disabled Publish, the gate adds nothing", () => {
    const w = world();
    const Off = Object.assign((): Description => ({ label: "Publish", disabled: true }), {
      action: "publish",
    });
    const [G] = w.plugin.document.actions([Off], { schemaType: "page" });
    const { result } = renderHook(() => (G as (p: unknown) => Description)(propsFor(draft("r1"))));
    expect(result.current.disabled).toBe(true);
    expect(result.current.label).toBe("Publish");
  });
});

describe("publishGate: a page with a broken link", () => {
  it("Publish is held, names the link, and Sanity's Publish is not called", async () => {
    const w = world();
    const { result } = w.mount();
    expect(result.current.label).toBe("Publish");
    await click(result);
    await waitFor(() => expect(result.current.label).toMatch(/^Held: \d+ problem/));
    expect(result.current.disabled).toBe(true);
    expect(w.published).not.toHaveBeenCalled();
    const view = draw(result.current);
    expect(view.container.textContent).toContain("/menu/old-cocktails");
    expect(view.container.textContent).toContain("broken-links");
    expect(result.current.dialog?.type).toBe("confirm");
  });

  it("fix the link and Publish works: Keep editing re-arms the button, the next click checks again", async () => {
    const w = world();
    const { result } = w.mount();
    await click(result);
    await waitFor(() => expect(result.current.disabled).toBe(true));
    act(() => result.current.dialog?.onCancel?.());
    expect(result.current.label).toBe("Publish");
    expect(result.current.disabled).toBeFalsy();
    w.site.body = '<a href="/">Back to the bar</a>';
    await click(result);
    await waitFor(() => expect(w.published).toHaveBeenCalledTimes(1));
    expect(w.calls).toHaveLength(2);
  });

  it("a clean page publishes at once on the first click", async () => {
    const w = world({ body: '<a href="/">Back</a>' });
    const { result } = w.mount();
    await click(result);
    await waitFor(() => expect(w.published).toHaveBeenCalledTimes(1));
    expect(w.calls).toHaveLength(1);
  });

  it("shows the Function's text as plain text, never as HTML", async () => {
    const hostile = {
      version: 1,
      status: "findings",
      url: `${SITE}/menu`,
      checkedAt: "2026-11-12T10:00:00Z",
      findings: [
        {
          id: "broken-links",
          severity: "high",
          title: '<img src=x onerror="document.title=1">',
          evidence: "<script>document.title=2</script>",
          url: "javascript:alert(1)",
        },
      ],
    };
    const plugin = publishGate({
      site: SITE,
      functionUrl: FN,
      pages,
      fetch: (() =>
        Promise.resolve(
          new Response(JSON.stringify(hostile), {
            headers: { "content-type": "application/json" },
          }),
        )) as typeof globalThis.fetch,
    });
    const [Gated] = plugin.document.actions([fakeSanity().Publish], { schemaType: "page" });
    const { result } = renderHook(() =>
      (Gated as (p: unknown) => Description)(propsFor(draft("r1"))),
    );
    await click(result);
    await waitFor(() => expect(result.current.disabled).toBe(true));
    const view = draw(result.current);
    expect(view.container.querySelector("img, script")).toBeNull();
    expect(view.container.textContent).toContain('<img src=x onerror="document.title=1">');
    expect(view.container.textContent).toContain("<script>document.title=2</script>");
    expect(document.title).toBe("");
    // An address that is not on the site is text, never a link.
    expect(view.container.querySelector("a")).toBeNull();
  });

  it("links only to addresses on the site, in a new tab without a referrer", async () => {
    const w = world();
    const { result } = w.mount();
    await click(result);
    await waitFor(() => expect(result.current.disabled).toBe(true));
    const links = Array.from(draw(result.current).container.querySelectorAll("a"));
    expect(links.length).toBeGreaterThan(0);
    for (const a of links) {
      expect(new URL(a.getAttribute("href") ?? "").origin).toBe(SITE);
      expect(a.getAttribute("rel")).toBe("noopener noreferrer");
      expect(a.getAttribute("target")).toBe("_blank");
    }
  });
});

describe("publishGate: the check could not run", () => {
  it("fails closed by default: held with the reason, Publish not called", async () => {
    const w = world({ down: true });
    const { result } = w.mount();
    await click(result);
    await waitFor(() => expect(result.current.label).toMatch(/could not check/i));
    expect(result.current.disabled).toBe(true);
    expect(w.published).not.toHaveBeenCalled();
    expect(draw(result.current).container.textContent).toMatch(/could not be checked/i);
  });

  it("a person confirms the override, and only then does Sanity's Publish run", async () => {
    const w = world({ down: true });
    const { result } = w.mount();
    await click(result);
    await waitFor(() => expect(result.current.disabled).toBe(true));
    expect(result.current.dialog?.confirmButtonText).toBe("Publish anyway");
    // Nothing the gate does by itself publishes: no handler of the held button does.
    expect(result.current.onHandle).toBeUndefined();
    expect(w.published).not.toHaveBeenCalled();
    act(() => result.current.dialog?.onConfirm?.());
    expect(w.published).toHaveBeenCalledTimes(1);
    expect(result.current.label).toBe("Publish (overridden)");
    expect(result.current.dialog).toBeFalsy();
  });

  it("an override is not recorded: no storage, no cookie, no further request", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const w = world({ down: true });
    const { result } = w.mount();
    await click(result);
    await waitFor(() => expect(result.current.disabled).toBe(true));
    const requests = w.calls.length;
    act(() => result.current.dialog?.onConfirm?.());
    expect(w.calls).toHaveLength(requests);
    expect(setItem).not.toHaveBeenCalled();
    expect(document.cookie).toBe("");
    expect(localStorage.length + sessionStorage.length).toBe(0);
    setItem.mockRestore();
  });

  it("editing the document after an override takes the override away", async () => {
    const w = world({ down: true });
    const { result, rerender } = w.mount();
    await click(result);
    await waitFor(() => expect(result.current.disabled).toBe(true));
    act(() => result.current.dialog?.onConfirm?.());
    expect(result.current.label).toBe("Publish (overridden)");
    rerender(propsFor(draft("r2")));
    await waitFor(() => expect(result.current.label).toBe("Publish"));
    expect(result.current.disabled).toBeFalsy();
  });

  it("failing open (a setting) publishes when the check could not run", async () => {
    const w = world({ down: true, failOpen: true });
    const { result } = w.mount();
    await click(result);
    await waitFor(() => expect(w.published).toHaveBeenCalledTimes(1));
  });

  it("failing open still holds a page that has problems", async () => {
    const w = world({ failOpen: true });
    const { result } = w.mount();
    await click(result);
    await waitFor(() => expect(result.current.disabled).toBe(true));
    expect(w.published).not.toHaveBeenCalled();
  });

  it("a slug the page address cannot be built from is could-not-check, with no request", async () => {
    const w = world();
    const { result } = w.mount(draft("r1", { current: "../admin" }));
    await click(result);
    await waitFor(() => expect(result.current.label).toMatch(/could not check/i));
    expect(w.calls).toEqual([]);
    expect(w.published).not.toHaveBeenCalled();
  });
});

describe("publishGate: Sanity disables Publish while the plugin waits", () => {
  it("a clean answer does not call Sanity's Publish once Sanity has disabled it", async () => {
    let release: () => void = () => undefined;
    const w = world({
      body: '<a href="/">Back</a>',
      delay: new Promise<void>((resolve) => (release = resolve)),
    });
    const { result, rerender } = w.mount();
    await click(result);
    // Validation errors arrive: same revision, but Sanity now refuses to publish.
    w.sanity.disabled = true;
    rerender(propsFor(draft("r1")));
    expect(result.current.disabled).toBe(true);
    await act(async () => {
      release();
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(w.published).not.toHaveBeenCalled();
  });

  it("a confirmed override does not call Sanity's Publish once Sanity has disabled it", async () => {
    const w = world({ down: true });
    const { result, rerender } = w.mount();
    await click(result);
    await waitFor(() => expect(result.current.disabled).toBe(true));
    const confirm = result.current.dialog?.onConfirm;
    expect(confirm).toBeDefined();
    w.sanity.disabled = true;
    rerender(propsFor(draft("r1")));
    act(() => confirm?.());
    expect(w.published).not.toHaveBeenCalled();
  });

  it("with Sanity's Publish enabled the same override does call it, once", async () => {
    const w = world({ down: true });
    const { result } = w.mount();
    await click(result);
    await waitFor(() => expect(result.current.disabled).toBe(true));
    act(() => result.current.dialog?.onConfirm?.());
    expect(w.published).toHaveBeenCalledTimes(1);
  });
});

describe("publishGate: timing", () => {
  it("a second click while the check runs asks nothing more", async () => {
    let release: (r: Response) => void = () => undefined;
    const fetch = vi.fn(
      () => new Promise<Response>((resolve) => (release = resolve)),
    ) as unknown as typeof globalThis.fetch;
    const { Publish } = fakeSanity();
    const [G] = publishGate({ site: SITE, functionUrl: FN, pages, fetch }).document.actions(
      [Publish],
      { schemaType: "page" },
    );
    const { result } = renderHook(() => (G as (p: unknown) => Description)(propsFor(draft("r1"))));
    await click(result);
    expect(result.current.label).toMatch(/Checking/);
    expect(result.current.disabled).toBe(true);
    await click(result);
    expect(fetch).toHaveBeenCalledTimes(1);
    release(new Response("{}", { status: 500 }));
    await waitFor(() => expect(result.current.label).toMatch(/could not check/i));
  });

  it("an answer that arrives after the document changed is dropped, and nothing publishes", async () => {
    let release: () => void = () => undefined;
    const w = world({
      body: '<a href="/">Back</a>',
      delay: new Promise<void>((resolve) => (release = resolve)),
    });
    const { result, rerender } = w.mount();
    await click(result);
    rerender(propsFor(draft("r2")));
    await act(async () => {
      release();
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(w.published).not.toHaveBeenCalled();
    expect(result.current.label).toBe("Publish");
  });
});
