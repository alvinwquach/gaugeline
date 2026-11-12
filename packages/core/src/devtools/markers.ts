/**
 * Marks that development tooling is live on a page or in a bundle the site serves to everyone,
 * whatever the framework. Pure functions over text, each pattern linear (no nested repeats). The
 * per-framework packs name their own markers; these are the generic ones.
 */

export type DevMarkerId =
  | "vite-client"
  | "react-refresh"
  | "webpack-hmr"
  | "webpack-dev-server"
  | "webpack-eval"
  | "next-development"
  | "react-development"
  | "node-env"
  | "loopback-address";

export interface DevMarker {
  id: DevMarkerId;
  /** loopback-address only: the host and port, nothing after them. */
  detail?: string;
  /** The page or file was produced by a dev server (fix first), not just carrying a stray value. */
  serves: boolean;
}

export const MARKER_LABEL: Readonly<Record<DevMarkerId, string>> = Object.freeze({
  "vite-client": "Vite dev client (/@vite/client)",
  "react-refresh": "React Refresh (/@react-refresh)",
  "webpack-hmr": "webpack hot reload (/__webpack_hmr)",
  "webpack-dev-server": "webpack-dev-server client",
  "webpack-eval": "webpack development build (webpack-internal:// source names)",
  "next-development": "Next.js development build",
  "react-development": "React development build",
  "node-env": "NODE_ENV set to development",
  "loopback-address": "an address on the visitor's own machine",
});

/** Fixed strings (found with includes) that only a development build or server writes, in report order. */
const LITERALS: readonly [DevMarkerId, string, boolean][] = [
  ["vite-client", "/@vite/client", true],
  ["react-refresh", "/@react-refresh", true],
  ["webpack-hmr", "/__webpack_hmr", true],
  ["webpack-dev-server", "webpack-dev-server/client", true],
  ["webpack-eval", "webpack-internal://", false],
  ["next-development", "/_next/static/development/", true],
  ["react-development", "Download the React DevTools for a better development experience", false],
];

const NEXT_DEV_BUILD = /"buildId"\s*:\s*"development"/;
const NODE_ENV_DEV = /NODE_ENV["']?\s*[:=]\s*["']development["']/;
/** Host and port only: a loopback address with no port is a base some libraries use, and is left out. */
const LOOPBACK =
  /\b(?:https?|wss?):\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})(?![\d])/g;
const DEV_BUILD_FILE = /\.development(?:\.min)?\.js(?:[?#]|$)/;

function hostOf(origin: string): string | undefined {
  try {
    return new URL(origin).host;
  } catch {
    return undefined;
  }
}

/**
 * The markers in one text (a page or a script file), each once, in a fixed order; a loopback
 * address once per host and port. `ownOrigin` is the page's own origin: its address is no leak.
 */
export function findDevMarkers(text: string, ownOrigin?: string): DevMarker[] {
  const found: DevMarker[] = [];
  const ownHost = ownOrigin === undefined ? undefined : hostOf(ownOrigin);
  for (const [id, literal, serves] of LITERALS)
    if (text.includes(literal)) found.push({ id, serves });
  if (NEXT_DEV_BUILD.test(text) && !found.some((m) => m.id === "next-development"))
    found.push({ id: "next-development", serves: true });
  if (NODE_ENV_DEV.test(text)) found.push({ id: "node-env", serves: false });
  const seen = new Set<string>();
  for (const m of text.matchAll(LOOPBACK)) {
    const detail = `${m[1]}:${m[2]}`;
    if (seen.has(detail) || detail === ownHost) continue;
    seen.add(detail);
    found.push({ id: "loopback-address", detail, serves: false });
  }
  return found;
}

/** A development build of a library named by a script address (react-dom.development.js). */
export function scriptAddressMarkers(addresses: readonly string[]): DevMarker[] {
  return addresses
    .filter((a) => DEV_BUILD_FILE.test(a))
    .map(() => ({ id: "react-development" as const, serves: false }));
}
