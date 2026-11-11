import { FetchError, type Fetcher } from "../fetcher.js";
import { NetworkError } from "../errors.js";
import { escapeInvisible } from "../checks/hidden-text/escape.js";
import {
  describeRange,
  inRange,
  parseRange,
  rangeFromEvents,
  type RangeEvent,
  type RangeSet,
} from "./range.js";
import {
  classify,
  familyOf,
  isAdvisoryId,
  normaliseId,
  type Advisory,
  type Component,
} from "./target.js";

/**
 * Advisory ids are looked up in OSV (osv.dev), the open database that gathers npm, Packagist and other
 * advisories, with GET https://api.osv.dev/v1/vulns/{id}: no key, no POST and no batch call. It is a request to a
 * public API and not to the site being checked. What comes back is data: it is read field by field, clipped, and
 * never run, followed or printed unescaped.
 */
export const OSV_ORIGIN = "https://api.osv.dev";

/** Why an id could not be turned into affected packages. */
export type OsvErrorKind = "not-found" | "unreachable" | "bad-answer";

export class OsvError extends Error {
  constructor(
    readonly kind: OsvErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "OsvError";
  }
}

/** The most of an answer that is read: advisories with long lists of versions are far below this. */
const MAX_BYTES = 1024 * 1024;
const MAX_COMPONENTS = 50;
const MAX_ALIASES = 20;
const SUMMARY_MAX = 200;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max) : undefined;
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function events(raw: unknown): RangeEvent[] {
  return list(raw).flatMap((e) => {
    if (!isRecord(e)) return [];
    const out: RangeEvent = {};
    for (const k of ["introduced", "fixed", "last_affected", "limit"] as const) {
      const v = text(e[k], 60);
      if (v !== undefined) out[k] = v;
    }
    return Object.keys(out).length > 0 ? [out] : [];
  });
}

/** An OSV advisory as the check reads it. Throws OsvError("bad-answer") for something that is not one. */
export function parseOsv(json: unknown): Advisory {
  if (!isRecord(json)) throw new OsvError("bad-answer", "OSV's answer was not an advisory.");
  const id = text(json.id, 100);
  if (id === undefined) throw new OsvError("bad-answer", "OSV's answer had no advisory id.");
  const summary = text(json.summary, SUMMARY_MAX + 1);
  const withdrawn = text(json.withdrawn, 40);
  const byPackage = new Map<
    string,
    Component & { groups: RangeSet; unreadable?: string; commitsOnly?: boolean }
  >();
  let omitted = 0;
  for (const a of list(json.affected)) {
    if (!isRecord(a) || !isRecord(a.package)) continue;
    const ecosystem = text(a.package.ecosystem, 60);
    const name = text(a.package.name, 120);
    if (ecosystem === undefined || name === undefined) continue;
    const c = classify(ecosystem, name);
    const key = `${c.kind}\n${c.name}\n${c.label}`;
    let entry = byPackage.get(key);
    if (!entry && byPackage.size >= MAX_COMPONENTS) {
      omitted++;
      continue;
    }
    if (!entry) {
      const family = familyOf(c.kind);
      entry = { ...c, ...(family ? { family } : {}), rangeText: "", groups: [] };
      byPackage.set(key, entry);
    }
    if (!entry.family) continue;
    for (const r of list(a.ranges)) {
      if (!isRecord(r)) continue;
      const type = text(r.type, 20)?.toUpperCase();
      // A GIT range is commits, not versions: beside a readable range it is ignored, alone it is no range.
      if (type === "GIT") {
        entry.commitsOnly = true;
        continue;
      }
      const set = rangeFromEvents(entry.family, events(r.events));
      if (set) entry.groups.push(...set);
      else entry.unreadable ??= "a version range in the advisory could not be read";
    }
    for (const v of list(a.versions)) {
      const one = typeof v === "string" ? parseRange(entry.family, `=${v}`) : undefined;
      if (one) entry.groups.push(...one);
    }
  }
  const components: Component[] = [...byPackage.values()].map(
    ({ groups, commitsOnly, unreadable, ...c }) => {
      if (c.family === undefined) return { ...c, rangeText: "" };
      // One range that cannot be read means the versions are not known: the ones that parsed are not all of
      // them, so a version outside them is not "outside the affected versions".
      if (unreadable !== undefined) return { ...c, rangeText: "", unreadable };
      if (groups.length === 0)
        return {
          ...c,
          rangeText: "",
          unreadable: commitsOnly
            ? "the advisory lists commit ranges only, which cannot be compared with a version"
            : "the advisory lists no versions",
        };
      return { ...c, set: groups, rangeText: describeRange(groups) };
    },
  );
  return {
    id,
    aliases: list(json.aliases)
      .flatMap((x) => (typeof x === "string" && x.length <= 60 ? [x] : []))
      .slice(0, MAX_ALIASES),
    ...(summary !== undefined
      ? {
          summary: summary.length > SUMMARY_MAX ? `${summary.slice(0, SUMMARY_MAX)}…` : summary,
        }
      : {}),
    ...(withdrawn !== undefined ? { withdrawn } : {}),
    source: "osv",
    components,
    ...(omitted > 0 ? { omitted } : {}),
  };
}

export interface Osv {
  /** The advisory for an id: one GET per id for the life of this client. */
  get(id: string): Promise<Advisory>;
}

export function createOsv(fetcher: Fetcher): Osv {
  const cache = new Map<string, Promise<Advisory>>();
  const ask = async (id: string): Promise<Advisory> => {
    if (!isAdvisoryId(id))
      throw new OsvError("not-found", `"${escapeInvisible(id, 60)}" is not an advisory id.`);
    let hop;
    try {
      hop = (
        await fetcher.get(`${OSV_ORIGIN}/v1/vulns/${encodeURIComponent(id)}`, {
          maxBytes: MAX_BYTES,
          headers: { accept: "application/json" },
        })
      ).at(-1);
    } catch (err) {
      if (err instanceof FetchError || err instanceof NetworkError)
        throw new OsvError("unreachable", "OSV (api.osv.dev) could not be reached.");
      throw err;
    }
    if (!hop) throw new OsvError("unreachable", "OSV (api.osv.dev) gave no answer.");
    if (hop.status === 404 || hop.status === 400)
      throw new OsvError("not-found", `OSV has no advisory with the id ${id}.`);
    if (hop.status < 200 || hop.status >= 300)
      throw new OsvError("unreachable", `OSV (api.osv.dev) answered ${hop.status}.`);
    let json: unknown;
    try {
      json = JSON.parse(hop.body ?? "");
    } catch {
      throw new OsvError("bad-answer", "OSV's answer was not JSON.");
    }
    return parseOsv(json);
  };
  return {
    get(raw) {
      const id = normaliseId(raw);
      let p = cache.get(id);
      if (!p) cache.set(id, (p = ask(id)));
      return p;
    },
  };
}

/** Whether a version is in a component's affected versions; undefined when it cannot be said. */
export function affects(component: Component, version: string): boolean | undefined {
  return component.family && component.set
    ? inRange(component.family, version, component.set)
    : undefined;
}
