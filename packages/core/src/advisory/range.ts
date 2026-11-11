import { comparePre } from "../libraries/version.js";

/**
 * Versions and version ranges for the three kinds of package an advisory names: npm (semantic versioning),
 * PHP packages on Packagist (composer's rules) and WordPress plugins, themes and core (which write
 * versions the way composer does: up to four numbers and a stability word). Numbers are whole numbers, never
 * floats: 5.10 is after 5.8. Only what these ecosystems write is read; anything else is not a version, and a
 * version that is not a version never matches a range, it gives no answer.
 */
export type Family = "npm" | "composer" | "wordpress";

export interface Version {
  /** Four numbers; a shorter version is padded with zeros. */
  nums: [number, number, number, number];
  /** The pre-release or stability tag, as written ("rc.1", "RC1", "beta"). */
  pre?: string;
  /** The version as written without a leading v, or as built for a range's bound. */
  text: string;
}

const NPM =
  /^v?(\d{1,9})\.(\d{1,9})(?:\.(\d{1,9}))?(?:-([0-9A-Za-z.-]{1,40}))?(?:\+[0-9A-Za-z.-]{1,40})?$/;
const LOOSE = /^v?(\d{1,9}(?:\.\d{1,9}){0,3})(?:[-_.+]?([A-Za-z][0-9A-Za-z.]{0,20}))?$/;

const pad = (n: readonly number[]): [number, number, number, number] => [
  n[0] ?? 0,
  n[1] ?? 0,
  n[2] ?? 0,
  n[3] ?? 0,
];

/** A version as the ecosystem writes it, or undefined when it is not one ("latest", "dev-main", "15"). */
export function parseVersion(family: Family, text: string): Version | undefined {
  const t = text.trim();
  if (family === "npm") {
    const m = NPM.exec(t);
    if (!m) return undefined;
    const pre = m[4];
    return {
      nums: pad([Number(m[1]), Number(m[2]), Number(m[3] ?? 0)]),
      ...(pre !== undefined ? { pre } : {}),
      text: t.replace(/^v/, "").replace(/\+.*$/, ""),
    };
  }
  const m = LOOSE.exec(t);
  if (!m) return undefined;
  const pre = m[2];
  return {
    nums: pad((m[1] ?? "").split(".").map(Number)),
    ...(pre !== undefined ? { pre } : {}),
    text: t.replace(/^v/, ""),
  };
}

/** Composer's stability order: dev < alpha < beta < RC < stable < patch. */
function rank(pre: string | undefined): number {
  if (pre === undefined) return 4;
  const word = pre.replace(/[\d.]+/g, "").toLowerCase();
  if (word === "dev") return 0;
  if (word === "a" || word === "alpha") return 1;
  if (word === "b" || word === "beta") return 2;
  if (word === "rc") return 3;
  if (word === "p" || word === "pl" || word === "patch") return 5;
  return 1;
}

const tagNumber = (pre: string | undefined): number => Number(/\d+/.exec(pre ?? "")?.[0] ?? 0);

