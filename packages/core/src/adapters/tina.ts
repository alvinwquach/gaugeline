import type { Env } from "../connectors/types.js";
import type { Fetcher } from "../fetcher.js";
import { createRedactor } from "../connectors/redact.js";
import { GITHUB_TOKEN_VAR } from "../renewals/tokens.js";
import {
  contentSourceOf,
  createGitContentAdapter,
  sourceErrorOf,
  type GitContentAdapter,
} from "./git-content.js";
import { FileNotRead, GIT_CONTENT_LIMITS, type ContentSource } from "./git-content-source-read.js";
import { readTinaConfig, type TinaCollection, type TinaNotRead } from "./tina-config-read.js";
import { TINA_DESCRIPTION } from "./tina.entry.js";
import {
  AdapterCouldNotCheck,
  type AdapterSettings,
  type ContentAdapter,
  type PublishedDoc,
  type PublishedOptions,
  type TypeCount,
} from "./types.js";

export { TINA_DESCRIPTION };

/** Where TinaCMS keeps its schema, in the order they are tried. The first one that is there is read, as text. */
export const TINA_CONFIG_FILES = [
  "tina/config.ts",
  "tina/config.tsx",
  "tina/config.js",
  "tina/config.jsx",
] as const;

/** Why TinaCloud is not read, in plain words (shown when the config names a TinaCloud client). */
export const TINACLOUD_NOT_READ =
  "TinaCloud is configured, but its content API is not read: this adapter reads the content files in the repository, which TinaCloud mirrors from git, and does not use the TinaCloud client token.";

export interface TinaAdapter extends ContentAdapter {
  /**
   * What was not read, with why: a collection written outside tina/config.ts, an address Gaugeline cannot
   * work out, TinaCloud. Fixed sentences: nothing in them comes from the config or from content.
   */
  notRead(): Promise<TinaNotRead[]>;
  /** Content files that were there and were not read (git-content's list). */
  unread(): ReturnType<GitContentAdapter["unread"]>;
}

