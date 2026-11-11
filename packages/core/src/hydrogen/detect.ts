import type { PageSnapshot } from "../snapshot.js";

/**
 * Shopify Hydrogen (React Router 7 on Oxygen), from what a page already says. Markers read from
 * the installed packages (npm, 11 November 2026: @shopify/hydrogen 2026.10.3 and
 * @shopify/cli-hydrogen 13.0.6, whose starter template is the reference), not remembered:
 *  - every response from the Hydrogen request context carries `powered-by: Shopify, Hydrogen`
 *    (`dist/core/request-context.mjs`, `applyResponseHeaders`);
 *  - the document embeds `window.__reactRouterContext = {...}` followed by `streamController.enqueue`
 *    scripts holding the loader data as turbo-stream (a flat JSON array; an object is `{"_<i>": <j>}`,
 *    key `values[i]`, value `values[j]`). Older Hydrogen on Remix v2 wrote `window.__remixContext`
 *    with plain JSON `state.loaderData`. The Remix pack (FW-04) has a reader for the same layout; this
 *    is a small separate copy that also keeps values, because it reads the product's price (a later
 *    branch can unify them);
 *  - the starter's root loader returns `consent: { checkoutDomain, storefrontAccessToken }`: the
 *    PUBLIC storefront token travels with every page by design (`PRIVATE_STOREFRONT_API_TOKEN` and
 *    `SESSION_SECRET` are the server-only variables);
 *  - the starter's product loader returns `product.selectedOrFirstAvailableVariant.price` as a
 *    MoneyV2 (`{ amount: "48.0", currencyCode: "USD" }`), shown by `<Money>` inside
 *    `<div aria-label="Price" class="product-price">`.
 * Everything is a linear scan over a capped slice of the body: no backtracking patterns. Objects
 * are decoded into Maps so a `__proto__` or `constructor` key is only ever a key.
 */

export const SCAN_MAX = 400_000;
export const STATE_MAX = 400_000;
const DEPTH_MAX = 12;
const VISITS_MAX = 30_000;
const CHUNKS_MAX = 24;
const NAMES_MAX = 2_000;

const bodyOf = (page: PageSnapshot): string => (page.hops.at(-1)?.body ?? "").slice(0, SCAN_MAX);
const isTruncated = (page: PageSnapshot): boolean => page.hops.at(-1)?.truncated === true;

const CONTEXT_MARKERS = ["__reactRouterContext", "__remixContext"];

/** The index just after `name` and ` =` when the body assigns it (`window.name = `), else -1. */
function assignmentAfter(body: string, name: string): number {
  let search = 0;
  for (let tries = 0; tries < 6; tries += 1) {
    const at = body.indexOf(name, search);
    if (at < 0) return -1;
    search = at + name.length;
    if (/[A-Za-z0-9_$]/.test(body[at - 1] ?? "")) continue;
    let i = search;
    while (i < body.length && /\s/.test(body[i] ?? "")) i += 1;
    if (body[i] !== "=" || body[i + 1] === "=") continue;
    i += 1;
    while (i < body.length && /\s/.test(body[i] ?? "")) i += 1;
    return i;
  }
  return -1;
}

/** A Hydrogen storefront: the header Hydrogen sets, or React Router's context on a page that loads Shopify's CDN. */
export function isHydrogenSite(page: PageSnapshot): boolean {
  const headers = page.hops.at(-1)?.headers ?? {};
  if (/hydrogen/i.test(headers["powered-by"] ?? "")) return true;
  const body = bodyOf(page);
  const hasContext = CONTEXT_MARKERS.some((m) => assignmentAfter(body, m) >= 0);
  return (
    hasContext &&
    (page.scripts.some((s) => s.includes("cdn.shopify.com")) || body.includes("cdn.shopify.com"))
  );
}

/**
 * Oxygen preview deployments. `*.myshopify.dev` and `*.o2.myshopify.dev` are the owner's note of
 * 11 November 2026: shopify.dev was not reachable from the build machine and the packages do not
 * name a preview host, so these suffixes are uncited. The general hosts (vercel.app, netlify.app,
 * pages.dev) count too, because a Hydrogen app can be deployed there.
 */
export const OXYGEN_PREVIEW_SUFFIXES: readonly string[] = Object.freeze([
  "o2.myshopify.dev",
  "myshopify.dev",
  "vercel.app",
  "netlify.app",
  "pages.dev",
]);

export function isPreviewHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return OXYGEN_PREVIEW_SUFFIXES.some((s) => h.endsWith(`.${s}`));
}

/** True when `url` is an http(s) address on a preview host. */
export function onPreviewHost(url: string | undefined): boolean {
  if (url === undefined) return false;
  try {
    const u = new URL(url);
    return (u.protocol === "https:" || u.protocol === "http:") && isPreviewHost(u.hostname);
  } catch {
    return false;
  }
}

