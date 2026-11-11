import { parseGraphql } from "../query/graphql-parse.js";
import { isNextSite } from "../next/detect.js";
import type { PageSnapshot } from "../snapshot.js";

/**
 * Headless WordPress: a WordPress back end (WPGraphQL) behind a JavaScript front end (Faust.js on
 * Next.js). Everything here is a pure function over a page already fetched, with size caps: the
 * HTML and the embedded JSON are hostile input.
 */

/** The embedded state is read up to this many bytes; a larger one is unread, never guessed at. */
export const STATE_MAX_BYTES = 1_000_000;
/** The most nodes and the deepest nesting the state walk visits. */
const MAX_NODES = 100_000;
const MAX_DEPTH = 12;
/** The most characters of a field name that are ever shown. */
const NAME_MAX = 60;

/** The WordPress object types WPGraphQL names in `__typename` (uncited beyond the schema reference). */
const WP_TYPES = new Set([
  "Post",
  "Page",
  "MediaItem",
  "MenuItem",
  "Category",
  "Tag",
  "ContentType",
  "GeneralSettings",
  "User",
]);

const bodyOf = (page: PageSnapshot): string => page.hops.at(-1)?.body ?? "";

export type NextData = { json: unknown; text: string } | { unread: string };

/** The `__NEXT_DATA__` script of a page, parsed, or why it could not be read. undefined: none. */
export function readNextData(page: PageSnapshot): NextData | undefined {
  const html = bodyOf(page);
  const mark = html.indexOf('id="__NEXT_DATA__"');
  if (mark === -1) return undefined;
  const open = html.indexOf(">", mark);
  if (open === -1) return { unread: "the embedded state has no end" };
  const close = html.indexOf("</script>", open);
  if (close === -1)
    return {
      unread: page.hops.at(-1)?.truncated
        ? "the page was cut before the embedded state ended"
        : "the embedded state has no end",
    };
  const text = html.slice(open + 1, close);
  if (text.length > STATE_MAX_BYTES)
    return { unread: "the embedded state is larger than 1 MB, so it was not read" };
  try {
    return { json: JSON.parse(text) as unknown, text };
  } catch {
    return { unread: "the embedded state is not valid JSON" };
  }
}

/** A Faust.js page: Apollo's cache in the embedded state holding WordPress object types. */
export function hasWordPressState(text: string): boolean {
  if (!text.includes("__APOLLO_STATE__")) return false;
  for (const m of text.matchAll(/"__typename"\s*:\s*"([A-Za-z]{1,40})"/g))
    if (WP_TYPES.has(m[1] ?? "")) return true;
  return false;
}

const UPLOADS = /https?:\/\/[A-Za-z0-9.-]{1,253}(?::\d{1,5})?\/wp-content\/uploads\//;

/**
 * A headless WordPress site: a front end that is not a WordPress theme (no /wp-includes/ or
 * /wp-content/themes/ on the page) and either carries WordPress state from WPGraphQL, or is a
 * Next.js site that serves its images from /wp-content/uploads/.
 */
export function isHeadlessWordPress(page: PageSnapshot): boolean {
  const html = bodyOf(page).slice(0, 2_000_000);
  if (html.includes("/wp-includes/") || html.includes("/wp-content/themes/")) return false;
  const data = readNextData(page);
  if (data && "text" in data && hasWordPressState(data.text)) return true;
  return isNextSite(page) && UPLOADS.test(html);
}

/** The addresses a WPGraphQL endpoint may be at: the site's own /graphql, and the back end it names. */
export function graphqlCandidates(page: PageSnapshot): string[] {
  const own = new URL(page.finalUrl).origin;
  const out = [`${own}/graphql`];
  const m = UPLOADS.exec(bodyOf(page).slice(0, 2_000_000));
  if (m) {
    try {
      const o = new URL(m[0]).origin;
      if (o !== own) out.push(`${o}/graphql`);
    } catch {
      // not an address
    }
  }
  return out;
}

/** The one question asked of an endpoint: is introspection answered. The smallest query that says. */
export const INTROSPECTION_PROBE = "{__schema{queryType{name}}}";

/**
 * The probe goes through the existing GraphQL parser and is refused unless it is exactly one
 * `query` operation (the read-only rule: no mutation or subscription is ever put in a request).
 */
export function readOnlyProbe(query: string = INTROSPECTION_PROBE): string {
  const defs = parseGraphql(query);
  const only = defs.length === 1 ? defs[0] : undefined;
  if (only?.kind !== "operation" || only.operation !== "query")
    throw new TypeError("The introspection probe must be one query.");
  return query;
}

export type IntrospectionRead =
  { state: "open"; rootType: string } | { state: "closed" } | { state: "unread"; reason: string };

/** What a GraphQL endpoint's answer to the probe says. Bounded: 100 KB, one JSON parse. */
export function readIntrospection(
  body: string,
  truncated: boolean,
  type: string,
): IntrospectionRead {
  if (truncated || body.length > 100_000)
    return { state: "unread", reason: "the answer is larger than a probe answer should be" };
  if (!/json|graphql/i.test(type) && !/^\s*\{/.test(body))
    return { state: "unread", reason: "the answer is not JSON" };
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { state: "unread", reason: "the answer is not valid JSON" };
  }
  if (typeof json !== "object" || json === null)
    return { state: "unread", reason: "the answer is not a GraphQL answer" };
  const o = json as { data?: unknown; errors?: unknown };
  const schema =
    typeof o.data === "object" && o.data !== null
      ? (o.data as { __schema?: unknown }).__schema
      : undefined;
  const q =
    typeof schema === "object" && schema !== null
      ? (schema as { queryType?: unknown }).queryType
      : undefined;
  const name = typeof q === "object" && q !== null ? (q as { name?: unknown }).name : undefined;
  if (typeof name === "string" && name.length > 0 && name.length <= 80)
    return { state: "open", rootType: name };
  if (Array.isArray(o.errors) && o.errors.length > 0) return { state: "closed" };
  return { state: "unread", reason: "the answer is neither a schema nor a GraphQL error" };
}

