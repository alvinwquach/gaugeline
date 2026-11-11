import type { CheckContext } from "../model.js";
import type { ImageSettings } from "./config.js";
import {
  optimizerLabel,
  readImageSettings,
  type OptimizerAddress,
  type SettingsIssue,
} from "./optimizers.js";

/**
 * Checks run once per page, but an image setting or an optimizer is one thing for the whole site:
 * the first page to reach it takes it, so one run reports it once and sends one request for it.
 * The claim is made before any await, so two pages checked at once cannot both take it.
 */
const claims = new WeakMap<object, Set<string>>();
export function claim(owner: object, what: string): boolean {
  let set = claims.get(owner);
  if (!set) claims.set(owner, (set = new Set()));
  if (set.has(what)) return false;
  set.add(what);
  return true;
}

const issues = new WeakMap<ImageSettings, SettingsIssue[]>();
/** Every problem in the settings files given, read once per run. */
export function settingsIssues(cfg: ImageSettings): SettingsIssue[] {
  let found = issues.get(cfg);
  if (!found) {
    found = cfg.settings.flatMap((f) => readImageSettings(f.file, f.text));
    issues.set(cfg, found);
  }
  return found;
}

/** The distinct optimizers a page uses, in a fixed order, with the addresses it uses for each. */
export function byOptimizer(
  addresses: readonly OptimizerAddress[],
): Map<string, OptimizerAddress[]> {
  const groups = new Map<string, OptimizerAddress[]>();
  for (const a of [...addresses].sort((x, y) => x.path.localeCompare(y.path))) {
    const list = groups.get(a.optimizer) ?? [];
    list.push(a);
    groups.set(a.optimizer, list);
  }
  return groups;
}

/** Say once per optimizer that the page uses one and its settings were not given. */
export function noteNoSettings(
  ctx: CheckContext,
  origin: string,
  addresses: readonly OptimizerAddress[],
): void {
  for (const group of byOptimizer(addresses).values()) {
    const first = group[0];
    if (!first) continue;
    ctx.couldNotCheck?.(
      `${origin}${first.path}`,
      `this page resizes images through the ${optimizerLabel(first.optimizer)} image address, and whether that address fetches only the hosts you listed is not visible from the page; add settingsFiles to gaugeline.images.json (the images settings of your framework), or run the probe on a site you own`,
    );
  }
}
