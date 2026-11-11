import { ConnectorRateLimitedError, ConnectorRefusedError } from "../connectors/http.js";
import { createRedactor } from "../connectors/redact.js";
import {
  SANITY_TOKEN,
  createSanityRead,
  sanitySettings,
  type SanityRead,
} from "../connectors/sanity.js";
import type { Env } from "../connectors/types.js";
import { sanityImageUses, type SanityImageUrl } from "../checks/images/sanity-url.js";
import type { Fetcher } from "../fetcher.js";
import type { PageSnapshot } from "../snapshot.js";

/**
 * What the Sanity image checks that need the dataset read: for each upload a page uses, its size in
 * bytes (the asset document's `size`) and the crop, hotspot and alt text the editors set on the image
 * values that point at it. Two kinds of GROQ query, both one GET through the Sanity reader the adapter
 * uses (published perspective, the token in a header): the size query over the asset documents, and a
 * query for the published documents that refer to a batch of assets, whose image values are reduced
 * to numbers and one yes or no the moment they arrive. No text an editor wrote is kept, printed or
 * stored. Every id that reaches a query is rebuilt from the parts of an address and tested against a
 * strict pattern first; nothing else from the page is ever put into GROQ.
 */

/** Uploads read in one run. More are counted and listed as not read, never guessed at. */
export const SANITY_ASSET_CAP = 100;
/** Asset ids asked for their size in one request. */
export const SIZE_BATCH = 40;
/** Asset ids asked for the documents that refer to them in one request. */
export const USES_BATCH = 10;
/** Documents one uses request may return before the read says it is not the whole. */
export const USES_DOCS_PER_BATCH = 30;
/** Values looked at in one document before it is called too big to read. */
const NODE_CAP = 50_000;
const DEPTH_CAP = 24;

/** Asset document ids are `image-<hash>-<width>x<height>-<format>`: letters and digits, then a size and a format. */
const ASSET_ID = /^image-[A-Za-z0-9]{8,64}-\d{1,6}x\d{1,6}-[a-z0-9]{2,5}$/;

/** The asset document id an address names, or undefined when its parts are not the shape of one. */
export function assetDocumentId(p: SanityImageUrl): string | undefined {
  const id = `image-${p.assetId}-${p.width}x${p.height}-${p.format}`;
  return ASSET_ID.test(id) ? id : undefined;
}

/** An image value in a published document that points at an asset: what the editors set on it, as numbers. */
export interface StudioUse {
  /** The crop the editor drew, as fractions of each edge (0 to 1), when there is one. */
  crop?: { left: number; top: number; right: number; bottom: number };
  /** The hotspot's centre, as fractions of the width and height (0 to 1), when there is one. */
  hotspot?: { x: number; y: number };
  /** Whether the value has an `alt` field with text in it. The text itself is never kept. */
  alt: boolean;
}

/** What was read of one upload. A part that could not be read has its reason and no value. */
export interface AssetRead {
  /** The upload's size in bytes, a whole number. */
  size?: number;
  sizeProblem?: string;
  /** Every image value in the published documents that points at the upload. */
  uses?: StudioUse[];
  usesProblem?: string;
}

export interface SanityImageRead {
  /** The project and dataset the environment names: the only ones the token is sent to. */
  project: string | undefined;
  dataset: string | undefined;
  /** Keyed by asset document id. Sorted by id, so the same page gives the same read. */
  assets: Map<string, AssetRead>;
  /** Why nothing could be read at all (no project id, a refused token, a rate limit). */
  problem?: string;
  /** Uploads on the page that belong to another project or dataset: never asked, the token is not theirs. */
  foreign: string[];
  /** Uploads left out because a run reads at most SANITY_ASSET_CAP. */
  skipped: number;
}

