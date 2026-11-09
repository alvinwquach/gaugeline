import type { Checked, DatasetView, Finding, LeaksView, ScriptView } from "../../types";
import { checkedOf, finding } from "../../__tests__/helpers";

export const ELLIPSIS = String.fromCharCode(0x2026);

/** An invented key-shaped value, put together at run time so no key-shaped string is in the source. */
export const PLANTED_KEY = ["sk", "live", "PlantedNotAKey0123456789"].join("_");
export const MASKED = `${PLANTED_KEY.slice(0, 6)}${ELLIPSIS}${PLANTED_KEY.slice(-2)}`;

export const DATASET_IDS = ["dataset-public", "dataset-private-types"];

export function withLeaks(leaks: LeaksView, over: Partial<Checked> = {}): Checked {
  return checkedOf({ leaks, ...over });
}

export function keyFinding(where: string, offset = 120, masked = MASKED): Finding {
  return finding({
    checkId: "secret-in-js",
    severity: "high",
    title: "A private key is in your site's JavaScript",
    evidence: `Stripe secret key ${masked} in ${where} at byte ${offset}`,
  });
}

export function script(path: string, over: Partial<ScriptView> = {}): ScriptView {
  return {
    url: `https://shop.example${path}`,
    where: path,
    status: 200,
    truncated: false,
    ...over,
  };
}

export const SIX_TYPES = ["author", "category", "page", "post", "product", "siteSettings"];

export function publicDataset(over: Partial<DatasetView> = {}): DatasetView {
  return {
    projectId: "ab12cd34",
    dataset: "production",
    state: "public",
    count: 412,
    types: SIX_TYPES,
    ...over,
  };
}
