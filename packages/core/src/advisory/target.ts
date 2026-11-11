import { ConfigError } from "../errors.js";
import { describeRange, parseRange, type Family, type RangeSet } from "./range.js";

/** What an advisory's package is, as far as it can be seen from outside. */
export type Kind = "npm" | "composer" | "wp-core" | "wp-plugin" | "wp-theme" | "php" | "other";

/** One package an advisory names, with the versions it affects. */
export interface Component {
  kind: Kind;
  /** The package name: next, laravel/framework, a plugin's slug. */
  name: string;
  /** The ecosystem as a person says it: npm, Packagist, WordPress plugin, PyPI. */
  label: string;
  /** How its versions compare. Absent for a package Gaugeline cannot see from outside. */
  family?: Family;
  /** The affected versions. Absent when the advisory gives none Gaugeline can read (`unreadable` says why). */
  set?: RangeSet;
  /** `set` as words: ">=15.0.0 <15.2.3". */
  rangeText: string;
  unreadable?: string;
}

/** An advisory as the check reads it: from OSV, or built from a package and range the person typed. */
export interface Advisory {
  /** CVE-..., GHSA-..., or the package and range as typed. */
  id: string;
  aliases: string[];
  summary?: string;
  /** The date OSV marks the advisory withdrawn, when it does. */
  withdrawn?: string;
  source: "osv" | "given";
  components: Component[];
  /** Packages the advisory lists that were not read because of the cap on one advisory. */
  omitted?: number;
}

const CVE = /^CVE-\d{4}-\d{4,7}$/i;
const GHSA = /^GHSA(?:-[a-z0-9]{4}){3}$/i;
/** OSV's own and other databases' ids: an upper-case prefix, a dash, then letters, digits, dots and dashes. */
const OTHER_ID = /^[A-Z][A-Z0-9]{1,9}-[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/;

/** True for CVE-2026-1234, GHSA-xxxx-xxxx-xxxx, PYSEC-2024-17 and the like; false for a package name. */
export function isAdvisoryId(text: string): boolean {
  return CVE.test(text) || GHSA.test(text) || OTHER_ID.test(text);
}

/** The id as OSV writes it: CVE upper case, GHSA prefix upper case and the rest lower case. */
export function normaliseId(text: string): string {
  if (CVE.test(text)) return text.toUpperCase();
  if (GHSA.test(text)) return `GHSA-${text.slice(5).toLowerCase()}`;
  return text;
}

const WP_CORE = new Set([
  "wordpress",
  "wordpress-core",
  "wp",
  "johnpbloch/wordpress",
  "johnpbloch/wordpress-core",
  "roots/wordpress",
  "wordpress/wordpress",
]);

const LABEL: Record<Kind, string> = {
  npm: "npm",
  composer: "Packagist",
  "wp-core": "WordPress",
  "wp-plugin": "WordPress plugin",
  "wp-theme": "WordPress theme",
  php: "PHP",
  other: "",
};

export const familyOf = (kind: Kind): Family | undefined =>
  kind === "npm"
    ? "npm"
    : kind === "composer" || kind === "php"
      ? "composer"
      : kind === "other"
        ? undefined
        : "wordpress";

/**
 * What an OSV package is, from its ecosystem and name. npm is npm; Packagist is composer, except that
 * wpackagist-plugin/ and wpackagist-theme/ are WordPress plugins and themes and the WordPress core packages
 * are core. Any ecosystem Gaugeline cannot see from outside (PyPI, Go, Maven...) is "other".
 */
export function classify(
  ecosystem: string,
  name: string,
): { kind: Kind; name: string; label: string } {
  const eco = ecosystem.toLowerCase();
  const n = name.toLowerCase();
  const make = (kind: Kind, shown: string, label = LABEL[kind]) => ({ kind, name: shown, label });
  if (eco === "npm") return make("npm", n);
  if (eco === "packagist") {
    const plugin = /^wpackagist-plugin\/(.+)$/.exec(n)?.[1];
    if (plugin) return make("wp-plugin", plugin);
    const theme = /^wpackagist-theme\/(.+)$/.exec(n)?.[1];
    if (theme) return make("wp-theme", theme);
    if (WP_CORE.has(n)) return make("wp-core", n);
    if (n === "php") return make("php", n);
    return make("composer", n, ecosystem);
  }
  if (eco === "wordpress") return make(WP_CORE.has(n) ? "wp-core" : "wp-plugin", n);
  return make("other", n, ecosystem.slice(0, 40));
}

const NAME = /^@?[a-z0-9][a-z0-9._-]{0,80}(?:\/[a-z0-9][a-z0-9._-]{0,80})?$/;
const PREFIX = /^(npm|composer|packagist|wp-plugin|wp-theme):(.*)$/i;

/**
 * A package and the versions it affects, as typed: `next@>=15.0.0 <15.2.3`. The name alone is npm (or composer
 * with a vendor/, or PHP, or WordPress core); `composer:`, `wp-plugin:` and `wp-theme:` say what a name is.
 * A range is required, and must be one: Gaugeline does not guess which versions are affected.
 */
export function parseSpec(text: string): Component[] {
  const given = text.trim();
  const prefix = PREFIX.exec(given);
  const rest = (prefix ? (prefix[2] ?? "") : given).trim();
  const at = rest.indexOf("@", 1);
  const hint =
    "Write it as package@range, for example next@>=15.0.0 <15.2.3 or wp-plugin:easy-booking@<2.4.0.";
  if (at === -1)
    throw new ConfigError(`"${clip(given)}" needs a range of affected versions after an @.`, {
      hint,
    });
  const name = rest.slice(0, at).trim().toLowerCase();
  const range = rest.slice(at + 1).trim();
  if (!NAME.test(name))
    throw new ConfigError(`"${clip(name)}" is not a package name Gaugeline can look for.`, {
      hint: "A package name is lower case letters, digits, dots, dashes and one slash, such as next or laravel/framework.",
    });
  const given0 = prefix?.[1]?.toLowerCase();
  const kind: Kind =
    given0 === "wp-plugin"
      ? "wp-plugin"
      : given0 === "wp-theme"
        ? "wp-theme"
        : given0 === "npm"
          ? "npm"
          : WP_CORE.has(name)
            ? "wp-core"
            : name === "php"
              ? "php"
              : given0 === "composer" ||
                  given0 === "packagist" ||
                  (name.includes("/") && !name.startsWith("@"))
                ? "composer"
                : "npm";
  const family = familyOf(kind) ?? "npm";
  const set = parseRange(family, range);
  if (!set)
    throw new ConfigError(`"${clip(range)}" is not a version range Gaugeline can read.`, { hint });
  return [{ kind, name, label: LABEL[kind], family, set, rangeText: describeRange(set) }];
}

const clip = (s: string): string => (s.length > 80 ? `${s.slice(0, 80)}...` : s);
