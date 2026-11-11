import {
  NONCE_OR_HASH,
  dict,
  own,
  printable,
  type Directives,
  type ScriptBaseline,
} from "./inventory.js";

export type BaselineCheckId = "script-changed" | "csp-loosened" | "security-header-loosened";

export interface BaselineChange {
  checkId: BaselineCheckId;
  severity: "high" | "medium" | "low";
  evidence: string;
}

/** Directives whose sources decide which scripts may run; a risky source added here is high. */
const SCRIPT_DIRECTIVES = new Set([
  "default-src",
  "script-src",
  "script-src-elem",
  "script-src-attr",
]);
/** Sources that let any, or inline, code run. */
const RISKY = new Set(["'unsafe-inline'", "'unsafe-eval'", "*", "data:", "https:", "http:"]);
/** Directives whose value is not kept (see parseCsp): there is nothing to compare. */
const NOT_COMPARED = new Set(["report-uri", "report-to"]);
/** Tokens that allow nothing: the nonce and hash marker, and report-sample. */
const NEUTRAL = new Set([NONCE_OR_HASH, "'report-sample'"]);

/**
 * Where a fetch directive looks when the policy does not set it: its own list, then these in order
 * (CSP level 3). A directive that is set nowhere along the way restricts nothing.
 */
const FALLBACK: Record<string, readonly string[]> = {
  "default-src": [],
  "script-src": ["default-src"],
  "script-src-elem": ["script-src", "default-src"],
  "script-src-attr": ["script-src", "default-src"],
  "style-src": ["default-src"],
  "style-src-elem": ["style-src", "default-src"],
  "style-src-attr": ["style-src", "default-src"],
  "child-src": ["default-src"],
  "frame-src": ["child-src", "default-src"],
  "worker-src": ["child-src", "script-src", "default-src"],
  "img-src": ["default-src"],
  "font-src": ["default-src"],
  "connect-src": ["default-src"],
  "media-src": ["default-src"],
  "object-src": ["default-src"],
  "manifest-src": ["default-src"],
  "prefetch-src": ["default-src"],
};

const show = (tokens: readonly string[]) =>
  tokens.length === 0 ? "nothing" : tokens.map(printable).join(" ");

/** A header's value as it reads, from its directives: "max-age=300; includesubdomains", "camera=()". */
function describeHeader(name: string, d: Directives): string {
  if (name === "strict-transport-security")
    return Object.entries(d)
      .map(([k, v]) => printable(v.length > 0 ? `${k}=${v.join(" ")}` : k))
      .join("; ");
  if (name === "permissions-policy")
    return Object.entries(d)
      .map(([k, v]) => printable(`${k}=(${v.join(" ")})`))
      .join(", ");
  return show(own(d, "") ?? []);
}
const names = (d: Directives) => Object.keys(d).filter((k) => !k.includes("#"));

/** What a source list allows: 'none' allows nothing, and 'unsafe-inline' is ignored beside a nonce or hash. */
function sources(list: readonly string[]): string[] {
  const guarded = list.includes(NONCE_OR_HASH);
  return list.filter(
    (t) => t !== "'none'" && !NEUTRAL.has(t) && !(guarded && t === "'unsafe-inline'"),
  );
}

interface HostSource {
  scheme: string | undefined;
  host: string;
  port: string | undefined;
  path: string | undefined;
}
const HOST_SOURCE =
  /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*|(?:\*\.)?[a-z0-9_.-]+)(?::(\*|\d+))?(\/.*)?$/;
const DEFAULT_PORT: Record<string, string> = { http: "80", https: "443", ws: "80", wss: "443" };

function hostSource(token: string): HostSource | undefined {
  if (token.startsWith("'") || /^[a-z][a-z0-9+.-]*:$/.test(token)) return undefined;
  const m = HOST_SOURCE.exec(token);
  if (!m) return undefined;
  const scheme = m[1];
  const port = m[3] !== undefined && m[3] === DEFAULT_PORT[scheme ?? "https"] ? undefined : m[3];
  return { scheme, host: m[2] ?? "", port, path: m[4] };
}

/** Does a scheme source ("https:") or a host source's scheme allow what `to` has? A missing scheme is the page's. */
function schemeAllows(from: string | undefined, to: string | undefined): boolean {
  if (from === undefined) return to === undefined || to === "https" || to === "wss";
  if (to === undefined) return ["http", "https", "ws", "wss"].includes(from);
  return from === to || (from === "http" && to === "https") || (from === "ws" && to === "wss");
}

