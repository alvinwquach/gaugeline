import path from "node:path";
import { ResponseTooLargeError } from "../connectors/get-json.js";
import {
  ConnectorRateLimitedError,
  ConnectorRefusedError,
  ConnectorStatusError,
} from "../connectors/http.js";
import { createRedactor } from "../connectors/redact.js";
import type { Env } from "../connectors/types.js";
import type { Fetcher } from "../fetcher.js";
import { GITHUB_TOKEN_VAR } from "../renewals/tokens.js";
import { hashValue } from "./fingerprint.js";
import {
  addressFromFrontMatter,
  expandPermalink,
  namesOf,
  nuxtPath,
  type PermalinkValues,
} from "./git-content-permalink.js";
import { hasValue, isoOf, kindOf, parseContent, stateOf, valueAt } from "./git-content-parse.js";
import {
  FileNotRead,
  GIT_CONTENT_LIMITS,
  githubSource,
  localSource,
  type ContentSource,
  type SourceFile,
  type Unread,
} from "./git-content-source.js";
import {
  AdapterCouldNotCheck,
  AdapterRateLimitedError,
  type AdapterDescription,
  type AdapterSettings,
  type ContentAdapter,
  type PublishedDoc,
  type PublishedOptions,
  type TypeCount,
} from "./types.js";

/**
 * Content kept in a repository: Markdown and MDX with front matter, JSON and YAML files. It reads a
 * folder on this computer (no key at all) or a repository on GitHub (an optional token with Contents:
 * read). The line in a run header names the key kind for the GitHub token; a local folder sends nothing.
 */
export const GIT_CONTENT_DESCRIPTION: AdapterDescription = {
  name: "Content kept in git",
  docsUrl: "https://gaugeline.dev/docs/integrations/git-content",
  keyKind: "read-only",
};

export { GIT_CONTENT_LIMITS };
export { GITHUB_TOKEN_VAR as GIT_CONTENT_TOKEN };

/** A file that was there and was not read, with why. `reason` never quotes the file. */
export type GitContentUnread = Unread;

/** The most unread files kept for the report; the count is kept in full. */
const UNREAD_KEPT = 50;

export interface GitContentAdapter extends ContentAdapter {
  /**
   * Files seen by the reads so far that were not read, with why (front matter that is not valid YAML,
   * TOML front matter, a file over the size bound, a link). They are not in `published()`; a caller shows
   * them as could-not-check so a broken file is never taken for a page that is not there.
   */
  unread(): { total: number; files: GitContentUnread[] };
}

