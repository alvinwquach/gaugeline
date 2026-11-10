import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SITES_DIR } from "../../../../fixtures/src/index.js";
import {
  FERNBROOK,
  sanityCountsTransport,
  staticSite,
  type FakeSanity,
  type SeenSanityRequest,
} from "../../../../testkit/src/index.js";
import { createPageRegistry } from "../../checks/index.js";
import { createFetcher, type Fetcher, type Transport } from "../../fetcher.js";
import { MODEL_CHECKS } from "../../presets.js";
import { parseSchemaExtract } from "../../query/mutations.js";
import { checkSite } from "../../site.js";
import { modelConfigSchema, type ModelConfig } from "../config.js";

export const CLINIC = join(SITES_DIR, "model-clinic");
export const HOST = "fernbrook.example";
export const PROJECT = "fernbrook1";

export function clinicConfig(): ModelConfig {
  return modelConfigSchema.parse(
    JSON.parse(readFileSync(join(CLINIC, "gaugeline.model.json"), "utf8")),
  );
}

export function clinicSchema(file = "schema.json") {
  return parseSchemaExtract(readFileSync(join(CLINIC, file), "utf8"), file);
}

export interface Seen {
  method: string;
  url: string;
}

/** The clinic's pages at fernbrook.example and its invented dataset at its Sanity address, in memory. */
export function network(
  sanity: FakeSanity = FERNBROOK,
  seen: Seen[] = [],
  queries: SeenSanityRequest[] = [],
  dir: string = CLINIC,
): Fetcher {
  const site = staticSite(HOST, dir, () =>
    Promise.reject(new Error("only the fixture host is served")),
  );
  const dataset = sanityCountsTransport(sanity, queries);
  const transport: Transport = (url, req) => {
    seen.push({ method: req.method, url: url.href });
    return url.hostname === `${PROJECT}.api.sanity.io` ? dataset(url, req) : site(url, req);
  };
  return createFetcher({ transport, timeoutMs: 5000 });
}

export async function runClinic(
  options: {
    config?: ModelConfig;
    sanity?: FakeSanity;
    only?: readonly string[];
    env?: Record<string, string>;
    schema?: boolean;
    previous?: boolean;
    seen?: Seen[];
    queries?: SeenSanityRequest[];
    address?: string;
  } = {},
) {
  const config = options.config ?? clinicConfig();
  return checkSite({
    address: options.address ?? `https://${HOST}/`,
    fetcher: network(options.sanity, options.seen, options.queries),
    only: options.only ?? MODEL_CHECKS,
    registry: createPageRegistry(),
    model: {
      config,
      ...(options.schema === false ? {} : { schema: clinicSchema() }),
      ...(options.previous === false ? {} : { previousSchema: clinicSchema("schema.before.json") }),
      env: options.env ?? { SANITY_PROJECT_ID: PROJECT, SANITY_DATASET: "production" },
    },
  });
}