/** Does the host source `from` allow everything the host source `to` allows? */
function hostCovers(from: HostSource, to: HostSource): boolean {
  if (!schemeAllows(from.scheme, to.scheme)) return false;
  if (from.host !== "*") {
    if (from.host.startsWith("*.")) {
      if (to.host === "*" || !to.host.endsWith(from.host.slice(1))) return false;
    } else if (from.host !== to.host) return false;
  }
  if (from.port !== "*" && from.port !== to.port) return false;
  if (from.path === undefined || from.path === "/") return true;
  if (to.path === undefined) return false;
  return from.path.endsWith("/") ? to.path.startsWith(from.path) : to.path === from.path;
}

/** Is `token` something the list `before` already allowed? Then listing it is not allowing more. */
function covered(token: string, before: readonly string[]): boolean {
  if (before.includes(token)) return true;
  const scheme = /^([a-z][a-z0-9+.-]*):$/.exec(token)?.[1];
  if (scheme !== undefined)
    return before.some(
      (b) => /^[a-z][a-z0-9+.-]*:$/.test(b) && schemeAllows(b.slice(0, -1), scheme),
    );
  if (token === "'self'") return before.includes("*");
  const to = hostSource(token);
  if (to === undefined) return false;
  return before.some((b) => {
    if (b === "*")
      return to.scheme === undefined || ["http", "https", "ws", "wss"].includes(to.scheme);
    const bs = /^([a-z][a-z0-9+.-]*):$/.exec(b)?.[1];
    if (bs !== undefined) return schemeAllows(bs, to.scheme);
    const from = hostSource(b);
    return from !== undefined && hostCovers(from, to);
  });
}

/** A directive's list, or the one it falls back to; undefined when nothing in the chain is set. */
function resolve(d: Directives, name: string): { tokens: string[]; from: string } | undefined {
  for (const n of [name, ...(FALLBACK[name] ?? [])]) {
    const tokens = own(d, n);
    if (tokens !== undefined) return { tokens, from: n };
  }
  return undefined;
}

/** The directives of each policy a response sent: index 1 as written, later ones from "name#2". */
function policies(d: Directives): Map<number, Directives> {
  const out = new Map<number, Directives>();
  for (const [key, tokens] of Object.entries(d)) {
    const m = /^(.*)#(\d+)$/.exec(key);
    const index = m ? Number(m[2]) : 1;
    const policy = out.get(index) ?? dict<string[]>();
    policy[m ? (m[1] ?? key) : key] = tokens;
    out.set(index, policy);
  }
  return out;
}

/**
 * The CSP changes that allow more. Each directive set in either run is compared by what it
 * allows once its fallbacks are applied (script-src-elem over script-src over default-src), so a
 * directive added or removed is a change only if the policy as a whole allows more. 'none' allows
 * nothing, a host under a wildcard or a path under a path is narrowing, and 'unsafe-inline' beside
 * a nonce or hash does nothing.
 */
function cspChanges(prev: Directives, next: Directives): BaselineChange[] {
  const out: BaselineChange[] = [];
  const now = policies(next);
  for (const [index, before] of policies(prev)) {
    const after = now.get(index) ?? dict<string[]>();
    const suffix = index === 1 ? "" : `#${index}`;
    for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (NOT_COMPARED.has(name)) continue;
      const label = printable(`${name}${suffix}`);
      const was = resolve(before, name);
      const is = resolve(after, name);
      const scripty = SCRIPT_DIRECTIVES.has(name);
      if (was === undefined) continue;
      if (is === undefined) {
        out.push({
          checkId: "csp-loosened",
          severity: scripty ? "high" : "medium",
          evidence: `content-security-policy: ${label} is no longer in the policy; last run it was ${show(was.tokens)}`,
        });
        continue;
      }
      const allowed = sources(was.tokens);
      const added = sources(is.tokens).filter((t) => !covered(t, allowed));
      if (added.length === 0) continue;
      out.push({
        checkId: "csp-loosened",
        severity: scripty && added.some((t) => RISKY.has(t)) ? "high" : "medium",
        evidence: `content-security-policy: ${label} now allows ${show(added)}; last run it was ${show(was.tokens)}${was.from === name ? "" : ` (from ${was.from})`}`,
      });
    }
  }
  return out;
}

