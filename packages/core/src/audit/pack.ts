import { escapeInvisible } from "../checks/hidden-text/escape.js";
import { maskEmail } from "../handoff/people.js";
import { AREAS, type Area, type CheckRegistry, type Severity } from "../model.js";
import { minorExponent } from "../products/money.js";
import { redact } from "../redact.js";
import { buildBrief } from "../report/brief.js";
import type { Brief } from "../report/brief-schema.js";
import type { Result } from "../result.js";
import { safeLogoUrl, type Brand, type Service, type ServicesConfig } from "./config.js";

/**
 * The audit pack (F-04) as data: what `buildAuditPack` returns and the two renderers read. It is made
 * from the work order's own `Brief` (G28a), so the plain wording of a finding (what is wrong, why it
 * matters, what done looks like) is the one the work order and the digest use, and never written twice.
 * Pure and made by templates: no model, no clock, no request, no file. The same input gives the same
 * pack. Prices and hours are only ever those written in the freelancer's services file.
 */

/** A finding as the pack shows it: one check, with the places to look. */
export interface PackFinding {
  checkId: string;
  title: string;
  severity: Severity;
  area: Area;
  /** What is wrong, then why it matters, then what done looks like: the check's own sentences. Empty for a finding with no check. */
  wrong: string;
  why: string;
  done: string;
  /** The first places to look, with e-mail addresses masked and anything key-shaped redacted. */
  evidence: string[];
  /** How many more places there were than `evidence` shows. */
  moreEvidence: number;
}

/** A range of whole numbers. Money is in minor units (cents), so a total never drifts. */
export interface PackRange {
  low: number;
  high: number;
}

export interface PackGroup {
  /** A package of the freelancer's, an area (no services file), or the findings no package covers. */
  kind: "package" | "area" | "other";
  name: string;
  items: PackFinding[];
  /** The package's price, in minor units. Only from the services file. */
  price?: PackRange;
  /** The package's hours. Only from the services file. */
  hours?: PackRange;
  /** What the package leaves out, as the freelancer wrote it. */
  notIncluded: string[];
  /** How the fix would be confirmed: the re-run. Empty for areas and for other findings. */
  recheck: string;
}

export interface PackTotals {
  price?: PackRange;
  hours?: PackRange;
  /** Packages left out of the price total because they have no price (hours only), and likewise for hours. */
  withoutPrice: string[];
  withoutHours: string[];
}

export interface AuditPack {
  /** The prospect's business, as given. Absent: the pages name the host. */
  business?: string;
  url: string;
  host: string;
  checkedAt: string;
  brand?: Brand;
  /** ISO 4217, lower case. */
  currency: string;
  /** Things worth fixing: the checks that found something, and findings with no check in this version. */
  total: number;
  /** Counts of the checks that found something, by level. */
  levels: Record<Severity, number>;
  /** How many checks could not read part of the site. */
  couldNotCheck: number;
  /** The five to start with, most urgent first. */
  top: PackFinding[];
  groups: PackGroup[];
  totals?: PackTotals;
  /** The site's owner agreed to the probing checks, so they ran. */
  probing: boolean;
  /** The mail records were read (--dns). */
  dns: boolean;
  /** True when nothing needed fixing. */
  healthy: boolean;
}

export interface PackOptions {
  /** The prospect's business, shown in the heading. */
  business?: string;
  /** The freelancer's packages, prices and brand. Without packages the pack groups by area and shows no estimate. */
  services?: ServicesConfig;
  /** Name, logo and contact line from the command line: they replace what the file says, field by field. */
  brand?: Brand;
  /** The probing checks ran (--owner-consent, or gaugeline.consent.json). */
  probing?: boolean;
  /** The mail records were read (--dns). */
  dns?: boolean;
}

/** How many findings the summary leads with, and how many places to look each finding lists. */
export const TOP = 5;
export const EVIDENCE_LINES = 3;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/gu;

/** Text from a page for a document that may be sent to someone else: key-shaped text redacted, full e-mail addresses masked. */
export function forProspect(text: string): string {
  return redact(text).replace(EMAIL, (m) => maskEmail(m));
}

/** Text someone typed (a name, a contact line): invisible characters shown as escapes, then as `forProspect`. */
const typed = (text: string): string => forProspect(escapeInvisible(text, 300));

function covers(service: Service, item: PackFinding): boolean {
  return (
    (service.covers.checks ?? []).includes(item.checkId) ||
    (service.covers.areas ?? []).includes(item.area)
  );
}

/** "A", "A and B", "A, B and C", and with more than six, the first five and a count. */
export function joinNames(names: readonly string[]): string {
  const shown = names.length > 6 ? names.slice(0, 5) : names;
  const rest = names.length - shown.length;
  const quoted = shown.map((n) => `\u201C${n}\u201D`);
  if (rest > 0) return `${quoted.join(", ")} and ${rest} more`;
  if (quoted.length <= 1) return quoted.join("");
  return `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1] ?? ""}`;
}

/** The re-run that confirms a package's work: the same command, and what should be gone from it. */
function recheck(host: string, items: readonly PackFinding[]): string {
  const titles = items.map((i) => i.title);
  return `We run Gaugeline again on ${host} (npx gaugeline ${host}) and confirm that ${joinNames(titles)} ${titles.length === 1 ? "is" : "are"} no longer reported.`;
}

