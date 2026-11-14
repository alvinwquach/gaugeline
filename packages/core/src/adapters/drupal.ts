import { MAX_RETRY_SECONDS, isRecord } from "../connectors/get-json.js";
import { describeRetry, retryAfterSeconds } from "../connectors/http.js";
import { createRedactor } from "../connectors/redact.js";
import type { Env } from "../connectors/types.js";
import type { Fetcher, Hop } from "../fetcher.js";
import { fillUrlTemplate, hasValue, hashValue, valueAt } from "./fingerprint.js";
import {
  AdapterCouldNotCheck,
  AdapterRateLimitedError,
  type AdapterSettings,
  type ContentAdapter,
  type PublishedDoc,
  type PublishedOptions,
  type TypeCount,
} from "./types.js";

import {
  DRUPAL_DESCRIPTION,
  DRUPAL_ENV_VARS,
  DRUPAL_LIMITS,
  DRUPAL_PAGE_SIZE,
  DRUPAL_PASSWORD,
  DRUPAL_TOKEN,
  DRUPAL_URL,
  DRUPAL_USER,
} from "./drupal.entry.js";
export {
  DRUPAL_DESCRIPTION,
  DRUPAL_ENV_VARS,
  DRUPAL_LIMITS,
  DRUPAL_PAGE_SIZE,
  DRUPAL_PASSWORD,
  DRUPAL_TOKEN,
  DRUPAL_URL,
  DRUPAL_USER,
};

/** The smallest page asked for when an answer is too big: the page is halved down to this and no further. */
const MIN_PAGE_SIZE = 10;

/**
 * A JSON:API resource type is `entity_type--bundle` (Drupal's own naming). Both halves are machine names. Anything
 * else never goes into an address: the route is built from the two halves, not from the text.
 */
const TYPE_NAME = /^([a-z][a-z0-9_]{0,31})--([a-z0-9_]{1,64})$/;

/** A top-level field name: it goes into a sparse fieldset, so only a machine name is accepted. */
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** A resource id (a UUID in Drupal): it goes into an address for the recheck, so only these characters are accepted. */
const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** A node number: a positive whole number, as text. It goes into the address of a node page. */
const NODE_NUMBER = /^[1-9][0-9]{0,11}$/;

/** A bearer token: printable ASCII with no space. Anything else is a paste mistake, and is never sent. */
const TOKEN_SHAPE = /^[\x21-\x7e]+$/;
/** A user name for Basic authentication: printable ASCII (a space is allowed in a Drupal name) and no colon. */
const USER_SHAPE = /^[\x20-\x39\x3b-\x7e]+$/;
/** A password for Basic authentication: printable ASCII, a space included, and nothing else. */
const PASSWORD_SHAPE = /^[\x20-\x7e]+$/;

/** How an unpublished node was listed: its JSON:API id (for the recheck) and its node number (for its page). */
export interface UnpublishedNode {
  id: string;
  nid: string;
  /** The path alias, when it is a plain path of the site. */
  alias?: string;
}

/**
 * What the credential can list of one type's unpublished nodes:
 * - `read`: the list was read. `nodes` are the unpublished nodes (at most the run's cap); `more` is true when there
 *   were more than the cap, which the check says it did not ask about.
 * - `unsupported`: the type is not a node type, so it has no page at /node/ID.
 * - `unread`: the list could not be read; `reason` says why.
 */
export interface UnpublishedRead {
  type: string;
  state: "read" | "unsupported" | "unread";
  nodes: UnpublishedNode[];
  more: boolean;
  reason?: string;
}

/** The Drupal adapter, plus the reads the probing check needs (the unpublished nodes, and a second look at one). */
export interface DrupalAdapter extends ContentAdapter {
  /** The JSON:API types the settings name (under `urls` or `fingerprint`), in order. */
  collections(): string[];
  /** True when the environment holds a credential (a token, or a user name or a password). */
  hasCredential(): boolean;
  /** True when the settings let the probing check list unpublished nodes (`readUnpublished`). */
  unpublishedAllowed(): boolean;
  /** The Drupal address, as an origin: where /node/ID is asked for. Could-not-check when DRUPAL_URL is not usable. */
  origin(): string;
  /** The address of a node's own page, from its node number. Could-not-check for anything but a node number. */
  nodeAddress(nid: string): string;
  /**
   * The unpublished nodes of each named type, as ids and node numbers: one list per type, with the credential, sent in
   * a header. It reads content that is not public, so a caller runs it only with the owner's consent (CLAUDE.md rule
   * 14) and only when the settings say `readUnpublished: true`.
   */
  unpublishedReading(): Promise<UnpublishedRead[]>;
  /** Is the node still unpublished? One GET of the resource by its id, with the credential: false when it was published meanwhile. */
  stillUnpublished(type: string, id: string): Promise<boolean>;
}