export interface TinaAdapterOptions {
  /** GAUGELINE_GITHUB_TOKEN for a GitHub source (read-only, Contents: read), already copied. A local folder needs none. */
  env: Env;
  fetcher: Fetcher;
  /**
   * `path` or `github` (the repository), `fingerprint`, and optionally `folders`: collections named by hand,
   * which win over the same name in tina/config.ts and stand in for it when it cannot be read.
   */
  settings: AdapterSettings | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  now?: (() => Date) | undefined;
  cwd?: string | undefined;
  site?: string | undefined;
  limits?: typeof GIT_CONTENT_LIMITS | undefined;
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Prepared {
  inner: GitContentAdapter;
  notRead: TinaNotRead[];
}

/**
 * TinaCMS keeps its content in git (Markdown, MDX, JSON, YAML) and describes it in `tina/config.ts`. This
 * adapter reads that config as text (never runs it) to learn the collections, then reads each collection's
 * folder through the git-content adapter: the same source (a local folder or GitHub, GET only), parser and
 * address patterns. A Map from collection name to its folder keeps one entry per name, and a name written in
 * the settings replaces the same name read from the config.
 */
export function createTinaAdapter(options: TinaAdapterOptions): TinaAdapter {
  const { settings } = options;
  const sleep = options.sleep ?? wait;
  const limits = options.limits ?? GIT_CONTENT_LIMITS;

  let prepared: Promise<Prepared> | undefined;
  const prepare = (): Promise<Prepared> => {
    prepared ??= build();
    // A failed read is not kept: the next call asks again.
    prepared.catch(() => {
      prepared = undefined;
    });
    return prepared;
  };

  async function build(): Promise<Prepared> {
    const source: ContentSource = contentSourceOf({
      env: options.env,
      fetcher: options.fetcher,
      settings,
      sleep,
      limits,
      adapterId: "tina",
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    });

    const byHand = settings?.folders ?? {};
    const collections = new Map<string, TinaCollection>();
    const notRead: TinaNotRead[] = [];

    const redact = createRedactor(options.env, [GITHUB_TOKEN_VAR]);
    let configFile;
    try {
      for (const candidate of TINA_CONFIG_FILES) {
        configFile = await source.find(candidate);
        if (configFile !== undefined) break;
      }
    } catch (err) {
      throw sourceErrorOf(err, [], redact);
    }
    if (configFile === undefined) {
      if (Object.keys(byHand).length === 0)
        throw new AdapterCouldNotCheck(
          'There is no tina/config.ts (or .tsx, .js, .jsx) in the repository, so the collections are not known. Point "path" or "github" at the folder that holds the tina folder, or name the folders by hand in "folders".',
        );
    } else {
      const text = await source.read(configFile).catch((err: unknown) => {
        // A file that is too big or no longer a plain file is not read; anything else is the source failing.
        if (err instanceof FileNotRead) return undefined;
        throw sourceErrorOf(err, [], redact);
      });
      const read =
        text === undefined
          ? ({ ok: false, reason: "tina/config.ts could not be read as a plain file" } as const)
          : readTinaConfig(text);
      if (!read.ok) {
        if (Object.keys(byHand).length === 0)
          throw new AdapterCouldNotCheck(
            read.reason + '. Name the folders by hand in "folders" to read them anyway.',
          );
        notRead.push({ name: "tina/config.ts", reason: read.reason, kind: "collection" });
      } else {
        for (const c of read.collections) collections.set(c.name, c);
        notRead.push(...read.notRead);
        if (read.tinaCloud)
          notRead.push({ name: "TinaCloud", reason: TINACLOUD_NOT_READ, kind: "collection" });
      }
    }

    const folders: Record<string, { dir: string; permalink?: string | undefined }> = {};
    const accept: Record<string, (p: string) => boolean> = {};
    for (const c of collections.values()) {
      folders[c.name] = {
        dir: c.dir,
        ...(c.permalink !== undefined ? { permalink: c.permalink } : {}),
      };
      accept[c.name] = c.accepts;
    }
    // A collection named by hand replaces the one read from the config, and brings no file filter: it is read as a folder.
    for (const [name, f] of Object.entries(byHand)) {
      folders[name] = f;
      delete accept[name];
      const at = notRead.findIndex((n) => n.name === name);
      if (at >= 0) notRead.splice(at, 1);
    }
    if (Object.keys(folders).length === 0)
      throw new AdapterCouldNotCheck(
        notRead.find((n) => n.kind === "collection")?.reason ??
          "tina/config.ts has no collection Gaugeline could read.",
      );

    const inner = createGitContentAdapter({
      env: options.env,
      fetcher: options.fetcher,
      sleep,
      source,
      limits,
      accept,
      settings: {
        id: "tina",
        ...(settings?.fingerprint !== undefined ? { fingerprint: settings.fingerprint } : {}),
        folders,
      },
      ...(options.now ? { now: options.now } : {}),
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.site !== undefined ? { site: options.site } : {}),
    });
    return { inner, notRead };
  }

  let last: GitContentAdapter | undefined;
  const innerOf = async (): Promise<GitContentAdapter> => {
    last = (await prepare()).inner;
    return last;
  };

  async function* published(opts: PublishedOptions = {}): AsyncGenerator<PublishedDoc> {
    yield* (await innerOf()).published(opts);
  }

  return {
    id: "tina",
    describe: () => TINA_DESCRIPTION,
    types: async (): Promise<TypeCount[]> => (await innerOf()).types(),
    fieldCounts: async (type, fields) => (await innerOf()).fieldCounts(type, fields),
    published,
    // A repository has no unpublished work a key could reach: a draft is a file with `draft: true`.
    draftsReachable: () => Promise.resolve("not-applicable"),
    notRead: async () => (await prepare()).notRead,
    unread: () => last?.unread() ?? { total: 0, files: [] },
  };
}