function sum(ranges: readonly PackRange[]): PackRange {
  return {
    low: ranges.reduce((s, r) => s + r.low, 0),
    high: ranges.reduce((s, r) => s + r.high, 0),
  };
}

function findingOf(item: Brief["items"][number], area: Area): PackFinding {
  const places = item.evidence.map(forProspect).filter((l) => l !== "");
  return {
    checkId: item.checkId,
    title: forProspect(item.title),
    severity: item.severity,
    area,
    wrong: item.wrong,
    why: item.why,
    done: item.done,
    evidence: places.slice(0, EVIDENCE_LINES),
    moreEvidence: Math.max(0, places.length - EVIDENCE_LINES),
  };
}

/** Findings from a check this version does not have: shown with their places to look and nothing else. */
function unsized(group: Brief["notSized"][number]): PackFinding {
  const places = group.evidence.map(forProspect).filter((l) => l !== "");
  return {
    checkId: forProspect(group.checkId),
    title: forProspect(group.title),
    severity: "low",
    area: "Launch day",
    wrong: "",
    why: "",
    done: "",
    evidence: places.slice(0, EVIDENCE_LINES),
    moreEvidence: Math.max(0, places.length - EVIDENCE_LINES),
  };
}

/**
 * The audit pack as data. It reuses `buildBrief` for the findings, then groups them: into the
 * freelancer's packages when a services file names some (a finding goes to the first package that
 * covers it, so no finding is counted twice, and a package with nothing to fix on this site is left
 * out), or into the six areas when it does not. Findings no package covers go under "Other findings",
 * with no price. The totals are the sums of the packages' own ranges.
 *
 * It takes a finished result and never runs a check.
 */
export function buildAuditPack(
  result: Result,
  registry: CheckRegistry,
  opts: PackOptions = {},
): AuditPack {
  const brief = buildBrief(
    result,
    registry,
    opts.business !== undefined ? { business: opts.business } : {},
  );
  const config = opts.services;
  const services = config?.services ?? [];
  const currency = (config?.currency ?? "usd").toLowerCase();
  const factor = 10 ** minorExponent(currency);

  const items: PackFinding[] = brief.items.flatMap((item) => {
    const area = registry.get(item.checkId)?.area;
    return area === undefined ? [] : [findingOf(item, area)];
  });
  const levels: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
  for (const i of items) levels[i.severity] += 1;

  const groups: PackGroup[] = [];
  const taken = new Set<string>();
  if (services.length > 0) {
    for (const service of services) {
      const mine = items.filter((i) => !taken.has(i.checkId) && covers(service, i));
      if (mine.length === 0) continue;
      for (const i of mine) taken.add(i.checkId);
      groups.push({
        kind: "package",
        name: typed(service.name),
        items: mine,
        ...(service.price
          ? { price: { low: service.price.from * factor, high: service.price.to * factor } }
          : {}),
        ...(service.hours ? { hours: { low: service.hours.from, high: service.hours.to } } : {}),
        notIncluded: (service.notIncluded ?? []).map(typed),
        recheck: recheck(brief.host, mine),
      });
    }
  } else {
    for (const area of AREAS) {
      const mine = items.filter((i) => i.area === area);
      if (mine.length > 0)
        groups.push({ kind: "area", name: area, items: mine, notIncluded: [], recheck: "" });
    }
  }
  const other = [
    ...items.filter((i) => !taken.has(i.checkId) && services.length > 0),
    ...brief.notSized.map(unsized),
  ];
  if (other.length > 0)
    groups.push({
      kind: "other",
      name: "Other findings",
      items: other,
      notIncluded: [],
      recheck: "",
    });

  const packages = groups.filter((g) => g.kind === "package");
  const priced = packages.flatMap((g) => (g.price ? [g.price] : []));
  const timed = packages.flatMap((g) => (g.hours ? [g.hours] : []));
  const totals: PackTotals | undefined =
    priced.length + timed.length === 0
      ? undefined
      : {
          ...(priced.length > 0 ? { price: sum(priced) } : {}),
          ...(timed.length > 0 ? { hours: sum(timed) } : {}),
          withoutPrice:
            priced.length > 0 ? packages.filter((g) => !g.price).map((g) => g.name) : [],
          withoutHours: timed.length > 0 ? packages.filter((g) => !g.hours).map((g) => g.name) : [],
        };

  const brand: Brand = { ...config?.brand, ...opts.brand };
  const logoUrl = brand.logoUrl === undefined ? undefined : safeLogoUrl(brand.logoUrl);
  const shownBrand: Brand = {
    ...(brand.name !== undefined ? { name: typed(brand.name) } : {}),
    ...(logoUrl !== undefined ? { logoUrl } : {}),
    ...(brand.contact !== undefined ? { contact: typed(brand.contact) } : {}),
  };

  const total = items.length + brief.notSized.length;
  return {
    ...(brief.business !== undefined ? { business: typed(brief.business) } : {}),
    url: brief.url,
    host: brief.host,
    checkedAt: brief.checkedAt,
    ...(Object.keys(shownBrand).length > 0 ? { brand: shownBrand } : {}),
    currency,
    total,
    levels,
    couldNotCheck: brief.couldNotCheck,
    // The work order's order already: most severe first, then the smallest fix first.
    top: items.slice(0, TOP),
    groups,
    ...(totals ? { totals } : {}),
    probing: opts.probing === true,
    dns: opts.dns === true,
    healthy: total === 0,
  };
}
