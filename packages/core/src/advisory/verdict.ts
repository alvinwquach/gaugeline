import { escapeInvisible } from "../checks/hidden-text/escape.js";
import type { LibraryId } from "../libraries/advisories.js";
import { LIBRARY_SCRIPT_CAP } from "../libraries/reader.js";
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
 * Whether "not seen" can be believed so far: every host that must answer did, a host that failed to answer is
 * not skipped (a name that does not exist at all, such as a www twin nobody set up, is nothing to read), and
 * none is hidden behind a CDN that removes what would name it. Otherwise the reason, in a sentence.
 */
function unreadWhy(e: Evidence): string | undefined {
  for (const h of e.hosts)
    if (!h.read.ok && (h.required || !h.read.missing))
      return h.required
        ? `${clip(h.host)} (named by you) could not be read: ${clip(h.read.reason, 120)}`
        : `${clip(h.host)} did not answer (${clip(h.read.reason, 120)}), so what is behind it was not looked at`;
  for (const h of readable(e)) if (h.opaque) return `${originOf(h)}: ${h.opaque}`;
  return undefined;
}

/** Hosts that cannot run PHP, and generators and runtimes that are not PHP: positive evidence of no PHP. */
const NO_PHP_PLATFORMS = new Set(["Netlify", "GitHub Pages", "Squarespace", "Wix", "Shopify"]);
const STATIC_GENERATORS = new Set([
  "hugo",
  "jekyll",
  "eleventy",
  "astro",
  "gatsby",
  "hexo",
  "docusaurus",
  "vitepress",
  "mkdocs",
  "pelican",
]);
const NON_PHP_RUNTIMES = new Set(["express", "asp.net"]);

type Target = "next" | "wordpress" | "php";

/**
 * Whether what a host showed rules the component out: a host that names what it is built on, and that is
 * something else. A page that names nothing, or only the front end that can sit in front of a PHP or WordPress
 * back end (Next.js), does not. Why not, in a sentence, or undefined when it does rule it out.
 */
function notRuledOut(h: HostEvidence, target: Target, what: string): string | undefined {
  const stacks = h.stacks.map((x) => x.toLowerCase());
  const others = h.stacks.filter((x) => x !== "Next.js" && x !== "WordPress" && x !== "PHP");
  const ruled =
    target === "next"
      ? h.stacks.some((x) => x !== "Next.js")
      : target === "wordpress"
        ? h.stacks.some((x) => x !== "WordPress" && x !== "Next.js") ||
          NO_PHP_PLATFORMS.has(h.hosting ?? "")
        : NO_PHP_PLATFORMS.has(h.hosting ?? "") ||
          stacks.some((x) => STATIC_GENERATORS.has(x) || NON_PHP_RUNTIMES.has(x));
  if (ruled) return undefined;
  const o = originOf(h);
  if (h.stacks.length === 0)
    return `${o} does not say what it is built on, so ${what} cannot be ruled out`;
  if (target !== "next" && stacks.includes("next.js"))
    return `${o} is a Next.js front end, and a PHP or WordPress back end can sit behind one without showing`;
  return `${o} is built on ${others
    .concat(h.stacks)
    .slice(0, 2)
    .map((x) => clip(x, 40))
    .join(", ")}, which does not say whether ${what} is behind it`;
}