/** 1 for each rank list: higher is stricter. */
const RANKS: Record<string, readonly string[]> = {
  "x-frame-options": ["other", "sameorigin", "deny"],
  "cross-origin-opener-policy": ["unsafe-none", "same-origin-allow-popups", "same-origin"],
  "cross-origin-embedder-policy": ["unsafe-none", "credentialless", "require-corp"],
  "cross-origin-resource-policy": ["cross-origin", "same-site", "same-origin"],
  // Least to most sending of the address, reversed so higher is stricter.
  "referrer-policy": [
    "unsafe-url",
    "no-referrer-when-downgrade",
    "origin-when-cross-origin",
    "strict-origin-when-cross-origin",
    "origin",
    "strict-origin",
    "same-origin",
    "no-referrer",
  ],
};

/** A word's place in the header's list; a word that is in no list is the lowest. */
function rank(name: string, d: Directives): number {
  const list = RANKS[name] ?? [];
  const words = own(d, "") ?? [];
  // For referrer-policy the last recognised word wins, as in browsers; for the others the first.
  const picked = name === "referrer-policy" ? [...words].reverse() : words;
  const at = picked.map((w) => list.indexOf(w)).find((i) => i >= 0);
  return at ?? 0;
}

function headerChanges(name: string, before: Directives, after: Directives): string[] {
  if (name === "strict-transport-security") {
    // A missing or unreadable max-age is 0 (browsers ignore the header); a saved one that is not a number is not compared.
    const age = (d: Directives) => {
      const n = Number(own(d, "max-age")?.[0] ?? 0);
      return Number.isFinite(n) ? n : undefined;
    };
    const was = age(before);
    const lost: string[] = [];
    if (was !== undefined && (age(after) ?? 0) < was)
      lost.push(`max-age ${was} -> ${age(after) ?? 0}`);
    for (const flag of ["includesubdomains", "preload"])
      if (own(before, flag) && !own(after, flag)) lost.push(`${flag} dropped`);
    return lost;
  }
  if (name === "x-content-type-options") {
    return (own(before, "") ?? []).includes("nosniff") &&
      !(own(after, "") ?? []).includes("nosniff")
      ? [`${show(own(after, "") ?? [])} now, nosniff last run`]
      : [];
  }
  if (name === "permissions-policy") {
    const out: string[] = [];
    for (const [feature, was] of Object.entries(before)) {
      const now = own(after, feature);
      if (now === undefined)
        out.push(`${printable(feature)} is no longer set (last run: ${show(was)})`);
      else if (now.some((t) => !was.includes(t)))
        out.push(`${printable(feature)} now allows ${show(now)} (last run: ${show(was)})`);
    }
    return out;
  }
  if (name in RANKS && rank(name, after) < rank(name, before))
    return [`${show(own(after, "") ?? [])} now, ${show(own(before, "") ?? [])} last run`];
  return [];
}

/**
 * What changed between two baselines of one page. Pure. Only a change in the direction of "allows
 * more" is reported: a new third-party script, a script that lost its integrity attribute, a
 * header that is gone or sends less protection, a CSP source or Permissions-Policy value added.
 * A script that went away, a header that appeared or got stricter, and a nonce that changed are
 * not changes.
 */
export function diffBaselines(prev: ScriptBaseline, next: ScriptBaseline): BaselineChange[] {
  const out: BaselineChange[] = [];
  for (const [key, now] of Object.entries(next.scripts)) {
    const before = own(prev.scripts, key);
    if (before === undefined) {
      out.push({
        checkId: "script-changed",
        severity: "medium",
        evidence: `${printable(key)} is new since the last run (${now.sri ? "with" : "no"} integrity attribute)`,
      });
    } else if (before.sri && !now.sri) {
      out.push({
        checkId: "script-changed",
        severity: "medium",
        evidence: `${printable(key)} has no integrity attribute now; last run it had one`,
      });
    }
  }
  for (const [name, before] of Object.entries(prev.headers)) {
    const after = own(next.headers, name);
    if (after === undefined) {
      out.push({
        checkId: name === "content-security-policy" ? "csp-loosened" : "security-header-loosened",
        severity: name === "content-security-policy" ? "high" : "medium",
        evidence:
          name === "content-security-policy"
            ? `content-security-policy is no longer sent; last run it had ${names(before).length} directives`
            : `${printable(name)} is no longer sent; last run it was ${describeHeader(name, before)}`,
      });
    } else if (name === "content-security-policy") {
      out.push(...cspChanges(before, after));
    } else {
      for (const what of headerChanges(name, before, after))
        out.push({
          checkId: "security-header-loosened",
          severity: "medium",
          evidence: `${printable(name)}: ${what}`,
        });
    }
  }
  return out;
}