/** Negative when a is older than b, zero when equal, positive when newer. */
export function compare(family: Family, a: Version, b: Version): number {
  for (let i = 0; i < 4; i++) {
    const d = (a.nums[i] ?? 0) - (b.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  if (family === "npm") {
    if (a.pre === b.pre) return 0;
    if (a.pre === undefined) return 1;
    if (b.pre === undefined) return -1;
    return comparePre(a.pre, b.pre);
  }
  const r = rank(a.pre) - rank(b.pre);
  return r !== 0 ? r : tagNumber(a.pre) - tagNumber(b.pre);
}

export type Op = "<" | "<=" | ">" | ">=" | "=";
export interface Comparator {
  op: Op;
  v: Version;
}
/** Stretches of versions: a version is in the set when it satisfies every comparator of any one stretch. */
export type RangeSet = Comparator[][];

const built = (nums: readonly number[], pre?: string): Version => {
  const n = pad(nums);
  const last = n.reduce((at, x, i) => (x !== 0 ? i : at), 2);
  return {
    nums: n,
    ...(pre !== undefined ? { pre } : {}),
    text: n.slice(0, Math.max(3, last + 1)).join("."),
  };
};

interface Partial {
  parts: number[];
  /** True when a part was written as x, X or *. */
  wild: boolean;
  pre?: string;
}

function readPartial(family: Family, text: string): Partial | undefined {
  const m =
    /^v?(\d{1,9}|[xX*])(?:\.(\d{1,9}|[xX*]))?(?:\.(\d{1,9}|[xX*]))?(?:\.(\d{1,9}|[xX*]))?(?:-([0-9A-Za-z.-]{1,40}))?$/.exec(
      text,
    );
  if (!m) return undefined;
  const parts: number[] = [];
  let wild = false;
  for (const p of m.slice(1, 5)) {
    if (p === undefined) break;
    if (/^[xX*]$/.test(p)) {
      wild = true;
      break;
    }
    parts.push(Number(p));
  }
  if (family === "npm" && parts.length === 0 && !wild) return undefined;
  const pre = m[5];
  return { parts, wild, ...(pre !== undefined ? { pre } : {}) };
}

const bump = (parts: readonly number[], at: number): number[] => {
  const out = pad(parts.slice(0, at + 1));
  out[at] = (out[at] ?? 0) + 1;
  for (let i = at + 1; i < 4; i++) out[i] = 0;
  return out;
};

/** The comparators one token stands for, or undefined when it is not a range. [] is "any version". */
function token(family: Family, tok: string): Comparator[] | undefined {
  const m = /^(<=|>=|<|>|=|\^|~)?(.*)$/.exec(tok);
  const op = m?.[1] ?? "";
  const body = m?.[2] ?? "";
  if (/^(?:[xX*])$/.test(body) && (op === "" || op === "=")) return [];
  const p = readPartial(family, body);
  if (!p) return undefined;
  const count = p.parts.length;
  if (count === 0) return op === "" || op === "=" ? [] : undefined;
  const low = (): Comparator => ({ op: ">=", v: built(p.parts, p.pre) });
  const below = (v: readonly number[]): Comparator => ({ op: "<", v: built(v) });
  switch (op) {
    case "":
    case "=": {
      // npm: a partial version is an x-range; composer and WordPress: only a written wildcard is.
      const range = p.wild || (family === "npm" && count < 3);
      if (!range) return [{ op: "=", v: built(p.parts, p.pre) }];
      return [low(), below(bump(p.parts, count - 1))];
    }
    case "^": {
      const at = p.parts.findIndex((x) => x !== 0);
      const i = at === -1 ? Math.min(count, 3) - 1 : Math.min(at, 2);
      return [low(), below(bump(p.parts.length > i ? p.parts : pad(p.parts), i))];
    }
    case "~": {
      // npm: ~1.2 is 1.2.x. composer: ~1.2 is 1.x, ~1.2.3 is 1.2.x. A bare ~1 is 1.x in both.
      const at = family === "npm" ? (count === 1 ? 0 : 1) : count >= 3 ? 1 : 0;
      return [low(), below(bump(p.parts, at))];
    }
    case ">=":
      return [low()];
    case ">":
      return family === "npm" && (count < 3 || p.wild)
        ? [{ op: ">=", v: built(bump(p.parts, count - 1)) }]
        : [{ op: ">", v: built(p.parts, p.pre) }];
    case "<":
      return [{ op: "<", v: built(p.parts, p.pre) }];
    case "<=":
      return family === "npm" && (count < 3 || p.wild)
        ? [below(bump(p.parts, count - 1))]
        : [{ op: "<=", v: built(p.parts, p.pre) }];
    default:
      return undefined;
  }
}

/**
 * A range as a person writes it: ">=15.0.0 <15.2.3", "^1.2", "1.2.*", ">=1.0,<1.5 || >=2.0 <2.3", "1.0 - 1.5",
 * "<= 2.1.3". A space or a comma is "and"; || (or | for composer) is "or". Undefined when it is not a range.
 */
export function parseRange(family: Family, text: string): RangeSet | undefined {
  const source = text.trim();
  if (source === "" || source.length > 300) return undefined;
  const groups = source.split(family === "npm" ? "||" : /\|\|?/);
  const out: RangeSet = [];
  for (const raw of groups) {
    let g = raw.trim();
    if (g === "") return undefined;
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(g);
    const comps: Comparator[] = [];
    if (hyphen) {
      const lo = token(family, `>=${hyphen[1]}`);
      const hi = token(family, `<=${hyphen[2]}`);
      if (!lo || !hi) return undefined;
      comps.push(...lo, ...hi);
    } else {
      g = g.replace(/,/g, " ").replace(/(<=|>=|<|>|=|\^|~)\s+/g, "$1");
      for (const tok of g.split(/\s+/)) {
        const c = token(family, tok);
        if (!c) return undefined;
        comps.push(...c);
      }
    }
    out.push(comps);
  }
  return out;
}

const holds = (family: Family, v: Version, c: Comparator): boolean => {
  const d = compare(family, v, c.v);
  switch (c.op) {
    case "<":
      return d < 0;
    case "<=":
      return d <= 0;
    case ">":
      return d > 0;
    case ">=":
      return d >= 0;
    default:
      return d === 0;
  }
};

const groupHolds = (family: Family, v: Version, g: Comparator[]): boolean =>
  g.every((c) => holds(family, v, c));

/** Whether the version is in the set; undefined when it is not a version of this ecosystem. */
export function inRange(family: Family, version: string, set: RangeSet): boolean | undefined {
  const v = parseVersion(family, version);
  if (!v) return undefined;
  return set.some((g) => groupHolds(family, v, g));
}

/** The version that ends the stretch the version is in ("fixed in"), when the stretch has an end. */
export function fixedVersion(family: Family, version: string, set: RangeSet): string | undefined {
  const v = parseVersion(family, version);
  if (!v) return undefined;
  const g = set.find((s) => groupHolds(family, v, s));
  const ends = (g ?? []).filter((c) => c.op === "<").map((c) => c.v);
  ends.sort((a, b) => compare(family, a, b));
  return ends[0]?.text;
}

/** An OSV range's events: introduced "0" is the start of everything; fixed ends a stretch before it. */
export interface RangeEvent {
  introduced?: string;
  fixed?: string;
  last_affected?: string;
  limit?: string;
}

const isZero = (t: string): boolean => /^v?0(?:\.0){0,3}$/.test(t.trim());

/** The stretches an OSV range lists, or undefined when an event is not a version: never a guess. */
export function rangeFromEvents(
  family: Family,
  events: readonly RangeEvent[],
): RangeSet | undefined {
  const out: RangeSet = [];
  let open: Comparator[] | undefined;
  const bound = (op: Op, text: string): Comparator | undefined => {
    const v = parseVersion(family, text);
    return v ? { op, v } : undefined;
  };
  for (const e of events) {
    if (e.introduced !== undefined) {
      if (open) out.push(open);
      open = [];
      if (!isZero(e.introduced)) {
        const c = bound(">=", e.introduced);
        if (!c) return undefined;
        open.push(c);
      }
    } else if (e.fixed !== undefined || e.last_affected !== undefined) {
      const c = e.fixed !== undefined ? bound("<", e.fixed) : bound("<=", e.last_affected ?? "");
      if (!c) return undefined;
      out.push([...(open ?? []), c]);
      open = undefined;
    }
  }
  if (open) out.push(open);
  return out.length > 0 ? out : undefined;
}

/** A set as words, the way a range is written: ">=15.0.0 <15.2.3 || >=16.0.0". */
export function describeRange(set: RangeSet): string {
  return set
    .map((g) => (g.length === 0 ? "*" : g.map((c) => `${c.op}${c.v.text}`).join(" ")))
    .join(" || ");
}