interface Seen {
  host: HostEvidence;
  /** The version, or undefined when it was seen with none. */
  version?: string;
  /** How it was read, in words. */
  how: string;
  /** PHP only: the number is a distribution's build, so backported fixes do not show in it. */
  distro?: string;
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
    // A distribution can backport a fix without changing the number: inside the range it decides nothing.
    (hit === true && s.distro === undefined ? inside : hit === false ? outside : unknown).push(s);
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
        : s.distro !== undefined
          ? `${label} ${clip(s.version)} on ${at(s)} is a distribution build (${clip(s.distro, 30)}): a distribution can backport a fix without changing the number, so it could not be compared with the affected versions ${c.rangeText}. Check the package changelog.`
          : `${label} ${clip(s.version)} on ${at(s)} could not be compared with the affected versions ${c.rangeText}.`,
    );
  for (const s of outside)
    lines.push(`${label} ${clip(s.version ?? "")} on ${at(s)} ${OUTSIDE} ${c.rangeText}.`);
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
  target?: Target,
  extra?: string,
): Omit<ComponentVerdict, "component" | "invisible"> {
  const hosts = readable(e);
  const why =
    unreadWhy(e) ??
    (target !== undefined
      ? hosts.map((h) => notRuledOut(h, target, what)).find((w) => w !== undefined)
      : undefined);
  if (why)
    return {
      verdict: "cannot-tell",
      evidence: [`${what} was not seen, and that cannot be relied on: ${why}.`],
    };
  return {
    verdict: "likely-not-affected",
    evidence: [
      `No ${what} seen on ${plural(hosts.length, "hostname")} (${names(hosts)})${extra ? `; ${extra}` : ""}.`,
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
    return done(seen.length > 0 ? judgeSeen(c, seen, "Next.js") : notSeen(e, "Next.js", "next"));
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
    const unread = hosts.reduce(
      (n, h) => n + h.scriptsUnread + h.scriptsUnidentified + h.scriptsCapped,
      0,
    );
    if (unread > 0)
      return done({
        verdict: "cannot-tell",
        evidence: [
          `${name} was not named by any script, but ${plural(unread, "script")} could not be read, ${unread === 1 ? "was" : "were"} past the limit of ${LIBRARY_SCRIPT_CAP} for one page, or ${unread === 1 ? "is a bundle" : "are bundles"} with no library name or version in ${unread === 1 ? "it" : "them"}, and a bundle can hold it.`,
        ],
      });
    return done(notSeen(e, `${name} in the scripts the pages name`));
  }
  if (c.kind === "php") {
    const seen: Seen[] = hosts.flatMap((h) =>
      h.php
        ? [
            {
              host: h,
              ...(h.php.version ? { version: h.php.version } : {}),
              how: h.php.how,
              ...(h.php.distro !== undefined ? { distro: h.php.distro } : {}),
            },
          ]
        : [],
    );
    return done(seen.length > 0 ? judgeSeen(c, seen, "PHP") : notSeen(e, "PHP", "php"));
  }
  if (c.kind === "composer") {
    const php = hosts.filter((h) => h.php);
    if (php.length === 0) return done(notSeen(e, "PHP", "php"));
    return done({
      verdict: "cannot-tell",
      evidence: [
        `PHP is in use on ${names(php)}, and which Composer packages it runs, at which versions, cannot be seen from outside, so ${name} could not be compared.`,
      ],
    });
  }
  if (c.kind === "wp-core" || c.kind === "wp-plugin" || c.kind === "wp-theme") {
    const wp = hosts.filter((h) => h.wordpress);
    if (wp.length === 0) return done(notSeen(e, "WordPress", "wordpress"));
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
    return done({
      verdict: "cannot-tell",
      evidence: [
        `WordPress is in use on ${names(wp)}, but no files of the ${kind} ${name} are on the page. A ${kind} can be installed ${c.kind === "wp-theme" ? "without being the active theme" : "or active without serving a file on this page"}.`,
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
  const ctx = context(e);
  const couldNotCheck: string[] = [...e.notes];
  const omittedLine =
    advisory.omitted !== undefined && advisory.omitted > 0
      ? `The advisory lists ${advisory.omitted} more packages than Gaugeline reads (at most 50), so they were not compared.`
      : undefined;
  if (omittedLine) couldNotCheck.push(omittedLine);
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
  // What decided comes first: a reader (and a note that keeps its first lines) must see it before the context.
  const lines: string[] = [];
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
    const hidden = components.filter((c) => c.invisible);
    if (components.some((c) => c.verdict === "likely-affected")) {
      verdict = "likely-affected";
      deciding = components.filter((c) => c.verdict === "likely-affected");
    } else if (
      components.some((c) => c.verdict === "cannot-tell") ||
      hidden.length > 0 ||
      omittedLine !== undefined
    ) {
      // A package only the repository or the server can show may be the affected one: no clean answer.
      verdict = "cannot-tell";
      deciding = components.filter((c) => c.verdict === "cannot-tell");
      if (omittedLine) lines.push(omittedLine);
    } else {
      verdict = "likely-not-affected";
      deciding = components;
    }
    for (const c of deciding) lines.push(...c.evidence);
    for (const c of components.filter((x) => x.invisible && !deciding.includes(x)))
      lines.push(...c.evidence);
  }
  lines.push(...ctx);
  const outside = deciding.find((c) => c.evidence.some((l) => l.includes(OUTSIDE)));
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

/** The words an evidence line carries when a version was seen and is not affected: the note quotes them. */
export const OUTSIDE = "is outside the affected versions";

const firstLine = (cs: readonly ComponentVerdict[]): string => cs[0]?.evidence[0] ?? "";
