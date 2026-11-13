import type { RenderCouldNotCheck, RenderRequest, RenderResult, Renderer } from "./types.js";

/** What a run hands its checks: a renderer, or the reason there is none. Absent: rendering was not asked for. */
export interface RenderSource {
  renderer?: Renderer;
  unavailable?: RenderCouldNotCheck;
}

/** The run's page, rendered on first use. */
export type LazyRender = (
  options?: Pick<RenderRequest, "viewport" | "expose" | "variant" | "measure">,
) => Promise<RenderResult>;

/**
 * The checked page, rendered once per viewport and only when a check asks. A run that names no renderer
 * has none of this (ctx.render is absent), and a renderer that cannot start answers could-not-check on
 * every call without trying again.
 */
export function lazyRender(opts: { url: string } & RenderSource): LazyRender {
  const reads = new Map<string, Promise<RenderResult>>();
  return (options = {}) => {
    const { renderer, unavailable } = opts;
    if (!renderer)
      return Promise.resolve(
        unavailable ?? { kind: "could-not-check", reason: "no renderer is running" },
      );
    const key = JSON.stringify([
      options.viewport ?? null,
      options.expose ?? null,
      options.variant ?? null,
      options.measure ?? null,
    ]);
    let read = reads.get(key);
    if (!read) {
      read = renderer.render({ url: opts.url, ...options });
      reads.set(key, read);
    }
    return read;
  };
}