export interface SanityImageOptions {
  page: Pick<PageSnapshot, "images" | "finalUrl">;
  /** SANITY_PROJECT_ID, SANITY_DATASET and SANITY_TOKEN, already copied (see freezeEnv). */
  env: Env;
  fetcher: Fetcher;
  /** How a short Retry-After is waited out. Tests pass a stand-in that does not wait. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const fraction = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? v : undefined;

/** The `_id in [...]` query for the size of a batch of uploads. Ids are tested again here. */
export function sizeQuery(ids: readonly string[]): string {
  if (ids.length === 0 || !ids.every((id) => ASSET_ID.test(id)))
    throw new TypeError("Not an asset document id.");
  return `*[_type == "sanity.imageAsset" && _id in [${ids.map((id) => JSON.stringify(id)).join(",")}]]{_id,size}`;
}

/** The query for the published documents that refer to a batch of uploads (one more than the cap, to see an overflow). */
export function usesQuery(ids: readonly string[]): string {
  if (ids.length === 0 || !ids.every((id) => ASSET_ID.test(id)))
    throw new TypeError("Not an asset document id.");
  const refs = ids.map((id) => `references(${JSON.stringify(id)})`).join(" || ");
  return `*[_type != "sanity.imageAsset" && (${refs})][0...${USES_DOCS_PER_BATCH + 1}]`;
}

/**
 * The image values in one document that point at one of `wanted`: any object with `asset._ref` set.
 * Reduced at once to numbers and a yes or no; the document itself is not kept. Returns undefined when
 * the document is too large or too deep to read to the end.
 */
export function studioUses(
  doc: unknown,
  wanted: ReadonlySet<string>,
): Array<{ id: string; use: StudioUse }> | undefined {
  const out: Array<{ id: string; use: StudioUse }> = [];
  const stack: Array<{ value: unknown; depth: number }> = [{ value: doc, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const { value, depth } = stack.pop() as { value: unknown; depth: number };
    if (++nodes > NODE_CAP || depth > DEPTH_CAP) return undefined;
    if (Array.isArray(value)) {
      for (const v of value) stack.push({ value: v, depth: depth + 1 });
      continue;
    }
    if (!isRecord(value)) continue;
    const asset = value.asset;
    const ref = isRecord(asset) ? asset._ref : undefined;
    if (typeof ref === "string" && wanted.has(ref)) {
      const c = isRecord(value.crop) ? value.crop : undefined;
      const left = fraction(c?.left);
      const top = fraction(c?.top);
      const right = fraction(c?.right);
      const bottom = fraction(c?.bottom);
      const h = isRecord(value.hotspot) ? value.hotspot : undefined;
      const x = fraction(h?.x);
      const y = fraction(h?.y);
      out.push({
        id: ref,
        use: {
          ...(left !== undefined && top !== undefined && right !== undefined && bottom !== undefined
            ? { crop: { left, top, right, bottom } }
            : {}),
          ...(x !== undefined && y !== undefined ? { hotspot: { x, y } } : {}),
          alt: typeof value.alt === "string" && value.alt.trim() !== "",
        },
      });
    }
    for (const [key, v] of Object.entries(value)) {
      if (key === "asset") continue;
      stack.push({ value: v, depth: depth + 1 });
    }
  }
  return out;
}

type Asked = { ok: true; rows: unknown[] } | { ok: false; reason: string; stop: boolean };

/**
 * Reads the uploads a page uses, with the dataset the environment names. Never throws: every way a read
 * can fall short is a reason on the asset it affects, or `problem` when nothing could be read, so a
 * check can say could not check and never reports a pass for what was not read.
 */
export async function readSanityImages(options: SanityImageOptions): Promise<SanityImageRead> {
  const { env, fetcher } = options;
  const redact = createRedactor(env, [SANITY_TOKEN]);
  const empty = (problem: string, extra: Partial<SanityImageRead> = {}): SanityImageRead => ({
    project: undefined,
    dataset: undefined,
    assets: new Map(),
    foreign: [],
    skipped: 0,
    problem: redact(problem),
    ...extra,
  });

  let project: string;
  let dataset: string;
  try {
    const s = sanitySettings(env);
    project = s.projectId;
    dataset = s.dataset;
  } catch (err) {
    return empty(err instanceof Error ? err.message : "SANITY_PROJECT_ID is not usable.");
  }

  // The distinct uploads the page names, in the project the token belongs to; others are listed, not asked.
  const wanted = new Set<string>();
  const foreign = new Set<string>();
  for (const use of sanityImageUses(options.page))
    for (const { image } of use.candidates) {
      const id = assetDocumentId(image);
      if (id === undefined) continue;
      if (image.projectId === project && image.dataset === dataset) wanted.add(id);
      else foreign.add(`${image.projectId}/${image.dataset}/${id}`);
    }
  const sorted = [...wanted].sort();
  const ids = sorted.slice(0, SANITY_ASSET_CAP);
  const read: SanityImageRead = {
    project,
    dataset,
    assets: new Map(ids.map((id) => [id, {}])),
    foreign: [...foreign].sort(),
    skipped: sorted.length - ids.length,
  };
  if (ids.length === 0) return read;

  let sanity: SanityRead;
  try {
    sanity = createSanityRead(env, fetcher, {
      sleep: options.sleep ?? wait,
    });
  } catch (err) {
    return { ...read, problem: redact(err instanceof Error ? err.message : String(err)) };
  }

  const ask = async (groq: string): Promise<Asked> => {
    try {
      const rows = await sanity.query(groq);
      if (!Array.isArray(rows))
        return {
          ok: false,
          reason: "Sanity answered with something that is not a list.",
          stop: false,
        };
      return { ok: true, rows };
    } catch (err) {
      if (err instanceof ConnectorRateLimitedError)
        return {
          ok: false,
          stop: true,
          reason: `Sanity asked Gaugeline to slow down (HTTP 429).${err.retry ? ` Try again ${err.retry}.` : ""}`,
        };
      if (err instanceof ConnectorRefusedError)
        return { ok: false, stop: true, reason: redact(err.message) };
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        stop: false,
        reason: redact(
          /larger than \d+ MB/.test(message)
            ? "Sanity's answer was larger than one request can carry."
            : message,
        ),
      };
    }
  };

  const batches = <T>(list: readonly T[], size: number): T[][] => {
    const out: T[][] = [];
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
  };
  const set = (id: string, part: Partial<AssetRead>): void => {
    read.assets.set(id, { ...(read.assets.get(id) ?? {}), ...part });
  };

  // 1. Sizes: the asset documents' `size`, a whole number of bytes.
  let stopped: string | undefined;
  for (const batch of batches(ids, SIZE_BATCH)) {
    if (stopped !== undefined) {
      for (const id of batch) set(id, { sizeProblem: stopped });
      continue;
    }
    const answer = await ask(sizeQuery(batch));
    if (!answer.ok) {
      for (const id of batch) set(id, { sizeProblem: answer.reason });
      if (answer.stop) stopped = answer.reason;
      continue;
    }
    const sizes = new Map<string, unknown>();
    for (const row of answer.rows)
      if (isRecord(row) && typeof row._id === "string") sizes.set(row._id, row.size);
    for (const id of batch) {
      const size = sizes.get(id);
      if (!sizes.has(id))
        set(id, { sizeProblem: "Sanity has no upload with this id in this dataset." });
      else if (typeof size === "number" && Number.isSafeInteger(size) && size >= 0)
        set(id, { size });
      else set(id, { sizeProblem: "Sanity gave no size for this upload." });
    }
  }

  // 2. What the editors set: the image values in published documents that point at each upload.
  for (const batch of batches(ids, USES_BATCH)) {
    if (stopped !== undefined) {
      for (const id of batch) set(id, { usesProblem: stopped });
      continue;
    }
    const answer = await ask(usesQuery(batch));
    if (!answer.ok) {
      for (const id of batch) set(id, { usesProblem: answer.reason });
      if (answer.stop) stopped = answer.reason;
      continue;
    }
    if (answer.rows.length > USES_DOCS_PER_BATCH) {
      for (const id of batch)
        set(id, {
          usesProblem: `These uploads are used in more than ${USES_DOCS_PER_BATCH} documents, more than one run reads.`,
        });
      continue;
    }
    const inBatch = new Set(batch);
    const found = new Map<string, StudioUse[]>(batch.map((id) => [id, []]));
    let unreadable = false;
    for (const doc of answer.rows) {
      const uses = studioUses(doc, inBatch);
      if (uses === undefined) {
        unreadable = true;
        break;
      }
      for (const { id, use } of uses) found.get(id)?.push(use);
    }
    for (const id of batch)
      if (unreadable)
        set(id, { usesProblem: "A document that uses these uploads is too large to read." });
      else set(id, { uses: found.get(id) ?? [] });
  }
  if (
    stopped !== undefined &&
    [...read.assets.values()].every((a) => a.size === undefined && a.uses === undefined)
  )
    read.problem = stopped;
  return read;
}

/** What a run says when the checks were asked for by id and no Sanity settings were given. */
export function notConfigured(): SanityImageRead {
  return {
    project: undefined,
    dataset: undefined,
    assets: new Map(),
    foreign: [],
    skipped: 0,
    problem:
      'The Sanity image checks read your dataset, and gaugeline.adapters.json does not name sanity. Add {"adapters":[{"id":"sanity"}]} and set SANITY_PROJECT_ID, SANITY_DATASET and SANITY_TOKEN (a Viewer token).',
  };
}

/** Read once on first use and shared by the three checks. */
export function lazySanityImages(options: SanityImageOptions): () => Promise<SanityImageRead> {
  let pending: Promise<SanityImageRead> | undefined;
  return () => (pending ??= readSanityImages(options));
}