/** A link that opens a draft: WordPress's `preview=true`, `preview_id`, or Faust's `previewId`. */
export function isPreviewAddress(href: string): boolean {
  try {
    const q = new URL(href).searchParams;
    return q.get("preview") === "true" || q.has("preview_id") || q.has("previewId");
  } catch {
    return false;
  }
}

/** Preview addresses the page links to on its own origin, without repeats: at most `max`. */
export function previewLinks(page: PageSnapshot, max = 3): string[] {
  const origin = new URL(page.finalUrl).origin;
  const seen = new Set<string>();
  for (const l of page.links) {
    if (seen.size >= max) break;
    try {
      const u = new URL(l.href, page.finalUrl);
      if (u.origin === origin && isPreviewAddress(u.href)) seen.add(u.href);
    } catch {
      // not an address
    }
  }
  return [...seen];
}

/** The path and the names of the query parameters, never their values (they can carry a nonce). */
export function describeAddress(href: string): string {
  try {
    const u = new URL(href);
    const names = [...new Set(u.searchParams.keys())].map((n) => n.slice(0, 30));
    return `${u.pathname.slice(0, 80)}${names.length ? ` (query: ${names.slice(0, 6).join(", ")})` : ""}`;
  } catch {
    return "a preview address";
  }
}

const LOGIN_PATH = /(?:^|\/)(?:wp-login\.php|login|log-in|signin|sign-in|auth)(?:\/|\.|$)/i;

/** True when any hop of a request went to a login address, or the page is a login form. */
export function endsAtLogin(hops: readonly { url: string; body?: string }[]): boolean {
  for (const h of hops) {
    try {
      if (LOGIN_PATH.test(new URL(h.url).pathname)) return true;
    } catch {
      // not an address
    }
  }
  return /type=["']?password/i.test(hops.at(-1)?.body?.slice(0, 500_000) ?? "");
}

/** Signs in a response that it is an unpublished post, from its title or its embedded data. */
export function draftMarker(html: string): string | undefined {
  const text = html.slice(0, 500_000);
  const status = /"status"\s*:\s*"(draft|auto-draft|pending|private|future)"/.exec(text);
  if (status) return `status ${status[1] ?? "draft"} in its data`;
  if (/"isPreview"\s*:\s*true/.test(text)) return "isPreview set in its data";
  const title = /<title[^>]*>([^<]{0,200})/i.exec(text)?.[1] ?? "";
  if (/\bAuto Draft\b|\(Draft\)|^\s*(?:Draft|Private):/i.test(title)) return "a draft title";
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Private fields in the embedded state

const PRIVATE_WORDS = new Set([
  "password",
  "passwd",
  "secret",
  "token",
  "credential",
  "credentials",
  "ssn",
  "salt",
  "bearer",
  "authorization",
  "cvv",
  "iban",
  "private",
]);
const PRIVATE_JOINED = /apikey|accesskey|secretkey|privatekey|authkey|internalnote/;
/** WPGraphQL User fields that only a signed-in editor should ever receive. */
const USER_FIELDS = new Set([
  "email",
  "username",
  "capabilities",
  "extraCapabilities",
  "roles",
  "registeredDate",
]);

function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== "");
}

/** True for a field name that says it holds something private. `isPrivate`-style flags are left out. */
export function looksPrivate(name: string): boolean {
  if (/^(?:is|has)[A-Z_]/.test(name)) return false;
  const w = words(name);
  return w.some((x) => PRIVATE_WORDS.has(x)) || PRIVATE_JOINED.test(w.join(""));
}

const clean = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/g, "?").slice(0, NAME_MAX);

export interface StateScan {
  /** Field names that look private, and `User.<field>` for a user's private fields. */
  names: string[];
  /** Nodes whose status is not publish, by status. */
  unpublished: Map<string, number>;
  /** The walk stopped at a cap: what it found is a floor, not the whole state. */
  capped: boolean;
}

const UNPUBLISHED = new Set(["draft", "auto-draft", "pending", "private", "future"]);

/** Walk a parsed state iteratively (no recursion: a deep document cannot overflow the stack). */
export function scanState(root: unknown): StateScan {
  const names = new Set<string>();
  const unpublished = new Map<string, number>();
  const stack: { v: unknown; d: number }[] = [{ v: root, d: 0 }];
  let nodes = 0;
  let capped = false;
  while (stack.length > 0) {
    const { v, d } = stack.pop() as { v: unknown; d: number };
    if (typeof v !== "object" || v === null) continue;
    if (++nodes > MAX_NODES || d > MAX_DEPTH) {
      capped = true;
      continue;
    }
    if (Array.isArray(v)) {
      for (const x of v) stack.push({ v: x, d: d + 1 });
      continue;
    }
    const entries = Object.entries(v as Record<string, unknown>);
    const isUser = entries.some(([k, x]) => k === "__typename" && x === "User");
    const status = entries.find(([k]) => k === "status")?.[1];
    if (typeof status === "string" && UNPUBLISHED.has(status))
      unpublished.set(status, (unpublished.get(status) ?? 0) + 1);
    for (const [k, x] of entries) {
      if (isUser && USER_FIELDS.has(k) && x !== null && x !== undefined) names.add(`User.${k}`);
      else if (looksPrivate(k)) names.add(clean(k));
      if (typeof x === "object" && x !== null) stack.push({ v: x, d: d + 1 });
    }
  }
  return { names: [...names].sort(), unpublished, capped };
}
