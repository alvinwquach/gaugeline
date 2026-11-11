import { escapeInvisible } from "../checks/hidden-text/escape.js";
import type { LibraryId } from "../libraries/advisories.js";
import type { Evidence, HostEvidence } from "./evidence.js";
import { fixedVersion, inRange } from "./range.js";
import type { Verdict } from "./schema.js";
import type { Advisory, Component } from "./target.js";

/**
 * How the answer is reached. Three verdicts and no more: likely-affected, likely-not-affected, cannot-tell. A
 * version that is read and inside the affected versions is likely-affected; one that is read and outside is
 * likely-not-affected; a version that cannot be read, a site that cannot be seen into, or a component that
 * only a repository or a server could show is cannot-tell. A component that is not seen at all is
 * likely-not-affected only when what was looked at could have shown it ("no sign of the affected component
 * from outside"), and cannot-tell when it could not. There is no "safe": outside-in cannot know.
 */
export interface ComponentVerdict {
  component: Component;
  verdict: Verdict;
  evidence: string[];
  fixedIn?: string;
  /** True for a component that only a repository or server can show: it does not decide the advisory's verdict. */
  invisible: boolean;
}

export interface Decision {
  verdict: Verdict;
  headline: string;
  evidence: string[];
  components: ComponentVerdict[];
  checkInside: string[];
  couldNotCheck: string[];
}

const clip = (s: string, n = 100): string => escapeInvisible(s, n);

/** npm packages whose served copy E-12's detection can name. */
const LIBRARY_OF: Readonly<Record<string, LibraryId>> = {
  jquery: "jquery",
  "jquery-ui": "jquery-ui",
  "jquery-ui-dist": "jquery-ui",
  lodash: "lodash",
  moment: "moment",
  bootstrap: "bootstrap",
  angular: "angularjs",
};

