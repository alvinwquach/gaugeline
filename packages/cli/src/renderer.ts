import {
  createNetworkTransport,
  type RenderSource,
  type Renderer,
  type RendererName,
  type Transport,
} from "@gaugeline/core";

/**
 * Starts the renderer a run asked for with `--renderer playwright` (ADR-0009, accepted in part on 13 Nov
 * 2026). This is the only place the adapter package is imported, and the import is dynamic: a run that does
 * not name a renderer never loads it, and the adapter never loads playwright-core until the renderer starts, which
 * is when the first page is asked for or availability is looked up (a test asserts both).
 *
 * The renderer gets the same network rules the fetcher has: the transport refuses private, loopback,
 * link-local and metadata addresses unless the run said --allow-private, and then only for the address
 * that was typed (the same `target` rule the fetcher applies to redirects and links).
 */

export interface StartedRenderer {
  /** What the run hands its checks: the renderer, or why there is none. */
  source: RenderSource;
  /** A line to print under --verbose: what will render. */
  detail?: string;
  /** Plain text for a person to read when the renderer cannot run: why, and what to do. */
  problem?: { reason: string; hint?: string };
  /** Stop the browser. Safe to call when nothing started. */
  close(): Promise<void>;
}

export interface StartRendererOptions {
  name: RendererName;
  /** The address the run checks: the one address a private-address run may reach. */
  address: string;
  allowPrivate: boolean;
  /** Replaces the network, as the fetcher's does (tests). */
  transport?: Transport;
  hosts?: Record<string, string>;
  env: Readonly<Record<string, string | undefined>>;
  /** Replaces the adapter (tests). */
  create?: (options: { transport: Transport }) => Renderer | Promise<Renderer>;
}

export async function startRenderer(options: StartRendererOptions): Promise<StartedRenderer> {
  const transport =
    options.transport ??
    createNetworkTransport({
      ...(options.allowPrivate ? { allowPrivate: true, target: options.address } : {}),
      ...(options.hosts ? { hosts: options.hosts } : {}),
    });
  let renderer: Renderer;
  try {
    renderer = options.create
      ? await options.create({ transport })
      : (await import("@gaugeline/renderer")).createPlaywrightRenderer({
          transport,
          env: options.env as NodeJS.ProcessEnv,
        });
  } catch {
    const unavailable = {
      kind: "could-not-check" as const,
      reason: `the ${options.name} renderer could not be loaded`,
    };
    return {
      source: { unavailable },
      problem: { reason: unavailable.reason },
      close: () => Promise.resolve(),
    };
  }
  const availability = await renderer.availability();
  if (availability.kind === "could-not-check")
    return {
      source: { unavailable: availability },
      problem: {
        reason: availability.reason,
        ...(availability.hint === undefined ? {} : { hint: availability.hint }),
      },
      close: () => renderer.close(),
    };
  return {
    source: { renderer },
    detail: availability.detail,
    close: () => renderer.close(),
  };
}
