import {
  ConnectorRateLimitedError,
  ConnectorRefusedError,
  ConnectorStatusError,
} from "../connectors/http.js";
import { getJson, isRecord, type JsonSource } from "../connectors/get-json.js";
import { createRedactor } from "../connectors/redact.js";
import type { Env } from "../connectors/types.js";
import type { Fetcher } from "../fetcher.js";
import { maskEmail } from "../handoff/people.js";
import type { Role } from "../handoff/types.js";
import type { WordPressData } from "../advisory/evidence.js";
import { fillUrlTemplate, hashValue } from "./fingerprint.js";
import {
  AdapterCouldNotCheck,
  AdapterRateLimitedError,
  type AdapterDescription,
  type AdapterMember,
  type AdapterSettings,
  type ContentAdapter,
  type PublishedDoc,
  type PublishedOptions,
  type TypeCount,
} from "./types.js";

/**
 * WordPress asks for no key at all to read what is published: the REST API lists published posts, pages and
 * custom types to any visitor. A key is asked for only for drafts and members, and WordPress has no read-only
 * key: an application password acts with the role of the user it belongs to. So the narrowest key is an
 * application password on a dedicated user with the lowest role that does the job, and the kind is "scoped".
 */
export const WORDPRESS_DESCRIPTION: AdapterDescription = {
  name: "WordPress",
  docsUrl: "https://gaugeline.dev/docs/integrations/wordpress",
  keyKind: "scoped",
};

export const WORDPRESS_URL = "WORDPRESS_URL";
export const WORDPRESS_USER = "WORDPRESS_USER";
export const WORDPRESS_APP_PASSWORD = "WORDPRESS_APP_PASSWORD";

/** Every variable the WordPress adapter may read. Only the last two hold a key, and only for drafts and members. */
export const WORDPRESS_ENV_VARS = [WORDPRESS_URL, WORDPRESS_USER, WORDPRESS_APP_PASSWORD] as const;

/** Items asked for in one request: the most the REST API allows. */
export const WORDPRESS_PAGE_SIZE = 100;

/** The most items one fieldCounts() reads. Past it the answer would be partial, so it says it cannot check. */
export const WORDPRESS_COUNT_CAP = 2000;

/** The most users one members() reads (five pages of 100). */
const MEMBER_CAP = 500;

/**
 * Types that are the site's machinery and not its content: media files, menus, reusable blocks, block
 * templates and global styles. Their items are not pages a visitor reads, so they are not listed.
 */
const MACHINERY = new Set([
  "attachment",
  "nav_menu_item",
  "wp_block",
  "wp_template",
  "wp_template_part",
  "wp_navigation",
  "wp_global_styles",
  "wp_font_family",
  "wp_font_face",
]);

/** The statuses a visitor cannot see, in one comma-separated list for the status parameter. */
const UNPUBLISHED = "draft,pending,future,private";

