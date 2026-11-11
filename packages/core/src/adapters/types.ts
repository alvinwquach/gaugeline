import type { Role } from "../handoff/types.js";

/**
 * The kind of key an adapter asks for, which is the narrowest the platform offers:
 * - read-only: a key that can only read (a Viewer token, a delivery token, a public API).
 * - scoped: a key limited to what Gaugeline needs, though the platform cannot make it read-only.
 * - full-access: the platform has nothing narrower; Gaugeline only reads with it, but it could do more.
 * It is shown in the run header and in docs/integrations, so a person knows what they are handing over.
 */
export type KeyKind = "read-only" | "scoped" | "full-access";

export const KEY_KINDS: readonly KeyKind[] = ["read-only", "scoped", "full-access"];

export interface AdapterDescription {
  /** The platform's name as a person writes it ("Sanity"). */
  name: string;
  /** The page that lists the read endpoints used and how to make the narrowest key. */
  docsUrl: string;
  keyKind: KeyKind;
  /**
   * The adapter asks for no key at all: it reads what the site already shows every visitor. The run
   * header then says "with no key" instead of naming a kind. `keyKind` stays "read-only", because
   * nothing it does can change anything.
   */
  noKey?: true;
  /**
   * With `noKey`: the adapter reads content (ids, dates and field hashes) from a public API, not pages from a
   * sitemap, so `--published` gives it the changed-since window and the fields to compare, like a keyed adapter.
   */
  fingerprintsFields?: true;
  /**
   * The adapter reads without a key and reads more with one (a key in the environment turns it on). The run
   * header says both. `keyKind` is the kind of the key it asks for when one is set.
   */
  optionalKey?: true;
  /**
   * The adapter is beta because the platform's own API is. The run header says "(beta)" after the name,
   * and the adapter's docs page says what may change.
   */
  beta?: true;
}

/** How many published documents a type has. A count, never a document. */
export interface TypeCount {
  name: string;
  count: number;
}

/**
 * One published item as a fingerprint: where it is and when it changed, never what it says.
 * `fieldHashes` maps a configured field name to a short hash of its value; a field the item does
 * not have is left out, not hashed as empty. Two runs over unchanged content give the same hashes.
 */
export interface PublishedDoc {
  id: string;
  type: string;
  /** The item's address or path, when the platform or the settings say where it lives. */
  url?: string;
  slug?: string;
  /** ISO 8601, UTC, when the platform gives a publish date. */
  publishedAt?: string;
  /**
   * ISO 8601, UTC. Absent when the platform does not say, which only an adapter reading public pages
   * (the sitemap and feed adapter) can be asked for: a made-up date would be worse than none.
   */
  updatedAt?: string;
  fieldHashes: Record<string, string>;
}

export interface PublishedOptions {
  /** Only these types. Default: every type the adapter lists. */
  types?: readonly string[];
  /** Only items changed at or after this time (ISO 8601). */
  since?: string;
  /** At most this many items in all. */
  limit?: number;
  /** The fields to hash, by type. Overrides the settings entry for a type named here. */
  fields?: Readonly<Record<string, readonly string[]>>;
}

/** A person with access to the platform, as the report may show them: a masked address and a role. */
export interface AdapterMember {
  emailMasked: string;
  role: Role;
}

/**
 * Read-only access to what a content system says is published, as counts and fingerprints.
 * Every method only reads (GET or HEAD, or a GraphQL query, through the fetcher). A method throws
 * AdapterCouldNotCheck when the platform will not say, and AdapterRateLimitedError, carrying what was
 * gathered, when it was told to slow down and waiting did not help.
 */
