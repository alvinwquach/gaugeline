import { escapeInvisible } from "../checks/hidden-text/escape.js";
import type { SanityRead } from "../connectors/sanity.js";
import type { CheckContext } from "../model.js";
import type { SchemaFile } from "../query/mutations.js";
import type { PageSnapshot } from "../snapshot.js";
import type { ContentModel } from "./read.js";
import { NO_SCHEMA } from "./read.js";

export const NOT_SET_UP =
  "gaugeline.model.json is not set up, so nothing was checked. See docs/sources/sanity-schema.";

/** Text from a config file, a page or a dataset, made safe to print in one line. */
export function safe(text: string, max = 60): string {
  return escapeInvisible(text, max);
}

/** The first line of a failure, with anything long cut. */
export function why(err: unknown): string {
  return safe(err instanceof Error ? err.message : String(err), 240);
}

/** "ids a, b, c" for a finding. */
export function idList(ids: readonly string[]): string {
  return ids.map((id) => safe(id, 80)).join(", ");
}

export interface Ready {
  model: ContentModel;
  read: SanityRead;
}

/**
 * What a check that asks the dataset needs: the file, Sanity and, when the check is about the
 * schema, the schema. Says what is missing as a could-not-check and returns undefined, so the
 * check is never marked as passed for something it did not look at.
 */
export function ready(page: PageSnapshot, ctx: CheckContext, needsSchema: false): Ready | undefined;
export function ready(
  page: PageSnapshot,
  ctx: CheckContext,
  needsSchema: true,
): (Ready & { schema: SchemaFile }) | undefined;
export function ready(
  page: PageSnapshot,
  ctx: CheckContext,
  needsSchema: boolean,
): (Ready & { schema?: SchemaFile }) | undefined {
  const model = ctx.model;
  if (!model) {
    ctx.couldNotCheck?.(page.finalUrl, NOT_SET_UP);
    return undefined;
  }
  if (needsSchema && !model.schema) {
    ctx.couldNotCheck?.(page.finalUrl, NO_SCHEMA);
    return undefined;
  }
  const sanity = model.sanity();
  if (!sanity.ok) {
    ctx.couldNotCheck?.(page.finalUrl, sanity.reason);
    return undefined;
  }
  return { model, read: sanity.read, ...(model.schema ? { schema: model.schema } : {}) };
}