export interface WordPressAdapterOptions {
  /** WORDPRESS_URL, WORDPRESS_USER and WORDPRESS_APP_PASSWORD, already copied (see freezeEnv). */
  env: Env;
  fetcher: Fetcher;
  /** The settings entry (`fingerprint`, `urls`). With none, no field value is read. */
  settings?: AdapterSettings | undefined;
  /** How a wait for Retry-After is made. Tests pass a stand-in that does not wait. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  pageSize?: number | undefined;
}

/**
 * Blanks the application password in every spelling it can turn up in: as typed (WordPress shows it in groups of
 * four, with spaces), without the spaces, and inside the Basic value (base64 of "user:password") that travels in the
 * Authorization header. Reasons are built from status codes and fixed words and never carry a response body, so this
 * is the backstop for a message some layer below puts the header in.
 */
export function createWordPressRedactor(env: Env): (text: string) => string {
  const user = (env[WORDPRESS_USER] ?? "").trim();
  const password = (env[WORDPRESS_APP_PASSWORD] ?? "").trim();
  const basic =
    user !== "" && password !== "" ? Buffer.from(`${user}:${password}`).toString("base64") : "";
  const nospace = password.replace(/\s+/g, "");
  return createRedactor({ ...env, _nospace: nospace, _basic: basic }, [
    WORDPRESS_APP_PASSWORD,
    "_nospace",
    "_basic",
  ]);
}

/** ContentAdapter, plus the one read WordPress offers that no other adapter has: what is installed. */
export interface WordPressAdapter extends ContentAdapter {
  /**
   * The active plugins and themes with their versions, for `gaugeline advisory`. WordPress lists them
   * only to an administrator, so this is optional and the key a normal run needs cannot do it.
   */
  installed(): Promise<WordPressData>;
}

/** WordPress answered 400, which for a page of a list means "there is no such page" (rest_post_invalid_page_number). */
class NoSuchPage extends AdapterCouldNotCheck {}

/** A read WordPress refused to a visitor with no key: for one type, that is not an error but "not published content". */
class AnonymousRefused extends AdapterCouldNotCheck {}

const NO_ADDRESS = "(address not shown by WordPress)";

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** An ISO 8601 UTC time from a WordPress `*_gmt` value ("2026-11-03T14:30:00", no zone), or undefined. */
function gmtOf(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const ms = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** A time the caller gave (`since`), as ISO 8601 UTC, or undefined when it is not a time. */
function isoOf(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** WordPress wraps text in `{ rendered }`; the value is what is inside. Empty text and empty lists are no value. */
function valueAt(item: Record<string, unknown>, path: string): unknown {
  let at: unknown = item;
  for (const part of path.split(".")) {
    if (!isRecord(at)) return undefined;
    at = at[part];
  }
  if (isRecord(at) && typeof at.rendered === "string") at = at.rendered;
  if (at === null || at === undefined || at === "") return undefined;
  // WordPress writes 0 for "no featured image".
  if (at === 0 && path === "featured_media") return undefined;
  if (Array.isArray(at) && at.length === 0) return undefined;
  return at;
}

const topLevel = (fields: readonly string[]): string[] => [
  ...new Set(fields.map((f) => f.split(".")[0] ?? f)),
];

/** The roles WordPress ships with, in the four words a report uses. A role a plugin adds is "unknown". */
const ROLES: Readonly<Record<string, Role>> = {
  administrator: "admin",
  editor: "member",
  author: "member",
  contributor: "member",
  shop_manager: "member",
  subscriber: "viewer",
  customer: "viewer",
};

/** One REST collection: its name and the path it is listed at. */
interface RestType {
  name: string;
  base: string;
}

/**
 * WordPress on ContentAdapter, through the REST API (`/wp-json/wp/v2`). Published content is read with no
 * key, exactly as a visitor's browser could read it. Drafts and members are read with an application password
 * (HTTP Basic, in a header, only over https) and only when it is set. Every request is a GET; no login form is
 * touched, xmlrpc.php is never called and no path that is not a documented REST route is asked for. Items come
 * back as ids, slugs, addresses, times and a hash of each field the settings name; the value of a field is read
 * only to be hashed or counted.
 */
export function createWordPressAdapter(options: WordPressAdapterOptions): WordPressAdapter {
  const { env, fetcher } = options;
  const sleep = options.sleep ?? wait;
  const pageSize = options.pageSize ?? WORDPRESS_PAGE_SIZE;
  const settings = options.settings;

  const user = (env[WORDPRESS_USER] ?? "").trim();
  const password = (env[WORDPRESS_APP_PASSWORD] ?? "").trim();
  const basic =
    user !== "" && password !== "" ? Buffer.from(`${user}:${password}`).toString("base64") : "";
  const redact = createWordPressRedactor(env);

  /** What a failed read becomes: a rate limit carries what was read, anything else is could-not-check. */
  const translate = (err: unknown, partial: unknown, authed: boolean): Error => {
    if (err instanceof AdapterCouldNotCheck || err instanceof AdapterRateLimitedError) return err;
    if (err instanceof ConnectorRateLimitedError)
      return new AdapterRateLimitedError(partial, err.retry);
    if (err instanceof ConnectorRefusedError)
      return new (authed ? AdapterCouldNotCheck : AnonymousRefused)(
        authed
          ? `WordPress did not accept the application password, or this user may not read this (HTTP ${err.status}). Check ${WORDPRESS_USER} and ${WORDPRESS_APP_PASSWORD}, and that the user's role may do it: listing drafts needs a Contributor or higher, listing users needs an Administrator.`
          : `WordPress refused an anonymous read of its REST API (HTTP ${err.status}). A security plugin or the host may block it for visitors.`,
      );
    if (err instanceof ConnectorStatusError && err.status === 404)
      return new AdapterCouldNotCheck(
        `WordPress's REST API was not found at ${WORDPRESS_URL} (HTTP 404). Check the address, that permalinks are not set to Plain and that no plugin turns the REST API off.`,
      );
    if (err instanceof ConnectorStatusError && err.status === 400)
      return new NoSuchPage(redact(err.message));
    return new AdapterCouldNotCheck(redact(err instanceof Error ? err.message : String(err)));
  };

  /** The site's REST address, or a could-not-check that names the variable. */
  const site = (): URL => {
    const text = (env[WORDPRESS_URL] ?? "").trim();
    if (text === "") throw new AdapterCouldNotCheck(`${WORDPRESS_URL} is not set.`);
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      throw new AdapterCouldNotCheck(
        `${WORDPRESS_URL} is not an address (expected https://client.example).`,
      );
    }
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username !== "" ||
      url.password !== ""
    )
      throw new AdapterCouldNotCheck(
        `${WORDPRESS_URL} must be an http or https address with no user name or password in it.`,
      );
    return url;
  };

  const restUrl = (path: string, params: Record<string, string>): string => {
    const url = site();
    const root = url.pathname.replace(/\/+$/, "");
    const query = new URLSearchParams(params).toString();
    return `${url.origin}${root}/wp-json/wp/v2/${path}${query === "" ? "" : `?${query}`}`;
  };

  const source = (authed: boolean): JsonSource => {
    if (authed) {
      if (basic === "")
        throw new AdapterCouldNotCheck(
          `${WORDPRESS_USER} and ${WORDPRESS_APP_PASSWORD} are not set. Published content needs no key; drafts and members need an application password on a dedicated user.`,
        );
      if (site().protocol !== "https:")
        throw new AdapterCouldNotCheck(
          `${WORDPRESS_URL} is an http address, and the application password is not sent over plain http.`,
        );
    }
    return {
      fetcher,
      request: authed ? { authorization: `Basic ${basic}` } : {},
      sleep,
      system: "WordPress",
    };
  };

  const read = async (
    path: string,
    params: Record<string, string>,
    authed: boolean,
    partial: unknown,
  ): Promise<{ body: unknown; headers: Record<string, string> }> => {
    try {
      return await getJson(source(authed), restUrl(path, params));
    } catch (err) {
      throw translate(err, partial, authed);
    }
  };

  const total = (headers: Record<string, string>, what: string): number => {
    const n = Number(headers["x-wp-total"]);
    if (!Number.isSafeInteger(n) || n < 0)
      throw new AdapterCouldNotCheck(`WordPress did not say how many ${what} there are.`);
    return n;
  };

  /** The content types the site lists in its REST API, with the path each is read at. */
  const restTypes = async (partial?: unknown): Promise<RestType[]> => {
    const { body } = await read("types", {}, false, partial);
    if (!isRecord(body))
      throw new AdapterCouldNotCheck(
        "WordPress answered with something that is not a list of types.",
      );
    const out: RestType[] = [];
    for (const [key, value] of Object.entries(body)) {
      if (!isRecord(value) || MACHINERY.has(key)) continue;
      const base = value.rest_base;
      // Only the core namespace is read: a type a plugin serves elsewhere has its own routes.
      if (typeof base !== "string" || !/^[a-z0-9_-]+$/i.test(base)) continue;
      if (typeof value.rest_namespace === "string" && value.rest_namespace !== "wp/v2") continue;
      out.push({ name: key, base });
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  };

  const templateFor = (type: string): string | undefined => settings?.urls?.[type];

  const resolveUrl: NonNullable<ContentAdapter["resolveUrl"]> = (doc) => {
    const template = templateFor(doc.type);
    return template === undefined ? "" : fillUrlTemplate(template, doc);
  };

  const types = async (): Promise<TypeCount[]> => {
    const done: TypeCount[] = [];
    const found = await restTypes(done);
    for (const t of found) {
      try {
        const { headers } = await read(
          t.base,
          { status: "publish", per_page: "1", _fields: "id" },
          false,
          done,
        );
        done.push({ name: t.name, count: total(headers, `published ${t.name} items`) });
      } catch (err) {
        // A type a visitor may not list (the API answers 401 or 403 for it) is not published content.
        if (err instanceof AnonymousRefused) continue;
        throw err;
      }
    }
    return done;
  };

  /** One page after another of a type's items, with the fields asked for, until WordPress says there are no more. */
  async function* pages(
    base: string,
    params: Record<string, string>,
    fields: readonly string[],
    delivered: () => number,
  ): AsyncGenerator<Record<string, unknown>> {
    let page = 1;
    let counted = false;
    for (;;) {
      // status=publish is asked for, and asked back: a plugin that leaks drafts to visitors does not make them published.
      const asked = [...new Set(["id", "status", ...fields])];
      let answer: { body: unknown; headers: Record<string, string> };
      try {
        answer = await read(
          base,
          {
            ...params,
            status: "publish",
            per_page: String(pageSize),
            page: String(page),
            _fields: asked.join(","),
          },
          false,
          delivered(),
        );
      } catch (err) {
        // With no page count (a proxy stripped X-WP-TotalPages) the page after a full last page is a 400: the end.
        if (err instanceof NoSuchPage && page > 1 && !counted) return;
        throw err;
      }
      const { body, headers } = answer;
      if (!Array.isArray(body))
        throw new AdapterCouldNotCheck("WordPress answered with something that is not a list.");
      for (const row of body) {
        const item = isRecord(row) ? row : {};
        if (typeof item.status === "string" && item.status !== "publish") continue;
        yield item;
      }
      const pagesTotal = Number(headers["x-wp-totalpages"]);
      counted = Number.isSafeInteger(pagesTotal);
      const more = counted ? page < pagesTotal : body.length >= pageSize;
      if (!more || body.length === 0) return;
      page++;
    }
  }

  const fieldCounts = async (
    type: string,
    fields: readonly string[],
  ): Promise<Record<string, number>> => {
    const out: Record<string, number> = Object.fromEntries(fields.map((f) => [f, 0]));
    const rest = (await restTypes({})).find((t) => t.name === type);
    if (!rest || fields.length === 0) return out;
    let n = 0;
    for await (const item of pages(
      rest.base,
      { order: "asc", orderby: "id" },
      topLevel(fields),
      () => 0,
    )) {
      if (++n > WORDPRESS_COUNT_CAP)
        throw new AdapterCouldNotCheck(
          `The site has more than ${WORDPRESS_COUNT_CAP} published ${type} items, which is more than Gaugeline counts field by field.`,
        );
      for (const f of fields) if (valueAt(item, f) !== undefined) out[f] = (out[f] ?? 0) + 1;
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
    const known = await restTypes(0);
    const wanted = opts.types ?? known.map((t) => t.name);
    let remaining = opts.limit ?? Number.POSITIVE_INFINITY;
    for (const type of wanted) {
      if (remaining <= 0) return;
      const rest = known.find((t) => t.name === type);
      // A type the site does not list has no published items to give.
      if (!rest) continue;
      const fields = opts.fields?.[type] ?? settings?.fingerprint?.[type] ?? [];
      const params: Record<string, string> = {
        order: "asc",
        orderby: "id",
        ...(since !== undefined ? { modified_after: since } : {}),
      };
      const asked = ["slug", "link", "date_gmt", "modified_gmt", ...topLevel(fields)];
      for await (const r of pages(rest.base, params, asked, () => delivered)) {
        const id = typeof r.id === "number" && Number.isSafeInteger(r.id) ? String(r.id) : "";
        const updatedAt = gmtOf(r.modified_gmt);
        if (id === "" || updatedAt === undefined)
          throw new AdapterCouldNotCheck(
            "WordPress answered with items that have no id or no update time.",
          );
        // The server may ignore modified_after (older WordPress): the filter is made here as well.
        if (since !== undefined && updatedAt < since) continue;
        const fieldHashes: Record<string, string> = {};
        for (const f of fields) {
          const h = hashValue(valueAt(r, f));
          if (h !== undefined) fieldHashes[f] = h;
        }
        const slug = typeof r.slug === "string" && r.slug !== "" ? r.slug : undefined;
        const publishedAt = gmtOf(r.date_gmt);
        let url = resolveUrl({ id, type, ...(slug !== undefined ? { slug } : {}) });
        if (url === "" && templateFor(type) === undefined && typeof r.link === "string") {
          try {
            const link = new URL(r.link);
            url = `${link.pathname}${link.search}`;
          } catch {
            url = "";
          }
        }
        remaining--;
        delivered++;
        yield {
          id,
          type,
          ...(url !== "" ? { url } : {}),
          ...(slug !== undefined ? { slug } : {}),
          ...(publishedAt !== undefined ? { publishedAt } : {}),
          updatedAt,
          fieldHashes,
        };
        if (remaining <= 0) return;
      }
    }
  }

  const draftsReachable = async (): Promise<boolean> => {
    let seen = false;
    let asked = 0;
    let failure: Error | undefined;
    for (const base of ["posts", "pages"]) {
      try {
        const { headers } = await read(
          base,
          { status: UNPUBLISHED, per_page: "1", _fields: "id" },
          true,
          undefined,
        );
        asked++;
        if (total(headers, "unpublished items") > 0) seen = true;
      } catch (err) {
        // A Contributor may list posts and not pages: one refusal is fine when the other answered.
        if (!(err instanceof AdapterCouldNotCheck)) throw err;
        failure ??= err;
      }
    }
    if (asked === 0 && failure) throw failure;
    return seen;
  };

  const members = async (): Promise<AdapterMember[]> => {
    const out: AdapterMember[] = [];
    for (let page = 1; out.length < MEMBER_CAP; page++) {
      const { body, headers } = await read(
        "users",
        {
          context: "edit",
          per_page: String(pageSize),
          page: String(page),
          _fields: "id,email,roles",
        },
        true,
        undefined,
      );
      if (!Array.isArray(body))
        throw new AdapterCouldNotCheck("WordPress answered with something that is not a list.");
      for (const row of body) {
        const r = isRecord(row) ? row : {};
        const roles = Array.isArray(r.roles)
          ? r.roles.filter((x): x is string => typeof x === "string")
          : [];
        // The highest role a user holds: an administrator who is also an editor is an administrator.
        const mapped = roles.map((x) => ROLES[x] ?? "unknown");
        const role: Role = mapped.includes("admin")
          ? "admin"
          : (mapped.find((x) => x !== "unknown") ?? "unknown");
        out.push({
          emailMasked:
            typeof r.email === "string" && r.email !== "" ? maskEmail(r.email) : NO_ADDRESS,
          role,
        });
      }
      const pagesTotal = Number(headers["x-wp-totalpages"]);
      if (
        body.length === 0 ||
        (Number.isSafeInteger(pagesTotal) ? page >= pagesTotal : body.length < pageSize)
      )
        break;
    }
    return out.slice(0, MEMBER_CAP);
  };

  const installed = async (): Promise<WordPressData> => {
    const plugins: { slug: string; version?: string }[] = [];
    const themes: { slug: string; version?: string }[] = [];
    const list = await read("plugins", { _fields: "plugin,status,version" }, true, undefined);
    if (!Array.isArray(list.body))
      throw new AdapterCouldNotCheck(
        "WordPress answered with something that is not a list of plugins.",
      );
    for (const row of list.body) {
      if (!isRecord(row) || row.status !== "active" || typeof row.plugin !== "string") continue;
      // "easy-booking/easy-booking" is folder/file; a single-file plugin is just "hello".
      const slug = (row.plugin.split("/")[0] ?? "").replace(/\.php$/, "").toLowerCase();
      if (slug === "") continue;
      plugins.push({
        slug,
        ...(typeof row.version === "string" && row.version !== "" ? { version: row.version } : {}),
      });
    }
    const active = await read(
      "themes",
      { status: "active", _fields: "stylesheet,version" },
      true,
      undefined,
    );
    if (!Array.isArray(active.body))
      throw new AdapterCouldNotCheck(
        "WordPress answered with something that is not a list of themes.",
      );
    for (const row of active.body) {
      if (!isRecord(row) || typeof row.stylesheet !== "string") continue;
      // Since WordPress 5.9 a theme's version is { raw, rendered }; before, a string.
      const v = isRecord(row.version) ? row.version.raw : row.version;
      themes.push({
        slug: row.stylesheet.toLowerCase(),
        ...(typeof v === "string" && v !== "" ? { version: v } : {}),
      });
    }
    return { host: site().hostname, plugins, themes };
  };

  return {
    id: "wordpress",
    describe: () => WORDPRESS_DESCRIPTION,
    types,
    fieldCounts,
    published,
    draftsReachable,
    members,
    resolveUrl,
    installed,
  };
}
