import { NONCE_OR_HASH, own, type Directives, type ScriptBaseline } from "./inventory.js";

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
/** Directives that report or carry no sources that could allow more. */
const NOT_SOURCES = new Set(["report-uri", "report-to"]);
/** Tokens that do not allow anything more (the marker, and report-sample). */
const NEUTRAL = new Set([NONCE_OR_HASH, "'report-sample'"]);

const show = (tokens: readonly string[]) => (tokens.length === 0 ? "nothing" : tokens.join(" "));
/** A header's value as it reads, from its directives: "max-age=300; includesubdomains", "camera=()". */
function describeHeader(name: string, d: Directives): string {
  if (name === "strict-transport-security")
    return Object.entries(d)
      .map(([k, v]) => (v.length > 0 ? `${k}=${v.join(" ")}` : k))
      .join("; ");
  if (name === "permissions-policy")
    return Object.entries(d)
      .map(([k, v]) => `${k}=(${v.join(" ")})`)
      .join(", ");
  return show(own(d, "") ?? []);
}
const names = (d: Directives) => Object.keys(d).filter((k) => !k.includes("#"));

/** A source the old list already allowed through a wildcard or a scheme, so listing it is narrowing. */
function covered(token: string, before: readonly string[]): boolean {
  if (
    before.includes("*") &&
    (token === "'self'" || !token.startsWith("'")) &&
    !/^[a-z]+:$/.test(token)
  )
    return true;
  if (before.includes("https:") && token.startsWith("https://")) return true;
  return before.includes("http:") && /^https?:\/\//.test(token);
}

function cspChanges(prev: Directives, next: Directives): BaselineChange[] {
  const out: BaselineChange[] = [];
  const base = (k: string) => k.split("#")[0] ?? k;
  for (const [name, before] of Object.entries(prev)) {
    if (NOT_SOURCES.has(base(name))) continue;
    const after = own(next, name);
    const scripty = SCRIPT_DIRECTIVES.has(base(name));
    if (after === undefined) {
      out.push({
        checkId: "csp-loosened",
        severity: scripty ? "high" : "medium",
        evidence: `content-security-policy: ${name} is no longer in the policy; last run it was ${show(before)}`,
      });
      continue;
    }
    const added = after.filter(
      (t) => !before.includes(t) && !NEUTRAL.has(t) && !covered(t, before),
    );
    if (added.length === 0) continue;
    const risky = scripty && added.some((t) => RISKY.has(t));
    out.push({
      checkId: "csp-loosened",
      severity: risky ? "high" : "medium",
      evidence: `content-security-policy: ${name} now allows ${show(added)}; last run it was ${show(before)}`,
    });
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
    const age = (d: Directives) => Number(own(d, "max-age")?.[0] ?? 0);
    const lost: string[] = [];
    if (age(after) < age(before)) lost.push(`max-age ${age(before)} -> ${age(after)}`);
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
      if (now === undefined) out.push(`${feature} is no longer set (last run: ${show(was)})`);
      else if (now.some((t) => !was.includes(t)))
        out.push(`${feature} now allows ${show(now)} (last run: ${show(was)})`);
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
        evidence: `${key} is new since the last run (${now.sri ? "with" : "no"} integrity attribute)`,
      });
    } else if (before.sri && !now.sri) {
      out.push({
        checkId: "script-changed",
        severity: "medium",
        evidence: `${key} has no integrity attribute now; last run it had one`,
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
            : `${name} is no longer sent; last run it was ${describeHeader(name, before)}`,
      });
    } else if (name === "content-security-policy") {
      out.push(...cspChanges(before, after));
    } else {
      for (const what of headerChanges(name, before, after))
        out.push({
          checkId: "security-header-loosened",
          severity: "medium",
          evidence: `${name}: ${what}`,
        });
    }
  }
  return out;
}
