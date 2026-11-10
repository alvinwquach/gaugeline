import { AnswerTooBigError, TYPE_NAME, type SanityRead } from "../connectors/sanity.js";

/** What a value is, as far as a query is concerned. */
export type FieldKind =
  | "string"
  | "number"
  | "boolean"
  | "slug"
  | "reference"
  | "image"
  | "file"
  | "array"
  | "object"
  | "portable-text";

/**
 * One field of a document type, and how common it is. A tree: an object's or an array of objects'
 * fields are in `of`, each with its own count, because "optional" is a fact about each level.
 *
 * `present` counts the places the field was seen: documents for a top-level field, the parent's
 * object values (or the objects inside the parent array) for a nested one. A nested field is
 * compared with `instances` of its parent, or with the parent's `present` when `instances` is unset.
 */
export interface FieldShape {
  name: string;
  kind: FieldKind;
  present: number;
  of?: FieldShape[];
  /** For an array: the kind of its items, when they are all one kind. Unset for an empty array or a mixed one. */
  item?: FieldKind;
  /** How many objects (documents' object values, or array items) `of` was counted over. */
  instances?: number;
  /** When the field had more than one kind across documents: every kind, in the order first seen. `kind` is the commonest. */
  mixed?: FieldKind[];
  /** When an array's items had more than one kind: every kind, in the order first seen. */
  itemsMixed?: FieldKind[];
}

/** The fields of one document type, from the newest published documents. No field's value is kept. */
export interface ContentShape {
  type: string;
  /** How many documents were read: the sample, or fewer when the type has fewer. */
  sampled: number;
  fields: FieldShape[];
  /** Fields left out because their names cannot be written into a query plainly. */
  skipped?: number;
}

/** The sample asked for when none is given. Proposed: see the PR's Sources. */
export const DEFAULT_SAMPLE = 50;
/** The most documents one request may ask for. */
export const MAX_SAMPLE = 200;
/** How many levels of objects are followed. An object below this is kept as a plain field. */
const MAX_DEPTH = 4;
/** How many distinct field names one level keeps; the rest are counted as skipped. */
const MAX_FIELDS = 100;
/** A name that can be written into a projection: a letter or underscore, then letters, digits, underscores, hyphens. */
export const WRITABLE_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
/** Keys that are not content. A leading underscore marks one at every level. */
const isSystem = (name: string): boolean => name.startsWith("_");
/** An image or file's own bookkeeping, which the printer resolves through `asset->`. */
const ASSET_KEYS = new Set(["asset", "crop", "hotspot", "media"]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** The kind of a value, or null for a null (which is the same as absent). Reads the shape, never the text. */
function kindOf(value: unknown): FieldKind | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (Array.isArray(value))
    return value.some((i) => isRecord(i) && i._type === "block") ? "portable-text" : "array";
  if (!isRecord(value)) return null;
  const asset = value.asset;
  const assetRef = isRecord(asset) && typeof asset._ref === "string" ? asset._ref : "";
  if (value._type === "slug") return "slug";
  if (value._type === "image" || assetRef.startsWith("image-")) return "image";
  if (value._type === "file" || assetRef.startsWith("file-")) return "file";
  if (value._type === "reference" || (typeof value._ref === "string" && asset === undefined))
    return "reference";
  return "object";
}

/** A field being counted: kinds seen, and the fields below it. Maps keep the order things first appeared. */
interface Acc {
  present: number;
  kinds: Map<FieldKind, number>;
  itemKinds: Map<FieldKind, number>;
  instances: number;
  children: Map<string, Acc>;
}

const fresh = (): Acc => ({
  present: 0,
  kinds: new Map(),
  itemKinds: new Map(),
  instances: 0,
  children: new Map(),
});

const bump = <K>(m: Map<K, number>, k: K): void => {
  m.set(k, (m.get(k) ?? 0) + 1);
};

class Tally {
  /** The distinct names left out, so the number does not grow with the sample. */
  readonly skipped = new Set<string>();