/** The index of the quote that closes the string opened at `i` (or `stop` when it does not). */
function endOfString(src: string, i: number, stop: number): number {
  for (let j = i + 1; j < stop; j += 1) {
    if (src[j] === "\\") j += 1;
    else if (src[j] === '"') return j;
  }
  return stop;
}

/** From an opening bracket to its match, skipping JSON strings; undefined when it does not close within `max`. */
function balanced(src: string, open: number, max: number): string | undefined {
  const stop = Math.min(src.length, open + max);
  let depth = 0;
  for (let i = open; i < stop; i += 1) {
    const c = src[i];
    if (c === '"') {
      i = endOfString(src, i, stop);
      if (i >= stop) return undefined;
    } else if (c === "[" || c === "{") depth += 1;
    else if (c === "]" || c === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return undefined;
}

/** A decoded value: objects are Maps (never plain objects), so no key can touch a prototype. */
type Node = string | number | boolean | null | Node[] | Map<string, Node>;

/** Plain parsed JSON into the Map model, depth and visit capped. */
function fromJson(root: unknown): Node {
  let visits = 0;
  const walk = (v: unknown, depth: number): Node => {
    if (depth > DEPTH_MAX || visits++ > VISITS_MAX) return null;
    if (Array.isArray(v)) return v.slice(0, 200).map((c) => walk(c, depth + 1));
    if (typeof v === "object" && v !== null) {
      const m = new Map<string, Node>();
      for (const [k, c] of Object.entries(v)) if (k.length <= 80) m.set(k, walk(c, depth + 1));
      return m;
    }
    return typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : null;
  };
  return walk(root, 0);
}

/**
 * Decode a turbo-stream first line into the Map model. Each index is decoded once (a shared or
 * cyclic reference becomes null the second time), so the walk is linear. Typed values (dates,
 * promises, ...) other than the null-prototype object are read as null. Undefined on other input.
 */
export function decodeTurbo(line: string): Node | undefined {
  if (line.length > STATE_MAX || !line.startsWith("[")) return undefined;
  let values: unknown;
  try {
    values = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!Array.isArray(values) || values.length === 0) return undefined;
  const done = new Map<number, Node>();
  let visits = 0;
  const at = (i: unknown, depth: number): Node => {
    if (typeof i !== "number" || !Number.isInteger(i) || i < 0 || i >= values.length) return null;
    if (done.has(i)) return done.get(i) ?? null;
    if (depth > DEPTH_MAX || visits++ > VISITS_MAX) return null;
    done.set(i, null);
    const v: unknown = values[i];
    let out: Node = null;
    const record = (o: Record<string, unknown>): Map<string, Node> => {
      const m = new Map<string, Node>();
      for (const [k, c] of Object.entries(o)) {
        const name: unknown = k.startsWith("_") ? values[Number(k.slice(1))] : undefined;
        if (typeof name === "string" && name.length <= 80) m.set(name, at(c, depth + 1));
      }
      return m;
    };
    if (Array.isArray(v)) {
      if (typeof v[0] === "string") {
        if (v[0] === "N" && typeof v[1] === "object" && v[1] !== null && !Array.isArray(v[1]))
          out = record(v[1] as Record<string, unknown>);
      } else out = v.slice(0, 200).map((c) => at(c, depth + 1));
    } else if (typeof v === "object" && v !== null) out = record(v as Record<string, unknown>);
    else if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out = v;
    done.set(i, out);
    return out;
  };
  return at(0, 0);
}

export interface Embedded {
  marker: string;
  /** Every field name found, once each. */
  names: string[];
  /** Stream chunks after the first (deferred values) are not read. */
  deferred: boolean;
  /** The decoded state, for the product reader. */
  root?: Node;
  unread?: string;
}

/** The first context a page embeds. Never throws. */
export function readEmbedded(page: PageSnapshot): Embedded | undefined {
  const body = bodyOf(page);
  const cut = isTruncated(page);
  for (const marker of CONTEXT_MARKERS) {
    const after = assignmentAfter(body, marker);
    if (after < 0) continue;
    const out: Embedded = { marker, names: [], deferred: false };
    const fail = (why: string): Embedded => ({ ...out, unread: why });
    if (body[after] !== "{") return fail("the embedded context is not an object literal");
    const literal = balanced(body, after, STATE_MAX);
    if (literal === undefined)
      return fail(
        cut
          ? "the page was cut before its embedded state ended"
          : `the embedded state is not closed within ${STATE_MAX} characters`,
      );
    let json: unknown;
    try {
      json = JSON.parse(literal);
    } catch {
      return fail("the embedded state is not JSON this reader understands");
    }
    const roots: Node[] = [fromJson(json)];
    const call = `${marker}.streamController.enqueue(`;
    let from = after + literal.length;
    let first = true;
    for (let chunks = 0; chunks < CHUNKS_MAX; chunks += 1) {
      const c = body.indexOf(call, from);
      if (c < 0) break;
      const open = c + call.length;
      from = open;
      if (body[open] !== '"') continue;
      const end = endOfString(body, open, Math.min(body.length, open + STATE_MAX));
      if (body[end] !== '"') return { ...out, unread: "a streamed chunk was cut or is too large" };
      let text: string;
      try {
        text = JSON.parse(body.slice(open, end + 1)) as string;
      } catch {
        return { ...out, unread: "a streamed chunk is not a JSON string" };
      }
      if (!first) {
        out.deferred = true;
        continue;
      }
      first = false;
      const nl = text.indexOf("\n");
      const decoded = decodeTurbo(text.slice(0, nl < 0 ? text.length : nl));
      if (decoded === undefined)
        return { ...out, unread: "the streamed state is not turbo-stream" };
      roots.push(decoded);
    }
    const names = new Set<string>();
    const stack: [Node, number][] = roots.map((r) => [r, 0]);
    let visits = 0;
    while (stack.length > 0 && visits++ < VISITS_MAX && names.size < NAMES_MAX) {
      const [n, d] = stack.pop() as [Node, number];
      if (d >= DEPTH_MAX) continue;
      if (Array.isArray(n)) for (const c of n) stack.push([c, d + 1]);
      else if (n instanceof Map)
        for (const [k, c] of n) {
          names.add(k);
          stack.push([c, d + 1]);
        }
    }
    return { ...out, names: [...names], root: roots.length > 1 ? roots[1] : roots[0] };
  }
  return undefined;
}

/**
 * Field names that are public by design in a Hydrogen page: the starter's root loader sends the
 * PUBLIC storefront token and the checkout domain to the browser for the consent banner.
 */
const PUBLIC_BY_DESIGN: ReadonlySet<string> = new Set([
  "storefrontaccesstoken",
  "publicstorefronttoken",
  "publicstorefrontapitoken",
  "checkoutdomain",
]);

const PRIVATE_WORDS: ReadonlySet<string> = new Set([
  "password",
  "passwd",
  "secret",
  "token",
  "private",
  "credential",
  "credentials",
  "ssn",
  "salt",
  "bearer",
  "authorization",
  "cvv",
  "iban",
  "apikey",
  "accesskey",
  "secretkey",
  "privatekey",
  "internalnote",
  "internalnotes",
]);

/** Names that say, by their words, that they hold something private, minus the public ones. Names in, names out. */
export function privateNames(names: readonly string[]): string[] {
  return names.filter((n) => {
    if (PUBLIC_BY_DESIGN.has(n.toLowerCase())) return false;
    const words = n
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w !== "");
    if (words.some((w) => PRIVATE_WORDS.has(w))) return true;
    return words.some((w, i) => i > 0 && PRIVATE_WORDS.has(`${words[i - 1]}${w}`));
  });
}

/** Markers only a development server writes (Vite dev, as the Hydrogen CLI runs it). */
export function devMarkers(page: PageSnapshot): string[] {
  const body = bodyOf(page);
  const has = (needle: string): boolean =>
    page.scripts.some((s) => s.includes(needle)) || body.includes(needle);
  return [
    "/@vite/client",
    "/@react-refresh",
    "inject-hmr-runtime",
    "__vite_plugin_react_preamble_installed__",
    "/node_modules/.vite/",
  ].filter(has);
}

const get = (n: Node | undefined, key: string): Node | undefined =>
  n instanceof Map ? n.get(key) : undefined;

/** The first Map under `key` at any depth (breadth first, capped), or undefined. */
function findKey(root: Node | undefined, key: string): Node | undefined {
  const queue: [Node, number][] = root === undefined ? [] : [[root, 0]];
  for (let i = 0, visits = 0; i < queue.length && visits++ < VISITS_MAX; i += 1) {
    const [n, d] = queue[i] as [Node, number];
    if (d >= DEPTH_MAX) continue;
    if (n instanceof Map) {
      const hit = n.get(key);
      if (hit instanceof Map) return hit;
      for (const c of n.values()) queue.push([c, d + 1]);
    } else if (Array.isArray(n)) for (const c of n) queue.push([c, d + 1]);
  }
  return undefined;
}

export interface ShownMoney {
  /** The amount as written ("48.0"). */
  amount: string;
  currency: string;
}

/** `product.selectedOrFirstAvailableVariant.price` from the embedded state, when it is there. */
export function embeddedVariantPrice(embedded: Embedded | undefined): ShownMoney | undefined {
  const product = findKey(embedded?.root, "product");
  const price = get(get(product, "selectedOrFirstAvailableVariant"), "price");
  const amount = get(price, "amount");
  const currency = get(price, "currencyCode");
  return typeof amount === "string" && typeof currency === "string" && currency.length === 3
    ? { amount, currency: currency.toUpperCase() }
    : undefined;
}
