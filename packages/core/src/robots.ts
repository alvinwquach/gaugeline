/**
 * A small robots.txt reader and matcher, following RFC 9309:
 * - a group is one or more User-agent lines followed by its rules;
 * - a crawler obeys every group naming it (case-insensitive), or else every "*" group;
 * - the longest matching rule wins, and Allow beats Disallow when two match equally long;
 * - "*" matches any run of characters and a final "$" anchors the end;
 * - an empty Allow or Disallow is no rule at all; /robots.txt itself is always allowed.
 */

export interface RobotsRule {
  allow: boolean;
  /** The path pattern as written, with non-ASCII characters percent-encoded. */
  path: string;
}

export interface RobotsGroup {
  /** Lowercased product tokens, "*" for every crawler. */
  agents: string[];
  rules: RobotsRule[];
}

export interface RobotsFile {
  groups: RobotsGroup[];
  /** Sitemap: lines, in file order. They belong to no group. */
  sitemaps: string[];
}

/** Percent-encode what is not ASCII so a pattern compares with an encoded URL path. */
function encodeNonAscii(text: string): string {
  return text.replace(/[\u0080-\uFFFF]+/g, (c) => {
    try {
      return encodeURIComponent(c);
    } catch {
      return c; // a lone surrogate: leave it, it can only match itself
    }
  });
}

export function parseRobots(text: string): RobotsFile {
  const file: RobotsFile = { groups: [], sitemaps: [] };
  let current: RobotsGroup | undefined;
  // A User-agent line straight after another adds to the same group; after a rule it starts one.
  let lastWasAgent = false;
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        file.groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (key === "allow" || key === "disallow") {
      lastWasAgent = false;
      // Rules before any User-agent line belong to no group and are ignored.
      if (!current || value === "") continue;
      current.rules.push({ allow: key === "allow", path: encodeNonAscii(value) });
    } else if (key === "sitemap") {
      if (value !== "") file.sitemaps.push(value);
    } else {
      lastWasAgent = false;
    }
  }
  return file;
}

/** The rules a crawler named `agent` obeys: its own groups, or else the "*" groups. */
export function rulesFor(file: RobotsFile, agent: string): RobotsRule[] {
  const token = agent.toLowerCase();
  const own = file.groups.filter((g) => token !== "*" && g.agents.includes(token));
  const groups = own.length > 0 ? own : file.groups.filter((g) => g.agents.includes("*"));
  return groups.flatMap((g) => g.rules);
}

const patternCache = new Map<string, RegExp>();

function patternRegex(pattern: string): RegExp {
  let re = patternCache.get(pattern);
  if (!re) {
    const anchored = pattern.endsWith("$");
    const body = (anchored ? pattern.slice(0, -1) : pattern)
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    re = new RegExp(`^${body}${anchored ? "$" : ""}`);
    patternCache.set(pattern, re);
  }
  return re;
}

/** True when `pattern` matches the start of `path` (all of it, with a final "$"). */
export function patternMatches(pattern: string, path: string): boolean {
  return patternRegex(pattern).test(path);
}

/**
 * The rule that decides `path` for `agent`, or undefined when no rule matches (allowed).
 * Specificity is the pattern's length in characters, as RFC 9309 counts octets of the
 * (percent-encoded) pattern.
 */
export function decidingRule(
  file: RobotsFile,
  agent: string,
  path: string,
): RobotsRule | undefined {
  let best: RobotsRule | undefined;
  for (const rule of rulesFor(file, agent)) {
    if (!patternMatches(rule.path, path)) continue;
    if (
      !best ||
      rule.path.length > best.path.length ||
      (rule.path.length === best.path.length && rule.allow && !best.allow)
    ) {
      best = rule;
    }
  }
  return best;
}

/** May `agent` fetch `path` (a URL path with its query, percent-encoded)? */
export function isAllowed(file: RobotsFile, agent: string, path: string): boolean {
  if (path === "/robots.txt") return true;
  return decidingRule(file, agent, encodeNonAscii(path))?.allow ?? true;
}