export interface GitContentOptions {
  /** GAUGELINE_GITHUB_TOKEN, already copied (see freezeEnv), for a GitHub source only. */
  env: Env;
  /** Used for a GitHub source. A local folder never makes a request. */
  fetcher: Fetcher;
  /** The settings entry: `path` or `github`, `folders`, `fingerprint`. */
  settings: AdapterSettings | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /** What "now" is for scheduled and expired items. Default: the real time. */
  now?: (() => Date) | undefined;
  /** What a relative `path` is relative to. Default: the working folder. */
  cwd?: string | undefined;
  /** Replaces GIT_CONTENT_LIMITS. For tests. */
  limits?: typeof GIT_CONTENT_LIMITS | undefined;
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Item {
  id: string;
  data: Record<string, unknown>;
  slug?: string;
  url?: string;
  publishedAt?: string;
  updatedAt?: string;
}

export function createGitContentAdapter(options: GitContentOptions): GitContentAdapter {
  const { env, fetcher } = options;
  const settings = options.settings;
  const sleep = options.sleep ?? wait;
  const now = options.now ?? (() => new Date());
  const limits = options.limits ?? GIT_CONTENT_LIMITS;
  const redact = createRedactor(env, [GITHUB_TOKEN_VAR]);
  const folders = settings?.folders ?? {};
  const typeNames = Object.keys(folders).sort();
  const unreadSeen = new Map<string, string>();

  const noteUnread = (u: Unread): void => {
    if (!unreadSeen.has(u.path)) unreadSeen.set(u.path, u.reason);
  };

  let sourceMade: ContentSource | undefined;
  const source = (): ContentSource => {
    if (sourceMade) return sourceMade;
    if (settings?.github !== undefined)
      sourceMade = githubSource({
        fetcher,
        repo: settings.github.repo,
        ref: settings.github.ref,
        token: env[GITHUB_TOKEN_VAR],
        sleep,
        limits,
      });
    else if (settings?.path !== undefined)
      sourceMade = localSource(path.resolve(options.cwd ?? process.cwd(), settings.path), limits);
    else
      throw new AdapterCouldNotCheck(
        'gaugeline.adapters.json: the git-content adapter needs "path" (a folder on this computer) or "github".',
      );
    return sourceMade;
  };

  /** What a failed read becomes: a rate limit carries what was read, anything else is could-not-check. */
  const translate = (err: unknown, partial: unknown): Error => {
    if (err instanceof AdapterCouldNotCheck || err instanceof AdapterRateLimitedError) return err;
    if (err instanceof ConnectorRateLimitedError)
      return new AdapterRateLimitedError(partial, err.retry);
    if (err instanceof ResponseTooLargeError) return new AdapterCouldNotCheck(err.message);
    if (err instanceof ConnectorRefusedError)
      return new AdapterCouldNotCheck(
        err.status === 401
          ? `GitHub did not accept ${GITHUB_TOKEN_VAR} (HTTP 401). Check that the token is current.`
          : `GitHub did not let this read the repository (HTTP ${err.status}). A token needs Contents: read on it, and an unauthenticated read is limited to 60 requests an hour.`,
      );
    if (err instanceof ConnectorStatusError)
      return new AdapterCouldNotCheck(
        err.status === 404
          ? `GitHub answered HTTP 404: there is no such repository or branch, or it is private and ${GITHUB_TOKEN_VAR} is not set or cannot read it.`
          : `GitHub answered HTTP ${err.status}.`,
      );
    return new AdapterCouldNotCheck(redact(err instanceof Error ? err.message : String(err)));
  };

  const dirOf = (type: string): string => {
    const d = folders[type]?.dir ?? ".";
    return d === "." ? "" : d.replace(/^\.\//, "");
  };

  /** One record of a file as an item, with its address; undefined when the pattern needs what it lacks. */
  const itemOf = (
    type: string,
    file: SourceFile,
    data: Record<string, unknown>,
    id: string,
    publishedAt: string | undefined,
    updatedAt: string | undefined,
  ): Item => {
    const dir = dirOf(type);
    const inFolder = dir === "" ? file.path : file.path.slice(dir.length + 1);
    const names = namesOf(inFolder);
    const slugField = data.slug;
    const slug =
      typeof slugField === "string" && slugField.trim() !== "" ? slugField.trim() : names.title;
    const date =
      names.date ??
      (publishedAt === undefined
        ? undefined
        : {
            year: publishedAt.slice(0, 4),
            month: publishedAt.slice(5, 7),
            day: publishedAt.slice(8, 10),
          });
    const cats = data.categories ?? data.category;
    const categories = Array.isArray(cats)
      ? cats.filter((c): c is string => typeof c === "string").join("/")
      : typeof cats === "string"
        ? cats.trim().split(/\s+/).join("/")
        : "";
    const values: PermalinkValues = {
      slug,
      slugorfilename: slug,
      id: file.path,
      path: names.path,
      nuxt_path: nuxtPath(names.path),
      filename: names.filename,
      title: names.title,
      section: dir.split("/").at(-1) ?? "",
      categories,
      output_ext: ".html",
      ...(date ? { year: date.year, month: date.month, day: date.day } : {}),
    };
    const setting = folders[type]?.permalink;
    const url =
      addressFromFrontMatter(data.url, values) ??
      addressFromFrontMatter(data.permalink, values) ??
      (setting === undefined ? "" : expandPermalink(setting, values));
    return {
      id,
      data,
      slug,
      ...(url !== "" ? { url } : {}),
      ...(publishedAt !== undefined ? { publishedAt } : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {}),
    };
  };

  /**
   * The published items of one folder, a file at a time. A file that cannot be read is noted and skipped,
   * not taken for an item that is not there. Data stays in memory only until the item is hashed or counted.
   */
  async function* itemsOf(type: string, partial: () => unknown): AsyncGenerator<Item> {
    const nowMs = now().getTime();
    let listing;
    try {
      listing = await source().list(dirOf(type));
    } catch (err) {
      throw translate(err, partial());
    }
    for (const u of listing.unread) noteUnread(u);
    for (const file of listing.files) {
      const kind = kindOf(file.path);
      if (kind === undefined) continue;
      let text: string;
      try {
        text = await source().read(file);
      } catch (err) {
        if (err instanceof FileNotRead) {
          noteUnread({ path: file.path, reason: err.message });
          continue;
        }
        throw translate(err, partial());
      }
      const parsed = parseContent(text, kind);
      if (!parsed.ok) {
        noteUnread({ path: file.path, reason: parsed.reason });
        continue;
      }
      for (const [i, data] of parsed.records.entries()) {
        const state = stateOf(data, nowMs);
        if (!state.published) continue;
        // A file is an item with the file's path as its id; a list of records in one file adds the position.
        const id = parsed.list ? `${file.path}#${i}` : file.path;
        yield itemOf(type, file, data, id, state.publishedAt, state.updatedAt);
      }
    }
  }

  const types = async (): Promise<TypeCount[]> => {
    const out: TypeCount[] = [];
    for (const name of typeNames) {
      let count = 0;
      for await (const item of itemsOf(name, () => out.slice())) count += item.id === "" ? 0 : 1;
      out.push({ name, count });
    }
    return out;
  };

  const fieldCounts = async (
    type: string,
    fields: readonly string[],
  ): Promise<Record<string, number>> => {
    const out: Record<string, number> = Object.fromEntries(fields.map((f) => [f, 0]));
    if (!typeNames.includes(type)) return out;
    for await (const item of itemsOf(type, () => ({ ...out })))
      for (const f of fields) if (hasValue(valueAt(item.data, f))) out[f] = (out[f] ?? 0) + 1;
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
    for (const type of typeNames) {
      if (opts.types !== undefined && !opts.types.includes(type)) continue;
      if (remaining <= 0) return;
      const fields = opts.fields?.[type] ?? settings?.fingerprint?.[type] ?? [];
      for await (const item of itemsOf(type, () => delivered)) {
        const changed = item.updatedAt ?? item.publishedAt;
        // An item with no date at all cannot be shown to be older than `since`, so it is kept.
        if (since !== undefined && changed !== undefined && Date.parse(changed) < Date.parse(since))
          continue;
        const fieldHashes: Record<string, string> = {};
        for (const f of fields) {
          const h = hashValue(valueAt(item.data, f));
          if (h !== undefined) fieldHashes[f] = h;
        }
        remaining--;
        delivered++;
        yield {
          id: item.id,
          type,
          ...(item.url !== undefined ? { url: item.url } : {}),
          ...(item.slug !== undefined ? { slug: item.slug } : {}),
          ...(item.publishedAt !== undefined ? { publishedAt: item.publishedAt } : {}),
          ...(item.updatedAt !== undefined ? { updatedAt: item.updatedAt } : {}),
          fieldHashes,
        };
        if (remaining <= 0) return;
      }
    }
  }

  return {
    id: "git-content",
    describe: () => GIT_CONTENT_DESCRIPTION,
    types,
    fieldCounts,
    published,
    // A repository has no unpublished work a key could reach: a draft is a file in the same folder.
    draftsReachable: () => Promise.resolve("not-applicable"),
    unread: () => ({
      total: unreadSeen.size,
      files: [...unreadSeen].slice(0, UNREAD_KEPT).map(([p, reason]) => ({ path: p, reason })),
    }),
  };
}
