import { isTemporaryHost } from "./checks/launch/hosts.js";
import { shortUrl } from "./checks/site-helpers.js";
import { redact } from "./redact.js";
import type { DatasetRead } from "./sanity.js";
import type { ScriptRead } from "./scripts.js";
import type { PageSnapshot } from "./snapshot.js";

/**
 * What the app's Leaks & access view shows besides the findings: which Sanity datasets were read and
 * what they answered, which JavaScript files were scanned, and which preview addresses the page
 * links to. Built from what the checks already read, so showing it asks the site for nothing.
 * It has no field that could hold a document, a script's text or an unmasked key.
 */

/** One Sanity dataset the page's images name: how it answered, and (public only) its type names. */
export interface DatasetView {
  projectId: string;
  dataset: string;
  state: DatasetRead["state"];
  /** Public only: how many documents there are. Never what is in them. */
  count?: number;
  /** Public only: the distinct type names, in order. */
  types?: string[];
}

/** One same-site JavaScript file the scan asked for. */
export interface ScriptView {
  /** The address, with secret-looking text removed. */
  url: string;
  /** The address as a finding names it: a path on the page's own site, else the full address. */
  where: string;
  /** The final status, or null when nothing answered. */
  status: number | null;
  /** Only the start of a long file was read. */
  truncated: boolean;
}

export interface LeaksView {
  /** Absent when no check read the datasets; empty when the page names no Sanity dataset. */
  datasets?: DatasetView[];
  /** Absent when no check scanned JavaScript; empty when the page has no JavaScript file of its own. */
  scripts?: ScriptView[];
  /** The links on the page that go to a hosting provider's temporary address (vercel.app and the like). */
  previews: string[];
}

/** Most preview addresses listed; the temp-host-links finding still counts every one. */
export const MAX_PREVIEWS = 50;

export function leaksView(input: {
  page: PageSnapshot;
  datasets?: readonly DatasetRead[];
  scripts?: readonly ScriptRead[];
}): LeaksView {
  const { page, datasets, scripts } = input;
  const origin = new URL(page.finalUrl).origin;
  const previews = new Set<string>();
  for (const l of page.links) {
    try {
      if (isTemporaryHost(new URL(l.href).hostname)) previews.add(redact(l.href));
    } catch {
      // not an address
    }
  }
  return {
    ...(datasets
      ? {
          datasets: datasets.map((d) => ({
            projectId: d.projectId,
            dataset: d.dataset,
            state: d.state,
            ...(d.state === "public" ? { count: d.count ?? 0, types: [...(d.types ?? [])] } : {}),
          })),
        }
      : {}),
    ...(scripts
      ? {
          scripts: scripts.map((s) => ({
            url: redact(s.url),
            where: redact(shortUrl(s.url, origin)),
            status: s.status,
            truncated: s.truncated,
          })),
        }
      : {}),
    previews: [...previews].slice(0, MAX_PREVIEWS),
  };
}

/** A lazy read that also says what it read, if anything asked for it. Calling it twice still reads once. */
export function remembered<T>(
  read: () => Promise<T>,
): (() => Promise<T>) & { peek(): Promise<T> | undefined } {
  let pending: Promise<T> | undefined;
  return Object.assign(() => (pending ??= read()), { peek: () => pending });
}