/** What the question needs read, from the components: used to read no more than that. */
export function needsOf(components: readonly Component[]): { next: boolean; libraries: boolean } {
  return {
    next: components.some((c) => c.kind === "npm" && c.name === "next"),
    libraries: components.some((c) => c.kind === "npm" && LIBRARY_OF[c.name] !== undefined),
  };
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const readable = (e: Evidence): HostEvidence[] => e.hosts.filter((h) => h.read.ok);
const originOf = (h: HostEvidence): string => (h.read.ok ? h.read.origin : h.host);
const names = (hs: readonly HostEvidence[]): string => hs.map((h) => originOf(h)).join(", ");

/**
 * Whether "not seen" can be believed: every host that must answer did, and none is hidden behind a CDN that
 * removes what would name it. Otherwise the reason, in a sentence.
 */
function absence(e: Evidence): string | undefined {
  for (const h of e.hosts)
    if (h.required && !h.read.ok)
      return `${clip(h.host)} (named by you) could not be read: ${clip(h.read.reason, 120)}`;
  for (const h of readable(e)) if (h.opaque) return `${originOf(h)}: ${h.opaque}`;
  return undefined;
}

interface Seen {
  host: HostEvidence;
  /** The version, or undefined when it was seen with none. */
  version?: string;
  /** How it was read, in words. */
  how: string;
}

/** Compare each version seen with the affected versions; the three outcomes become one verdict. */
function judgeSeen(
  c: Component,
  seen: Seen[],
  label: string,
): Omit<ComponentVerdict, "component" | "invisible"> {
  const lines: string[] = [];
  const inside: Seen[] = [];
  const unknown: Seen[] = [];
  const outside: Seen[] = [];
  const unique = new Map<string, Seen>();
  for (const s of seen) unique.set(`${s.host.host}\n${s.version ?? ""}\n${s.how}`, s);
  for (const s of unique.values()) {
    const hit = s.version !== undefined && c.family && c.set ? parse(c, s.version) : undefined;
    (hit === true ? inside : hit === false ? outside : unknown).push(s);
  }
  const at = (s: Seen) => `${originOf(s.host)} (${s.how})`;
  if (!c.set) {
    lines.push(
      `${label} is in use, but ${c.unreadable ?? "the advisory lists no versions Gaugeline can read"}; give the versions yourself with --package.`,
    );
    return { verdict: "cannot-tell", evidence: lines };
  }
  for (const s of inside)
    lines.push(
      `${label} ${clip(s.version ?? "")} on ${at(s)} is inside the affected versions ${c.rangeText}.`,
    );
  for (const s of unknown)
    lines.push(
      s.version === undefined
        ? `${label} is in use on ${originOf(s.host)}, but its version could not be read (${s.how}).`
        : `${label} ${clip(s.version)} on ${at(s)} could not be compared with the affected versions ${c.rangeText}.`,
    );
  for (const s of outside)
    lines.push(
      `${label} ${clip(s.version ?? "")} on ${at(s)} is outside the affected versions ${c.rangeText}.`,
    );
  if (inside.length > 0) {
    const fixed =
      c.family && c.set && inside[0]?.version
        ? fixedVersion(c.family, inside[0].version, c.set)
        : undefined;
    return { verdict: "likely-affected", evidence: lines, ...(fixed ? { fixedIn: fixed } : {}) };
  }
  return { verdict: unknown.length > 0 ? "cannot-tell" : "likely-not-affected", evidence: lines };
}

const parse = (c: Component, version: string): boolean | undefined =>
  c.family && c.set ? inRange(c.family, version, c.set) : undefined;

/** "Not seen" lines and the verdict they support, or the reason they cannot. */
function notSeen(
  e: Evidence,
  what: string,
  extra?: string,
): Omit<ComponentVerdict, "component" | "invisible"> {
  const n = readable(e).length;
  const why = absence(e);
  if (why)
    return {
      verdict: "cannot-tell",
      evidence: [`${what} was not seen, and that cannot be relied on: ${why}.`],
    };
  return {
    verdict: "likely-not-affected",
    evidence: [
      `No ${what} seen on ${plural(n, "hostname")} (${names(readable(e))})${extra ? `; ${extra}` : ""}.`,
    ],
  };
}

function judge(c: Component, e: Evidence): ComponentVerdict {
  const hosts = readable(e);
  const done = (
    r: Omit<ComponentVerdict, "component" | "invisible">,
    invisible = false,
  ): ComponentVerdict => ({
    component: c,
    invisible,
    ...r,
  });
  const name = clip(c.name);

  if (c.kind === "npm" && c.name === "next") {
    const seen: Seen[] = hosts.flatMap((h) =>
      h.next
        ? [
            {
              host: h,
              ...(h.next.version ? { version: h.next.version } : {}),
              how: h.next.how ?? "its files and headers name it",
            },
          ]
        : [],
    );
    return done(seen.length > 0 ? judgeSeen(c, seen, "Next.js") : notSeen(e, "Next.js"));
  }
  const lib = c.kind === "npm" ? LIBRARY_OF[c.name] : undefined;
  if (lib) {
    const seen: Seen[] = hosts.flatMap((h) =>
      h.libraries
        .filter((l) => l.library === lib)
        .map((l) => ({
          host: h,
          ...(l.version ? { version: l.version } : {}),
          how: `${HOW[l.how]} in ${clip(l.script, 120)}`,
        })),
    );
    if (seen.length > 0) return done(judgeSeen(c, seen, name));
    const unread = hosts.reduce((n, h) => n + h.scriptsUnread + h.scriptsUnidentified, 0);
    if (unread > 0)
      return done({
        verdict: "cannot-tell",
        evidence: [
          `${name} was not named by any script, but ${plural(unread, "script")} could not be read or carry${unread === 1 ? "es" : ""} no library name or version, and a bundle can hold it.`,
        ],
      });
    return done(notSeen(e, `${name} in the scripts the pages name`));
  }
  if (c.kind === "php") {
    const seen: Seen[] = hosts.flatMap((h) =>
      h.php
        ? [{ host: h, ...(h.php.version ? { version: h.php.version } : {}), how: h.php.how }]
        : [],
    );
    return done(seen.length > 0 ? judgeSeen(c, seen, "PHP") : notSeen(e, "PHP"));
  }
  if (c.kind === "composer") {
    const php = hosts.filter((h) => h.php);
    if (php.length === 0) return done(notSeen(e, "PHP"));
    return done({
      verdict: "cannot-tell",
      evidence: [
        `PHP is in use on ${names(php)}, and which Composer packages it runs, at which versions, cannot be seen from outside, so ${name} could not be compared.`,
      ],
    });
  }
  if (c.kind === "wp-core" || c.kind === "wp-plugin" || c.kind === "wp-theme") {
    const wp = hosts.filter((h) => h.wordpress);
    if (wp.length === 0) return done(notSeen(e, "WordPress"));
    if (c.kind === "wp-core") {
      const seen: Seen[] = wp.map((h) => ({
        host: h,
        ...(h.wordpress?.version ? { version: h.wordpress.version.value } : {}),
        how: h.wordpress?.version
          ? `from ${h.wordpress.version.how}`
          : "the page shows no WordPress version",
      }));
      return done(judgeSeen(c, seen, "WordPress"));
    }
    const kind = c.kind === "wp-plugin" ? "plugin" : "theme";
    const seen: Seen[] = wp.flatMap((h) => {
      const rows = (c.kind === "wp-plugin" ? h.wordpress?.plugins : h.wordpress?.themes) ?? [];
      const row = rows.find((r) => r.slug === c.name);
      if (!row) return [];
      const how = h.wordpress?.signs.includes("the WordPress read (C-01)")
        ? "from the WordPress read (C-01)"
        : `from the version on its file addresses`;
      return row.versions.length === 0
        ? [{ host: h, how: "its files are on the page with no version of their own" }]
        : row.versions.map((v) => ({ host: h, version: v, how }));
    });
    if (seen.length > 0) return done(judgeSeen(c, seen, name));
    if (c.kind === "wp-theme") {
      const active = wp.flatMap((h) => h.wordpress?.themes ?? []).map((t) => t.slug);
      if (active.length > 0 && !absence(e))
        return done({
          verdict: "likely-not-affected",
          evidence: [
            `The theme in use looks like ${active
              .slice(0, 3)
              .map((s) => clip(s, 40))
              .join(
                ", ",
              )}; no files of the theme ${name} seen on ${plural(wp.length, "hostname")}.`,
          ],
        });
    }
    return done({
      verdict: "cannot-tell",
      evidence: [
        `WordPress is in use on ${names(wp)}, but no files of the ${kind} ${name} are on the page. A ${kind} can be installed or active without serving a file on this page.`,
      ],
    });
  }
  return done(
    {
      verdict: "cannot-tell",
      evidence: [
        c.kind === "npm"
          ? `${name} (npm) is a package a build or a server uses; it does not announce itself to a visitor.`
          : `${name} (${clip(c.label, 30)}) is a package only the project or the server can show.`,
      ],
    },
    true,
  );
}

const HOW: Record<string, string> = {
  banner: "the file's banner comment",
  "version-string": "a version string in the file",
  "file-name": "the script's address",
  name: "the file's license line",
};

/** The lines that say what was looked at, before the lines that decided. */
function context(e: Evidence): string[] {
  const out: string[] = [];
  for (const h of e.hosts) {
    if (!h.read.ok) continue;
    const bits: string[] = [];
    if (h.hosting) bits.push(`served by ${h.hosting}`);
    if (h.cdn) bits.push(`behind ${h.cdn}`);
    const stack = [
      ...h.stacks.filter((s) => s !== "WordPress" && s !== "PHP"),
      ...(h.wordpress
        ? [`WordPress${h.wordpress.version ? ` ${clip(h.wordpress.version.value, 20)}` : ""}`]
        : []),
      ...(h.php ? [`PHP${h.php.version ? ` ${clip(h.php.version, 20)}` : ""}`] : []),
    ];
    if (stack.length > 0) bits.push(`identified as ${stack.join(", ")}`);
    if (h.dns)
      bits.push(`name servers ${h.dns.provider ?? h.dns.nameservers.slice(0, 2).join(", ")}`);
    out.push(
      `${originOf(h)}: ${bits.length > 0 ? bits.join("; ") : "no framework or host named in its headers or page"}.`,
    );
  }
  return out;
}

const CHECK_INSIDE: Record<string, (name: string) => string> = {
  npm: (n) =>
    `the project's lockfile (package-lock.json, pnpm-lock.yaml or yarn.lock): which version of ${n} is installed, including as a dependency of another package.`,
  composer: (n) => `composer.lock on the server: which version of ${n} is installed.`,
  php: () =>
    "the PHP version the server runs (phpinfo or `php -v` on the host), which a header can hide or misstate.",
  "wp-core": () =>
    "the WordPress version in the dashboard (Dashboard, Updates) or with `wp core version`.",
  "wp-plugin": (n) =>
    `the Plugins page in wp-admin, or \`wp plugin list\`: whether ${n} is installed or active, and which version.`,
  "wp-theme": (n) =>
    `the Themes page in wp-admin: whether ${n} is installed, even if it is not the active theme.`,
  other: (n) =>
    `the project's lockfile or the server's package list for ${n}: this kind of package cannot be seen from outside.`,
};

/** Decide an advisory against what was read. Pure: the same evidence gives the same answer. */
export function decide(advisory: Advisory, e: Evidence): Decision {
  const components = advisory.components.map((c) => judge(c, e));
  const lines = context(e);
  const couldNotCheck: string[] = [...e.notes];
  for (const h of e.hosts) {
    if (!h.read.ok)
      couldNotCheck.push(
        `${h.host} did not answer${h.required ? " (named by you)" : ""}: ${clip(h.read.reason, 120)}.`,
      );
    for (const l of h.limits) couldNotCheck.push(`${originOf(h)}: ${l}.`);
    if (h.scriptsUnread > 0)
      couldNotCheck.push(`${originOf(h)}: ${plural(h.scriptsUnread, "script")} could not be read.`);
  }
  const checkInside = [
    ...new Set(
      advisory.components.map((c) =>
        (CHECK_INSIDE[c.kind] ?? CHECK_INSIDE.other!)(clip(c.name, 60)),
      ),
    ),
    "old copies of the site: staging and preview deployments, and hostnames this run did not look at, are not covered by what was read.",
  ];

  let verdict: Verdict;
  let deciding: ComponentVerdict[];
  if (advisory.withdrawn !== undefined) {
    verdict = "cannot-tell";
    deciding = [];
    lines.push(
      `OSV marks this advisory withdrawn (${clip(advisory.withdrawn, 30)}), often because another advisory replaced it, so its versions were not compared. Look up the replacing advisory, or give the package and range with --package.`,
    );
  } else if (components.length === 0) {
    verdict = "cannot-tell";
    deciding = [];
    lines.push(
      "The advisory lists no affected package, so there was nothing to look for. Give the package and range with --package.",
    );
  } else {
    const visible = components.some((c) => !c.invisible)
      ? components.filter((c) => !c.invisible)
      : components;
    if (visible.some((c) => c.verdict === "likely-affected")) {
      verdict = "likely-affected";
      deciding = visible.filter((c) => c.verdict === "likely-affected");
    } else if (visible.some((c) => c.verdict === "cannot-tell")) {
      verdict = "cannot-tell";
      deciding = visible.filter((c) => c.verdict === "cannot-tell");
    } else {
      verdict = "likely-not-affected";
      deciding = visible;
    }
    for (const c of deciding) lines.push(...c.evidence);
    for (const c of components.filter((x) => x.invisible && !deciding.includes(x)))
      lines.push(...c.evidence);
  }
  const outside = deciding.find((c) =>
    c.evidence.some((l) => /is outside the affected versions/.test(l)),
  );
  const headline =
    verdict === "likely-affected"
      ? `Likely affected: ${firstLine(deciding)}`
      : verdict === "likely-not-affected"
        ? outside
          ? `Likely not affected: ${firstLine([outside])}`
          : "Likely not affected: no sign of the affected component from outside."
        : `Cannot tell: ${firstLine(deciding) || "the advisory could not be compared with what the site shows."}`;
  return { verdict, headline, evidence: lines, components, checkInside, couldNotCheck };
}

const firstLine = (cs: readonly ComponentVerdict[]): string => cs[0]?.evidence[0] ?? "";