export interface DrupalAdapterOptions {
  /** DRUPAL_URL and, optionally, the credential, already copied (see freezeEnv). */
  env: Env;
  fetcher: Fetcher;
  /** The settings entry. Its `urls` and `fingerprint` keys name the types to read. */
  settings?: AdapterSettings | undefined;
  /** How a wait for Retry-After is made. Tests pass a stand-in that does not wait. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  pageSize?: number | undefined;
  /** Replaces DRUPAL_LIMITS.itemsPerType. For tests. */
  maxItemsPerType?: number | undefined;
  /** Replaces DRUPAL_LIMITS.unpublishedPerType. For tests. */
  maxUnpublishedPerType?: number | undefined;
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function isoOf(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** An answer over the size limit: asked again with a smaller page before it becomes could-not-check. */
class TooLarge extends AdapterCouldNotCheck {}

/** A resource as the adapter keeps it: its id and its attributes, and the attributes only until they are hashed or counted. */
interface RawResource {
  id: string;
  attrs: Record<string, unknown>;
}

/** A path that is one site's own: a single leading slash, no `//`, no dot segment (written or encoded), no control character. */
function plainPath(path: string): boolean {
  if (path === "" || path.length > 500 || path[0] !== "/" || path.startsWith("//")) return false;
  if (path.includes("\\") || /%(2e|2f|5c|00)/i.test(path) || path.includes("//")) return false;
  for (let i = 0; i < path.length; i++) {
    const c = path.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false;
  }
  return !/[?#]/.test(path) && !path.split("/").some((s) => s === "." || s === "..");
}

/** A node's number as text: a positive whole number (Drupal sends a number), else undefined. */
function nidOf(raw: unknown): string | undefined {
  const text =
    typeof raw === "number" && Number.isSafeInteger(raw)
      ? String(raw)
      : typeof raw === "string"
        ? raw
        : "";
  return NODE_NUMBER.test(text) ? text : undefined;
}

export function createDrupalAdapter(options: DrupalAdapterOptions): DrupalAdapter {
  const { env, fetcher } = options;
  const sleep = options.sleep ?? wait;
  const pageSize = Math.max(1, Math.min(options.pageSize ?? DRUPAL_PAGE_SIZE, DRUPAL_PAGE_SIZE));
  const cap = options.maxItemsPerType ?? DRUPAL_LIMITS.itemsPerType;
  const unpublishedCap = options.maxUnpublishedPerType ?? DRUPAL_LIMITS.unpublishedPerType;
  const settings = options.settings;

  const token = (env[DRUPAL_TOKEN] ?? "").trim();
  const user = (env[DRUPAL_USER] ?? "").trim();
  const password = (env[DRUPAL_PASSWORD] ?? "").trim();
  const configured = token !== "" || user !== "" || password !== "";
  // The Basic value (base64 of "user:password") is a spelling of the password, so it is blanked too.
  const basic =
    user !== "" && password !== "" ? Buffer.from(`${user}:${password}`).toString("base64") : "";
  const redact = createRedactor({ ...env, DRUPAL_BASIC_VALUE: basic }, [
    DRUPAL_TOKEN,
    DRUPAL_PASSWORD,
    "DRUPAL_BASIC_VALUE",
  ]);

  /** The Authorization header value, or a could-not-check that names the variable. Never reached by a published read. */
  const authorization = (): string => {
    if (!configured)
      throw new AdapterCouldNotCheck(
        `No credential is set. Unpublished nodes need ${DRUPAL_TOKEN}, or ${DRUPAL_USER} and ${DRUPAL_PASSWORD}, of a dedicated user whose role can view them.`,
      );
    if (token !== "" && (user !== "" || password !== ""))
      throw new AdapterCouldNotCheck(
        `Both ${DRUPAL_TOKEN} and ${DRUPAL_USER} or ${DRUPAL_PASSWORD} are set. Set one credential: ${DRUPAL_TOKEN}, or ${DRUPAL_USER} with ${DRUPAL_PASSWORD}.`,
      );
    if (token !== "") {
      if (!TOKEN_SHAPE.test(token))
        throw new AdapterCouldNotCheck(
          `${DRUPAL_TOKEN} has a space, a line break or a character that is not plain ASCII in it, so it is not a token. Copy it again without anything around it.`,
        );
      return `Bearer ${token}`;
    }
    if (user === "" || password === "")
      throw new AdapterCouldNotCheck(
        `${DRUPAL_USER} and ${DRUPAL_PASSWORD} must both be set to use Basic authentication.`,
      );
    if (!USER_SHAPE.test(user) || !PASSWORD_SHAPE.test(password))
      throw new AdapterCouldNotCheck(
        `${DRUPAL_USER} or ${DRUPAL_PASSWORD} has a colon in the user name, a line break, or a character that is not plain ASCII in it, so it cannot be sent as Basic authentication.`,
      );
    return `Basic ${basic}`;
  };

  /** The types the settings name, sorted: the adapter does not ask Drupal to list its resource types. */
  const named = [
    ...new Set([...Object.keys(settings?.urls ?? {}), ...Object.keys(settings?.fingerprint ?? {})]),
  ].sort();

  /** The site's address, or a could-not-check that names the variable. */
  const site = (): URL => {
    const text = (env[DRUPAL_URL] ?? "").trim();
    if (text === "") throw new AdapterCouldNotCheck(`${DRUPAL_URL} is not set.`);
    // Plain ASCII only: a look-alike letter, a space or a control character in an address is never sent.
    if (/[^\x21-\x7e]/.test(text))
      throw new AdapterCouldNotCheck(
        `${DRUPAL_URL} has a space, a control character or a character that is not plain ASCII in it, so it is not used. Write the address with plain letters (a punycode host name for a non-English domain).`,
      );
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      throw new AdapterCouldNotCheck(
        `${DRUPAL_URL} is not an address (expected https://www.client.example).`,
      );
    }
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    )
      throw new AdapterCouldNotCheck(
        `${DRUPAL_URL} must be an http or https address with no user name, password, query or fragment in it.`,
      );
    // A path that is the site's own folder, written plainly. The address is read as typed as well as parsed, because
    // parsing quietly resolves a written or encoded dot segment: no dot segment, no encoded slash, dot, backslash or
    // space, no control character and no non-ASCII byte.
    const typedPath = text.replace(/^[a-z]+:\/\/[^/]*/i, "");
    if (
      [typedPath, url.pathname].some(
        (path) =>
          /%(2e|2f|5c|20|[01][0-9a-f]|7f|[89a-f][0-9a-f])/i.test(path) ||
          path.includes("\\") ||
          path.split("/").some((seg) => seg === "." || seg === ".."),
      )
    )
      throw new AdapterCouldNotCheck(
        `${DRUPAL_URL} has a path with a dot segment, an encoded slash or dot, or a control character in it, so it is not used.`,
      );
    return url;
  };

  const prefixOf = (base: URL): string => base.pathname.replace(/\/+$/, "");

  const split = (type: string): { entity: string; bundle: string } => {
    const m = TYPE_NAME.exec(type);
    if (!m)
      throw new AdapterCouldNotCheck(
        `"${type}" is not a Drupal JSON:API type (entity type and bundle joined by two hyphens, such as node--article; lower-case letters, digits and underscores).`,
      );
    return { entity: m[1] ?? "", bundle: m[2] ?? "" };
  };

  /** The address of a type's collection, or of one resource, with a query made only of Gaugeline's own fixed names and numbers. */
  const resourceUrl = (type: string, params: Record<string, string>, id?: string): string => {
    const { entity, bundle } = split(type);
    const base = site();
    const query = new URLSearchParams(params).toString();
    const tail = id === undefined ? "" : `/${id}`;
    return `${base.origin}${prefixOf(base)}/jsonapi/${entity}/${bundle}${tail}${query === "" ? "" : `?${query}`}`;
  };

  /**
   * One GET, with nothing followed: a redirect is never followed (the credential must not travel, and the answer of
   * another place says nothing about this resource). The credential goes in a header, never in the address, only when
   * `authed`, only over https. A 429 with a short Retry-After is waited out once.
   */
  const send = async (
    url: string,
    authed: boolean,
    partial: () => unknown,
    fresh = false,
  ): Promise<Hop> => {
    let auth: string | undefined;
    if (authed) {
      auth = authorization();
      if (!url.startsWith("https://"))
        throw new AdapterCouldNotCheck(
          `${DRUPAL_URL} is an http address, and the credential is not sent over plain http.`,
        );
    }
    for (let attempt = 0; ; attempt++) {
      let hops: Hop[];
      try {
        hops = await fetcher.get(url, {
          headers: {
            accept: "application/vnd.api+json",
            ...(auth !== undefined ? { authorization: auth } : {}),
          },
          headersSameOrigin: true,
          // A request with no credential is a visitor's: nothing the fetcher adds per address goes with it.
          ...(auth === undefined ? { anonymous: true } : {}),
          maxRedirects: 0,
          ...(attempt > 0 || fresh ? { fresh: true } : {}),
        });
      } catch (err) {
        throw new AdapterCouldNotCheck(redact(err instanceof Error ? err.message : String(err)));
      }
      const hop = hops.at(-1);
      if (!hop) throw new AdapterCouldNotCheck("Drupal gave no answer.");
      if (hop.status === 429) {
        const secs = retryAfterSeconds(hop.headers);
        if (attempt === 0 && secs !== undefined && secs <= MAX_RETRY_SECONDS) {
          await sleep(secs * 1000);
          continue;
        }
        throw new AdapterRateLimitedError(partial(), describeRetry(hop.headers));
      }
      return hop;
    }
  };

  /** One GET, parsed as a JSON object, or a could-not-check in plain words. */
  const get = async (
    url: string,
    authed: boolean,
    partial: () => unknown,
    fresh = false,
  ): Promise<Record<string, unknown>> => {
    const hop = await send(url, authed, partial, fresh);
    if (hop.truncated === true)
      throw new TooLarge("Drupal's answer is larger than a page should be.");
    const s = hop.status;
    if (s >= 300 && s < 400)
      throw new AdapterCouldNotCheck(
        `Drupal answered HTTP ${s}, a redirect, which Gaugeline does not follow (a credential must not travel, and the place it points to says nothing about this resource). Check ${DRUPAL_URL}: it may need https, or the host name the site really uses.`,
      );
    if (s === 401 || s === 403)
      throw new AdapterCouldNotCheck(
        authed
          ? `Drupal would not let the credential read this (HTTP ${s}). Check ${DRUPAL_TOKEN}, or ${DRUPAL_USER} and ${DRUPAL_PASSWORD}, that the matching authentication module is enabled, and that the user's role may view the content.`
          : `Drupal does not show this to a visitor (HTTP ${s}). The JSON:API module may be off for visitors, or the role for anonymous users may not have permission to view published content.`,
      );
    if (s === 404)
      throw new AdapterCouldNotCheck(
        `Drupal answered HTTP 404: there is no such JSON:API resource type, or nothing is at ${DRUPAL_URL}. Check the spelling, that the JSON:API module is enabled, and that its path is the default /jsonapi.`,
      );
    if (s < 200 || s >= 300) throw new AdapterCouldNotCheck(`Drupal answered HTTP ${s}.`);
    let body: unknown;
    try {
      body = JSON.parse(hop.body ?? "");
    } catch {
      throw new AdapterCouldNotCheck("Drupal answered with something that is not JSON.");
    }
    if (!isRecord(body))
      throw new AdapterCouldNotCheck("Drupal answered with something that is not an object.");
    return body;
  };

  const rowsOf = (body: Record<string, unknown>): unknown[] => {
    if (Array.isArray(body.data)) return body.data;
    throw new AdapterCouldNotCheck("Drupal answered with something that is not a list.");
  };

  /** The `meta.count` an answer reports (only a site with jsonapi_extras' count has one): a whole number, undefined when absent, could-not-check when it is not a count. */
  const countOf = (body: Record<string, unknown>): number | undefined => {
    if (!isRecord(body.meta) || body.meta.count === undefined) return undefined;
    const n = body.meta.count;
    if (typeof n === "number" && Number.isSafeInteger(n) && n >= 0) return n;
    throw new AdapterCouldNotCheck("Drupal's answer has a count that is not a whole number.");
  };

  /** True when the answer says it left resources out (the user may not view them): the count of what came back is then not the count of what exists. */
  const omitted = (body: Record<string, unknown>): boolean =>
    isRecord(body.meta) && body.meta.omitted !== undefined;

  /**
   * Where the `next` link points, validated, or undefined when the answer has none (the last page). The server controls
   * this link, so it is never requested: it is read for the paging it states, and it must stay on the host and the
   * path that were asked, state the offset this read expects (the offset asked plus its own limit) and a limit no
   * bigger than the one asked. Anything else is could-not-check. The next page is asked from Gaugeline's own address.
   */
  const nextOf = (
    body: Record<string, unknown>,
    asked: URL,
    offset: number,
    size: number,
  ): { offset: number; limit: number } | undefined => {
    const links = isRecord(body.links) ? body.links : {};
    const raw = links.next;
    if (raw === undefined || raw === null) return undefined;
    const href =
      typeof raw === "string" ? raw : isRecord(raw) && typeof raw.href === "string" ? raw.href : "";
    let target: URL | undefined;
    try {
      target = href === "" ? undefined : new URL(href, asked);
    } catch {
      target = undefined;
    }
    if (!target)
      throw new AdapterCouldNotCheck(
        "Drupal's next link is not an address, so the list was not followed.",
      );
    if (
      target.username !== "" ||
      target.password !== "" ||
      target.hostname.toLowerCase() !== asked.hostname.toLowerCase() ||
      target.port !== asked.port ||
      target.pathname !== asked.pathname
    )
      throw new AdapterCouldNotCheck(
        "Drupal's next link points to another host or path than the one asked, so it was not followed. A site behind a proxy can need its trusted proxy settings, so Drupal builds its links with the host name visitors use.",
      );
    const off = Number(target.searchParams.get("page[offset]"));
    const lim = Number(target.searchParams.get("page[limit]"));
    if (
      !Number.isSafeInteger(off) ||
      !Number.isSafeInteger(lim) ||
      lim < Math.min(MIN_PAGE_SIZE, size) ||
      lim > size ||
      off !== offset + lim
    )
      throw new AdapterCouldNotCheck(
        "Drupal's next link does not continue the list where it should (its offset is not the offset asked plus its page size, or its page size is below the least Gaugeline accepts), so the list was not followed.",
      );
    return { offset: off, limit: lim };
  };

  /** Rows come out as a resource of the asked type with an id; anything else is a list Gaugeline cannot trust. */
  const parseRow = (raw: unknown, type: string): RawResource => {
    const r = isRecord(raw) ? raw : {};
    if (r.type !== type)
      throw new AdapterCouldNotCheck(
        `Drupal listed a resource that is not of the type asked for (${type}).`,
      );
    const id = typeof r.id === "string" && RESOURCE_ID.test(r.id) ? r.id : undefined;
    if (id === undefined)
      throw new AdapterCouldNotCheck("Drupal answered with resources that have no usable id.");
    return { id, attrs: isRecord(r.attributes) ? r.attributes : {} };
  };

  /**
   * The resources of one type a page at a time, until the server says there is no next page. Order is fixed
   * (`sort=id`, the UUID), `page[offset]` advances by the page size asked (that is how Drupal counts, whatever number of
   * resources the user may see on a page), and the next link must agree. Drupal core reports no total, so the list is
   * checked against what can be checked: no resource twice, a list that stays within the bound, a count when the site
   * reports one (`meta.count`, from jsonapi_extras) that must not move or disagree with what came back, and, for a list
   * of more than one page, the first page read again at the end, which must be the same (a list that changed under the
   * read is could-not-check). An answer over the size limit is asked again with a smaller page, down to ten; a sparse
   * fieldset Drupal refuses (HTTP 400) is dropped once and whole resources asked for.
   */
  async function* listOf(
    type: string,
    o: {
      status: "1" | "0";
      authed: boolean;
      enforceCap: boolean;
      partial: () => unknown;
      select: readonly string[];
    },
  ): AsyncGenerator<RawResource> {
    const maxPages = Math.ceil(cap / MIN_PAGE_SIZE) + 4;
    let select: string | undefined = [...new Set(o.select)].join(",");
    let size = pageSize;
    let offset = 0;
    let asked = 0;
    let read = 0;
    let pages = 0;
    let leftOut = false;
    const seen = new Set<string>();
    let firstTotal: number | undefined;
    let firstIds: string[] | undefined;
    let firstSize = size;
    const addressFor = (at: number, limit: number): string =>
      resourceUrl(type, {
        "filter[status]": o.status,
        sort: "id",
        "page[limit]": String(limit),
        "page[offset]": String(at),
        ...(select !== undefined && select !== "" ? { [`fields[${type}]`]: select } : {}),
      });
    for (;;) {
      if (++asked > maxPages)
        throw new AdapterCouldNotCheck(
          `Drupal needed more than ${maxPages} requests to list one type, so it was not read to the end.`,
        );
      const url = addressFor(offset, size);
      let body: Record<string, unknown>;
      try {
        body = await get(url, o.authed, o.partial);
      } catch (err) {
        if (
          select !== undefined &&
          err instanceof AdapterCouldNotCheck &&
          /HTTP 400\b/.test(err.reason)
        ) {
          select = undefined;
          continue;
        }
        if (!(err instanceof TooLarge)) throw err;
        if (size > MIN_PAGE_SIZE) {
          size = Math.max(MIN_PAGE_SIZE, Math.floor(size / 2));
          continue;
        }
        throw new AdapterCouldNotCheck(
          `Drupal's answer for ${size} resources is larger than the 5 MB Gaugeline reads at once, even after asking for fewer at a time (down to ${MIN_PAGE_SIZE}). The type was not read.`,
        );
      }
      const total = countOf(body);
      if (total !== undefined) {
        firstTotal ??= total;
        if (total !== firstTotal)
          throw new AdapterCouldNotCheck(
            `The list changed while it was read: Drupal reported ${firstTotal} resources and then ${total}.`,
          );
        if (o.enforceCap && total > cap)
          throw new AdapterCouldNotCheck(
            `The type has ${total} resources, more than ${cap}, which is as many as Gaugeline reads from one type.`,
          );
      }
      leftOut ||= omitted(body);
      const rows = rowsOf(body);
      if (read + rows.length > cap)
        throw new AdapterCouldNotCheck(
          `Drupal listed more resources than the ${cap} Gaugeline reads from one type, whatever count it reported.`,
        );
      const parsed = rows.map((row) => parseRow(row, type));
      if (pages === 0) {
        firstIds = parsed.map((p) => p.id);
        firstSize = size;
      }
      pages++;
      for (const item of parsed) {
        if (seen.has(item.id))
          throw new AdapterCouldNotCheck(
            `Drupal listed the same resource twice (id ${item.id}) while one type was read, so the list is not reliable: the server may ignore the offset, or content was added or removed during the read.`,
          );
        seen.add(item.id);
        yield item;
      }
      read += rows.length;
      const next = nextOf(body, new URL(url), offset, size);
      if (next === undefined) {
        if (total !== undefined && (read > total || (read !== total && !leftOut)))
          throw new AdapterCouldNotCheck(
            `The list changed while it was read: Drupal reported ${total} resources and ${read} came back.`,
          );
        if (pages > 1) {
          const again = rowsOf(await get(addressFor(0, firstSize), o.authed, o.partial, true));
          const ids = again.map((row) => parseRow(row, type).id);
          if (ids.length !== firstIds?.length || ids.some((id, i) => id !== firstIds?.[i]))
            throw new AdapterCouldNotCheck(
              "The list changed while it was read: the first page is not the same at the end as it was at the start.",
            );
        }
        return;
      }
      offset = next.offset;
      size = next.limit;
    }
  }

  /** Published is what the status field says: true. A status that is not true or false is not an answer, and is never read as a pass. */
  const statusOf = (r: RawResource): boolean => {
    const s = r.attrs.status;
    if (typeof s === "boolean") return s;
    throw new AdapterCouldNotCheck(
      "Drupal answered with a resource whose status is missing or not true or false, so whether it is published is unknown. The status field may be hidden from visitors.",
    );
  };

  const templateFor = (type: string): string | undefined => settings?.urls?.[type];

  const resolveUrl: NonNullable<ContentAdapter["resolveUrl"]> = (doc) => {
    const template = templateFor(doc.type);
    return template === undefined ? "" : fillUrlTemplate(template, doc);
  };

  const topLevel = (fields: readonly string[]): string[] => {
    const names = fields.map((f) => f.split(".")[0] ?? f);
    for (const n of names)
      if (!FIELD_NAME.test(n))
        throw new AdapterCouldNotCheck(
          `"${n}" is not a Drupal field name (letters, digits and underscores).`,
        );
    return names;
  };

  const types = async (): Promise<TypeCount[]> => {
    const out: TypeCount[] = [];
    for (const name of named) {
      let count = 0;
      for await (const r of listOf(name, {
        status: "1",
        authed: false,
        enforceCap: true,
        partial: () => out.slice(),
        select: ["status"],
      }))
        if (statusOf(r)) count++;
      out.push({ name, count });
    }
    return out;
  };

  const fieldCounts = async (
    type: string,
    fields: readonly string[],
  ): Promise<Record<string, number>> => {
    const out: Record<string, number> = Object.fromEntries(fields.map((f) => [f, 0]));
    if (!named.includes(type)) return out;
    const select = ["status", ...topLevel(fields)];
    for await (const r of listOf(type, {
      status: "1",
      authed: false,
      enforceCap: true,
      partial: () => ({}),
      select,
    })) {
      if (!statusOf(r)) continue;
      for (const f of fields) if (hasValue(valueAt(r.attrs, f))) out[f] = (out[f] ?? 0) + 1;
    }
    return out;
  };

  async function* published(opts: PublishedOptions = {}): AsyncGenerator<PublishedDoc> {
    let since: string | undefined;
    if (opts.since !== undefined) {
      since = isoOf(opts.since);
      if (since === undefined) throw new TypeError("since must be a date and time (ISO 8601).");
    }
    let delivered = 0;
    let remaining = opts.limit ?? Number.POSITIVE_INFINITY;
    for (const type of named.filter((n) => opts.types === undefined || opts.types.includes(n))) {
      if (remaining <= 0) return;
      const fields = opts.fields?.[type] ?? settings?.fingerprint?.[type] ?? [];
      const select = ["status", "changed", "created", "path", ...topLevel(fields)];
      for await (const r of listOf(type, {
        status: "1",
        authed: false,
        enforceCap: opts.limit === undefined,
        partial: () => delivered,
        select,
      })) {
        if (!statusOf(r)) continue;
        const createdAt = isoOf(r.attrs.created);
        const updatedAt = isoOf(r.attrs.changed) ?? createdAt;
        if (updatedAt === undefined)
          throw new AdapterCouldNotCheck(
            "Drupal answered with resources that have neither changed nor created, so their update time is unknown.",
          );
        if (since !== undefined && updatedAt < since) continue;
        const fieldHashes: Record<string, string> = {};
        for (const f of fields) {
          const h = hashValue(valueAt(r.attrs, f));
          if (h !== undefined) fieldHashes[f] = h;
        }
        // The path alias is where Drupal serves the node; a pattern in the settings is the fallback.
        const alias =
          isRecord(r.attrs.path) &&
          typeof r.attrs.path.alias === "string" &&
          plainPath(r.attrs.path.alias)
            ? r.attrs.path.alias
            : undefined;
        const url = alias ?? resolveUrl({ id: r.id, type });
        remaining--;
        delivered++;
        yield {
          id: r.id,
          type,
          ...(url !== "" ? { url } : {}),
          ...(createdAt !== undefined ? { publishedAt: createdAt } : {}),
          updatedAt,
          fieldHashes,
        };
        if (remaining <= 0) return;
      }
    }
  }

  const needSettings = (): void => {
    if (settings?.readUnpublished !== true)
      throw new AdapterCouldNotCheck(
        'Unpublished nodes are listed only when gaugeline.adapters.json says "readUnpublished": true for drupal (and the run has --owner-consent), so nothing was asked.',
      );
  };

  const needNamed = (): void => {
    if (named.length === 0)
      throw new AdapterCouldNotCheck(
        'No type is named in gaugeline.adapters.json (under "urls" or "fingerprint"), and Gaugeline does not ask Drupal to list its resource types.',
      );
  };

  /**
   * Always "not-applicable". Reading what the credential can see that a visitor cannot is the probing check's own
   * method, `unpublishedReading`, which a caller runs only with the owner's consent (CLAUDE.md rule 14): nothing a
   * normal run does may ask for unpublished nodes, so this asks nothing.
   */
  const draftsReachable = (): Promise<boolean | "not-applicable"> =>
    Promise.resolve("not-applicable");

  const unpublishedReading = async (): Promise<UnpublishedRead[]> => {
    needSettings();
    authorization();
    needNamed();
    const out: UnpublishedRead[] = [];
    for (const type of named) {
      const { entity } = split(type);
      if (entity !== "node") {
        out.push({
          type,
          state: "unsupported",
          nodes: [],
          more: false,
          reason: `only nodes have a page at /node/ID, and ${type} is not a node type`,
        });
        continue;
      }
      try {
        const nodes: UnpublishedNode[] = [];
        let more = false;
        for await (const r of listOf(type, {
          status: "0",
          authed: true,
          enforceCap: false,
          partial: () => out.slice(),
          select: ["status", "drupal_internal__nid", "path"],
        })) {
          if (statusOf(r))
            throw new AdapterCouldNotCheck(
              "Drupal listed a published node under the unpublished filter, so the list is not the unpublished nodes.",
            );
          if (nodes.length >= unpublishedCap) {
            more = true;
            break;
          }
          const nid = nidOf(r.attrs.drupal_internal__nid);
          if (nid === undefined)
            throw new AdapterCouldNotCheck(
              "Drupal answered with an unpublished node that has no node number (drupal_internal__nid), so its page cannot be asked for.",
            );
          const alias =
            isRecord(r.attrs.path) &&
            typeof r.attrs.path.alias === "string" &&
            plainPath(r.attrs.path.alias)
              ? r.attrs.path.alias
              : undefined;
          nodes.push({ id: r.id, nid, ...(alias !== undefined ? { alias } : {}) });
        }
        out.push({ type, state: "read", nodes, more });
      } catch (err) {
        if (err instanceof AdapterRateLimitedError)
          throw new AdapterRateLimitedError(out.slice(), err.retry);
        if (!(err instanceof AdapterCouldNotCheck)) throw err;
        out.push({ type, state: "unread", nodes: [], more: false, reason: err.reason });
      }
    }
    return out;
  };

  const stillUnpublished = async (type: string, id: string): Promise<boolean> => {
    needSettings();
    if (!RESOURCE_ID.test(id))
      throw new AdapterCouldNotCheck(`"${id}" is not a Drupal resource id.`);
    const body = await get(
      resourceUrl(type, { [`fields[${type}]`]: "status" }, id),
      true,
      () => undefined,
      true,
    );
    const data = isRecord(body.data) ? body.data : {};
    if (data.type !== type || data.id !== id)
      throw new AdapterCouldNotCheck(
        "Drupal answered with another resource than the one asked for.",
      );
    return !statusOf({ id, attrs: isRecord(data.attributes) ? data.attributes : {} });
  };

  return {
    id: "drupal",
    describe: () => DRUPAL_DESCRIPTION,
    types,
    fieldCounts,
    published,
    draftsReachable,
    resolveUrl,
    collections: () => [...named],
    hasCredential: () => configured,
    unpublishedAllowed: () => settings?.readUnpublished === true,
    origin: () => site().origin,
    nodeAddress: (nid) => {
      if (!NODE_NUMBER.test(nid))
        throw new AdapterCouldNotCheck(`"${nid}" is not a Drupal node number.`);
      const base = site();
      return `${base.origin}${prefixOf(base)}/node/${nid}`;
    },
    unpublishedReading,
    stillUnpublished,
  };
}
