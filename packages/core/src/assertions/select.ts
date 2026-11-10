import {
  assertionSourceName,
  type Assertion,
  type SourcesConfig,
} from "../connectors/postgres/config.js";

/** An assertion with the name of the source it runs on. */
export interface Placed {
  assertion: Assertion;
  source: string;
}

/**
 * The assertions of a config, in file order, each with its source; only the ids asked for when
 * `ids` is given. The config schema has already refused an assertion with no usable source, so one
 * that slipped through (a config built by hand) is left out here rather than run on a guess.
 */
export function assertionsOf(config: SourcesConfig, ids?: readonly string[]): Placed[] {
  const wanted = ids === undefined ? undefined : new Set(ids);
  const out: Placed[] = [];
  for (const assertion of config.assertions ?? []) {
    if (wanted && !wanted.has(assertion.id)) continue;
    const source = assertionSourceName(config, assertion);
    if (source === undefined || config.sources[source] === undefined) continue;
    out.push({ assertion, source });
  }
  return out;
}