export interface ContentAdapter {
  /** Lower case, digits and hyphens: the name used in gaugeline.adapters.json. */
  readonly id: string;
  /**
   * True when this instance reads the live site's pages (a sitemap or feed) instead of a platform's own
   * collections: its items' addresses are pages and it has no fields. An adapter that reads pages in every
   * mode says so with `describe().noKey`; one that does so only without a key (Wix) sets this on the instance.
   */
  readonly readsPages?: boolean;
  describe(): AdapterDescription;
  /** Every content type with how many published items it has. */
  types(): Promise<TypeCount[]>;
  /** For each field, how many published items of the type have it. A field no item has counts 0. */
  fieldCounts(type: string, fields: readonly string[]): Promise<Record<string, number>>;
  published(options?: PublishedOptions): AsyncIterable<PublishedDoc>;
  /** Can the key reach unpublished work? "not-applicable" for a platform with no draft concept. */
  draftsReachable(): Promise<boolean | "not-applicable">;
  /** Who has access, when the platform lists it and the key may read it. */
  members?(): Promise<AdapterMember[]>;
  /** The address of an item, from its id, type and slug and the settings. */
  resolveUrl?(doc: Pick<PublishedDoc, "id" | "type" | "slug">): string;
}

/**
 * The platform would not say, or was not asked: no key, a key that may not read this, an answer
 * Gaugeline cannot read. `reason` is plain text with every key blanked. Never a pass.
 */
export class AdapterCouldNotCheck extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "AdapterCouldNotCheck";
    this.reason = reason;
  }
}

/**
 * The platform asked Gaugeline to slow down and waiting (when it said how long, and the wait was
 * short) did not help. `partial` is what had been gathered: the types counted, the field counts
 * read, or the number of items already delivered by published().
 */
export class AdapterRateLimitedError<T = unknown> extends Error {
  readonly retry: string | undefined;
  readonly partial: T;
  constructor(partial: T, retry?: string) {
    super(
      `The platform asked Gaugeline to slow down (HTTP 429).${retry ? ` Try again ${retry}.` : " It did not say when to try again."} What was read before that is kept.`,
    );
    this.name = "AdapterRateLimitedError";
    this.retry = retry;
    this.partial = partial;
  }
}

/** The settings entry for one adapter, from `adapters` in gaugeline.adapters.json. */
export interface AdapterSettings {
  id: string;
  /** Fields to hash, by type: `{ "post": ["title", "slug.current"] }`. With none, no field value is read at all. */
  fingerprint?: Readonly<Record<string, readonly string[]>> | undefined;
  /** Where an item lives, by type: "/blog/{slug}". `{slug}` and `{id}` are filled in. */
  urls?: Readonly<Record<string, string>> | undefined;
  /** Only `sitemap-feed`: the site's address, when the run was not given one. */
  site?: string | undefined;
  /** Only `wix`: the Wix site's id, sent as the wix-site-id header with the API key. */
  siteId?: string | undefined;
  /** Only `sitemap-feed`: sitemap files to read instead of looking (a path or an address on the site). */
  sitemaps?: readonly string[] | undefined;
  /** Only `sitemap-feed`: feeds to read instead of looking (a path or an address on the site). */
  feeds?: readonly string[] | undefined;
  /**
   * Only `umbraco`: the owner says the Delivery API is meant to be private. The probing check
   * `umbraco-delivery-api-public` runs only when this is true; a key being set says nothing of it.
   */
  expectPrivate?: boolean | undefined;
  /**
   * Only `datocms`: the GraphQL collection to read for each content type, because the Content Delivery API has no
   * list of types to ask: `{ "classes": { "collection": "allClasses", "slug": "slug" } }`. `slug` names the field
   * that holds the item's slug; without it the item has none.
   */
  collections?:
    Readonly<Record<string, { collection: string; slug?: string | undefined }>> | undefined;
  /**
   * Only `datocms`: the owner says the token is meant for published content only. Switches on the check that asks
   * whether it can also read drafts.
   */
  expectPublishedOnly?: boolean | undefined;
  /**
   * Only `datocms`: the check names the ids of the unpublished records it finds (at most five). Without it a
   * finding is a count.
   */
  showDraftIds?: boolean | undefined;
  /** Only `git-content`: the repository's folder on this computer, relative to where the run starts. */
  path?: string | undefined;
  /** Only `git-content`: a repository on GitHub, read with GET. Instead of `path`. */
  github?: { repo: string; ref?: string | undefined } | undefined;
  /** Only `git-content`: the content folders, by type, with the pattern that gives an item its address. */
  folders?: Readonly<Record<string, { dir: string; permalink?: string | undefined }>> | undefined;
}
