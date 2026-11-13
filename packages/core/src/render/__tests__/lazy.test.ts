import { describe, expect, it, vi } from "vitest";
import { lazyRender } from "../lazy.js";
import type { RenderResult, Renderer } from "../types.js";
import { emptyBlocked } from "../types.js";

const page = (title: string): RenderResult => ({
  kind: "rendered",
  finalUrl: "https://site.example/",
  status: 200,
  title: title as never,
  requests: [],
  blocked: emptyBlocked(),
  totals: { requests: 0, bytes: 0 },
  truncated: [],
});

function fakeRenderer() {
  const render = vi.fn((r: { url: string }) => Promise.resolve(page(r.url)));
  const renderer: Renderer = {
    name: "playwright",
    render,
    availability: () => Promise.resolve({ kind: "available", detail: "fake" }),
    close: () => Promise.resolve(),
  };
  return { renderer, render };
}

describe("lazyRender", () => {
  it("renders nothing until a check asks, and the same viewport once", async () => {
    const { renderer, render } = fakeRenderer();
    const read = lazyRender({ url: "https://site.example/", renderer });
    expect(render).not.toHaveBeenCalled();
    await Promise.all([read(), read()]);
    expect(render).toHaveBeenCalledTimes(1);
    await read({ viewport: { width: 375, height: 667 } });
    await read({ viewport: { width: 375, height: 667 } });
    expect(render).toHaveBeenCalledTimes(2);
    expect(render).toHaveBeenLastCalledWith({
      url: "https://site.example/",
      viewport: { width: 375, height: 667 },
    });
  });

  it("answers could-not-check with the reason there is no renderer, and never renders", async () => {
    const unavailable = { kind: "could-not-check" as const, reason: "no browser", hint: "install" };
    expect(await lazyRender({ url: "https://site.example/", unavailable })()).toEqual(unavailable);
    expect(await lazyRender({ url: "https://site.example/" })()).toMatchObject({
      kind: "could-not-check",
    });
  });
});
