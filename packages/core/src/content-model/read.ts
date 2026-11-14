import { SANITY_PROJECT_ID, createSanityRead, type SanityRead } from "../connectors/sanity.js";
import type { Env } from "../connectors/types.js";
import type { Fetcher } from "../fetcher.js";
import type { SchemaFile } from "../query/mutations.js";
import type { ModelConfig } from "./config.js";

/** What the run was told about the content model: the file, the schema it names, and the Sanity variables. */
export interface ModelSettings {
  config: ModelConfig;
  /** The schema file gaugeline.model.json names, already read. Absent when the file names none. */
  schema?: SchemaFile;
  /** The schema from before the change, when the file names one. */
  previousSchema?: SchemaFile;
  /** The Sanity variables, already copied (SANITY_PROJECT_ID, SANITY_DATASET, SANITY_TOKEN). */
  env: Env;
}

/** Sanity as the model checks ask it: published documents, counts and ids. Each answer is kept, so a question is asked once. */
export type ModelSanity = { ok: true; read: SanityRead } | { ok: false; reason: string };

/** The content model of a site: gaugeline.model.json, the schema it names, and a way to ask the dataset. */
export interface ContentModel {
  config: ModelConfig;
  schema: SchemaFile | undefined;
  previousSchema: SchemaFile | undefined;
  /** Sanity, or why it cannot be asked (no project id). Never throws. */
  sanity(): ModelSanity;
}

export const NO_SCHEMA =
  'No schema file is named in gaugeline.model.json, so this was not checked. Add "schema": "schema.json" (the file `npx sanity schema extract` writes). See docs/sources/sanity-schema.';
export const NO_SANITY = `${SANITY_PROJECT_ID} is not set, so the dataset could not be asked. Set ${SANITY_PROJECT_ID} (and SANITY_TOKEN for a private dataset). See docs/sources/sanity-schema.`;

/**
 * The reader behind `ctx.model`. Nothing here throws for a dataset being unreachable: the check
 * that asks reports that as could not check. The reader keeps each query's answer, so two checks
 * that ask for the same count make one request.
 */
export function createContentModel(settings: ModelSettings, fetcher: Fetcher): ContentModel {
  let made: ModelSanity | undefined;
  return {
    config: settings.config,
    schema: settings.schema,
    previousSchema: settings.previousSchema,
    sanity() {
      if (made) return made;
      if ((settings.env[SANITY_PROJECT_ID] ?? "").trim() === "") {
        made = { ok: false, reason: NO_SANITY };
        return made;
      }
      try {
        const inner = createSanityRead(settings.env, fetcher);
        const answers = new Map<string, Promise<unknown>>();
        made = {
          ok: true,
          read: {
            dataset: inner.dataset,
            datasetAssumed: inner.datasetAssumed,
            query(groq) {
              let pending = answers.get(groq);
              if (!pending) {
                pending = inner.query(groq);
                answers.set(groq, pending);
              }
              return pending;
            },
          },
        };
      } catch (err) {
        made = { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
      return made;
    },
  };
}