  /** Count the keys of one object into `into`. */
  object(into: Map<string, Acc>, obj: Record<string, unknown>, depth: number, owner: FieldKind) {
    for (const [name, value] of Object.entries(obj)) {
      if (isSystem(name)) continue;
      if (owner === "image" || owner === "file") if (ASSET_KEYS.has(name)) continue;
      const kind = kindOf(value);
      if (kind === null) continue;
      if (!WRITABLE_NAME.test(name)) {
        this.skipped.add(name);
        continue;
      }
      let acc = into.get(name);
      if (acc === undefined) {
        if (into.size >= MAX_FIELDS) {
          this.skipped.add(name);
          continue;
        }
        acc = fresh();
        into.set(name, acc);
      }
      acc.present++;
      bump(acc.kinds, kind);
      this.below(acc, value, kind, depth);
    }
  }

  /** Count what is inside one value: an object's fields, or an array's items. */
  below(acc: Acc, value: unknown, kind: FieldKind, depth: number) {
    if (depth >= MAX_DEPTH) return;
    if ((kind === "object" || kind === "image" || kind === "file") && isRecord(value)) {
      acc.instances++;
      this.object(acc.children, value, depth + 1, kind);
    } else if (kind === "array" && Array.isArray(value)) {
      for (const item of value) {
        const itemKind = kindOf(item);
        if (itemKind === null) continue;
        bump(acc.itemKinds, itemKind);
        if (
          (itemKind === "object" || itemKind === "image" || itemKind === "file") &&
          isRecord(item)
        ) {
          acc.instances++;
          this.object(acc.children, item, depth + 1, itemKind);
        }
      }
    }
  }
}

/** The kind seen most often; on a tie, the one seen first. */
function commonest(kinds: ReadonlyMap<FieldKind, number>): FieldKind | undefined {
  let best: FieldKind | undefined;
  let bestN = 0;
  for (const [k, n] of kinds)
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  return best;
}

function finish(name: string, acc: Acc): FieldShape {
  const kind = commonest(acc.kinds) ?? "object";
  const out: FieldShape = { name, kind, present: acc.present };
  if (acc.kinds.size > 1) out.mixed = [...acc.kinds.keys()];
  if (kind === "array" && acc.itemKinds.size > 0) {
    if (acc.itemKinds.size === 1) out.item = [...acc.itemKinds.keys()][0] as FieldKind;
    else out.itemsMixed = [...acc.itemKinds.keys()];
  }
  if (acc.children.size > 0) {
    out.of = [...acc.children].map(([n, a]) => finish(n, a));
    out.instances = acc.instances;
  } else if (acc.instances > 0 && (kind === "image" || kind === "file")) {
    out.instances = acc.instances;
  }
  return out;
}

/**
 * The fields of a document type and how many of the newest published documents have each, with
 * their kinds. The documents are asked for in one GET (drafts left out, newest first, `sample` of
 * them) and reduced to this shape as they arrive: nothing from a field's value is kept, so no
 * value can reach a log, a finding or the output. GROQ has no function that lists an object's keys,
 * so the answer does carry the documents to this machine; they are held only for the reduction.
 * When the documents are too long for one answer the sample is halved until they fit, and
 * `sampled` says how many were read. A type with no published documents gives `sampled: 0`.
 */
export async function readContentShape(
  type: string,
  sanity: SanityRead,
  sample: number = DEFAULT_SAMPLE,
): Promise<ContentShape> {
  if (!TYPE_NAME.test(type)) throw new Error(`"${type}" is not a Sanity document type name.`);
  if (!Number.isInteger(sample) || sample < 1 || sample > MAX_SAMPLE)
    throw new Error(`The sample must be a whole number of documents from 1 to ${MAX_SAMPLE}.`);
  let take = sample;
  for (;;) {
    let answer: unknown;
    try {
      answer = await sanity.query(
        `*[_type == ${JSON.stringify(type)} && !(_id in path("drafts.**"))] | order(_updatedAt desc)[0...${take}]`,
      );
    } catch (err) {
      if (err instanceof AnswerTooBigError && take > 1) {
        take = Math.floor(take / 2);
        continue;
      }
      throw err;
    }
    if (!Array.isArray(answer))
      throw new Error("Sanity answered with something that is not a list of documents.");
    const documents = answer.filter(isRecord).slice(0, take);
    const tally = new Tally();
    const fields = new Map<string, Acc>();
    for (const doc of documents) tally.object(fields, doc, 0, "object");
    return {
      type,
      sampled: documents.length,
      fields: [...fields].map(([name, acc]) => finish(name, acc)),
      ...(tally.skipped.size > 0 ? { skipped: tally.skipped.size } : {}),
    };
  }
}
