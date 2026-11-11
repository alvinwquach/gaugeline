import type { ContentAdapter } from "../adapters/types.js";
import { AdapterCouldNotCheck } from "../adapters/types.js";
import type { Env } from "../connectors/types.js";
import type { Fetcher } from "../fetcher.js";
import type { ChangesConfig } from "./config.js";
import { readDeploys } from "./deploys.js";
import type { ChangeSources } from "./report.js";

/**
 * The two places a change can be traced to. Revisions: the content adapter's own history for the
 * document the settings name for a page; no adapter, or no document named, is "not configured", and
 * an adapter without `revisions` is could-not-check naming the platform. Deploys: Vercel or Netlify.
 */
export function createChangeSources(args: {
  config: ChangesConfig;
  env: Env;
  fetcher: Fetcher;
  adapter?: ContentAdapter | undefined;
}): ChangeSources {
  const { config, adapter } = args;
  let deploys: ReturnType<typeof readDeploys> | undefined;
  return {
    async revisions(path, since) {
      const doc = config.documents?.[path];
      if (!adapter || doc === undefined) return { state: "not-configured" };
      const name = adapter.describe().name;
      if (!adapter.revisions)
        return {
          state: "could-not-check",
          reason: `${name} does not offer its edit history to Gaugeline yet, so content edits were not checked`,
        };
      try {
        return { state: "read", items: await adapter.revisions(doc, since) };
      } catch (err) {
        if (err instanceof AdapterCouldNotCheck)
          return { state: "could-not-check", reason: err.reason };
        throw err;
      }
    },
    deploys: () => (deploys ??= readDeploys(config.deploys, args.env, args.fetcher)),
  };
}
