import { CheckRegistry, defineCheck, type CheckContext, type Finding } from "../model.js";
import type { ItemRead, MigrationReading, PageFacts } from "../migration/read.js";
import { titleKept } from "../migration/titles.js";

/**
 * gaugeline migration: the old site's content list against the new site. Pure over a MigrationReading,
 * so the same reading always gives the same findings. The reading is what two sites said, so every
 * title, path and type in it is data: it is compared and printed as text, never acted on.
 */

const urlOf = (r: MigrationReading, i: ItemRead): string => `${r.newOrigin}${i.item.path}`;

const quoted = (text: string): string => {
  const one = text.replace(/\s+/g, " ").trim();
  return `"${one.length > 100 ? `${one.slice(0, 99)}...` : one}"`;
};

/** An address in a trail, as a path when it is on the new site. */
const shown = (r: MigrationReading, url: string): string => {
  try {
    const u = new URL(url);
    return u.origin === r.newOrigin
      ? `${u.pathname}${u.search}`
      : `${u.host}${u.pathname}${u.search}`;
  } catch {
    return url;
  }
};

const trailOf = (r: MigrationReading, trail: readonly string[]): string =>
  trail.map((u) => shown(r, u)).join(" -> ");

/** How the new site answered, in the three ways the checks care about. */
type Answer =
  | { kind: "page"; status: number; trail: string[]; facts: PageFacts }
  | { kind: "missing"; status: number; trail: string[] }
  | { kind: "loop"; trail: string[] }
  | { kind: "unread"; reason: string };

function answerOf(i: ItemRead): Answer {
  const now = i.now;
  if (now.kind === "unreachable") return { kind: "unread", reason: now.reason };
  if (now.kind === "loop") return { kind: "loop", trail: now.trail };
  if (now.status >= 200 && now.status < 300)
    return { kind: "page", status: now.status, trail: now.trail, facts: now.facts };
  if (now.status === 404 || now.status === 410)
    return { kind: "missing", status: now.status, trail: now.trail };
  return { kind: "unread", reason: `answered ${now.status}` };
}

/** How many pages the new site would not give (a 5xx, a refusal, a password, a timeout). */
export function unreadPages(r: MigrationReading): number {
  return r.items.filter((i) => answerOf(i).kind === "unread").length;
}

/** A page that could not be read leaves its checks undecided, never passed. */
function unread(ctx: CheckContext, r: MigrationReading, i: ItemRead, reason: string): void {
  ctx.couldNotCheck?.(urlOf(r, i), `the new site did not give the page (${reason})`);
}

/** The pages the comparisons can use: the new site gave a page. */
function pages(
  r: MigrationReading,
  ctx: CheckContext,
): { i: ItemRead; trail: string[]; facts: PageFacts }[] {
  const out: { i: ItemRead; trail: string[]; facts: PageFacts }[] = [];
  for (const i of r.items) {
    const a = answerOf(i);
    if (a.kind === "page") out.push({ i, trail: a.trail, facts: a.facts });
    else if (a.kind === "unread") unread(ctx, r, i, a.reason);
  }
  return out;
}

/** Why the old page is not there to compare with, in words that are the same for every such item. */
function noOldPage(r: MigrationReading, i: ItemRead): string {
  if (i.old !== undefined && "unreadable" in i.old)
    return `the old page was not readable (${i.old.unreadable})`;
  return r.oldPages === "same-site"
    ? "the old address is the new site's own, so there is no old page to read; give the old site's own address with --old"
    : "no --old address was given, so the old pages were not read (the list came from a file)";
}

const withoutSlash = (path: string): string => (path.length > 1 ? path.replace(/\/+$/u, "") : path);
const samePath = (a: string, b: string): boolean =>
  withoutSlash(a).toLowerCase() === withoutSlash(b).toLowerCase();

const MEDIUM = "medium" as const;

export const migrationPageMissing = defineCheck<MigrationReading>({
  id: "migration-page-missing",
  size: "M",
  done: "Every page the old site published answers on the new site, either at the same address or through one redirect to its new address.",
  estimateChanges:
    "A missing page is either content that was not moved (minutes in the CMS if it exists, longer if it has to be written again) or a redirect that was left out. The number of pages decides it.",
  area: "Launch day",
  severity: "high",
  title: "A page from the old site is missing on the new one",
  what: "An address the old site published answers 404 or 410 on the new site, after any redirects.",
  why: "Anyone with the old address (a search result, a link in an email, a bookmark, a printed menu's QR code) lands on an error page, and the page's ranking is lost with it.",
  fix: "Move the page's content to the new site, or add a permanent (301) redirect from the old address to the page that replaces it. Run it again to confirm.",
  tech: "Each path in the old site's content list (the WordPress REST API's published posts and pages, a Wix or Webflow export, or the old sitemap) is requested with GET on the new site, redirects followed. A final 404 or 410 is the finding; a 5xx, a refusal, a password or a timeout is could-not-check for that page.",
  run(r, ctx) {
    const out: Finding[] = [];
    for (const i of r.items) {
      const a = answerOf(i);
      if (a.kind === "unread") {
        unread(ctx, r, i, a.reason);
        continue;
      }
      if (a.kind !== "missing") continue;
      const moved = a.trail.length > 1;
      out.push({
        checkId: this.id,
        severity: this.severity,
        title: this.title,
        evidence: `${i.item.path}${i.item.title ? ` (${quoted(i.item.title)})` : ""} ${
          moved
            ? `redirects to ${trailOf(r, a.trail.slice(1))}, which answers ${a.status}`
            : `answers ${a.status}`
        } on the new site`,
        url: urlOf(r, i),
      });
    }
    return out;
  },
});

export const migrationRedirectChain = defineCheck<MigrationReading>({
  id: "migration-redirect-chain",
  size: "S",
  done: "Each old address that moved reaches its new address in a single redirect.",
  estimateChanges:
    "Usually one rule changed in the host's redirect settings. A chain made of a framework's trailing-slash rule plus a manual redirect needs the manual one pointed at the final address.",
  area: "Launch day",
  severity: MEDIUM,
  title: "An old address takes more than one redirect to reach its page",
  what: "An address from the old site reaches its page on the new site only after two or more redirects, or never settles because the redirects loop.",
  why: "Every extra redirect is another round trip for the visitor, and search engines pass less on through each one and may stop following a long chain.",
  fix: "Point the old address straight at the page's final address with a single 301, and make the slash, www and https rules agree with it.",
  tech: "The redirects of the GET to each path on the new site are counted from the fetcher's record of every hop. One redirect is accepted; two or more, or a loop, is the finding. A trail that ends in 404 is migration-page-missing instead.",
  run(r, ctx) {
    const out: Finding[] = [];
    for (const i of r.items) {
      const a = answerOf(i);
      if (a.kind === "unread") {
        unread(ctx, r, i, a.reason);
        continue;
      }
      if (a.kind === "loop") {
        out.push({
          checkId: this.id,
          severity: this.severity,
          title: this.title,
          evidence: `${i.item.path} redirects without ever settling: ${trailOf(r, a.trail)}`,
          url: urlOf(r, i),
        });
        continue;
      }
      if (a.kind !== "page" || a.trail.length - 1 < 2) continue;
      out.push({
        checkId: this.id,
        severity: this.severity,
        title: this.title,
        evidence: `${i.item.path} takes ${a.trail.length - 1} redirects: ${trailOf(r, a.trail)}`,
        url: urlOf(r, i),
      });
    }
    return out;
  },
});

export const migrationTitleChanged = defineCheck<MigrationReading>({
  id: "migration-title-changed",
  size: "S",
  done: "Each page that moved has the title it had, or a change you made on purpose.",
  estimateChanges:
    "One field per page in the CMS. A title built from a template that was mapped wrongly changes them all at once.",
  area: "Search & sharing",
  severity: MEDIUM,
  title: "A page's title changed in the move",
  what: "The title the old site gave a page (its name in the list, and the old page's <title>) does not match the new page's <title>, og:title or first heading.",
  why: "The title is what a search result shows. A title that changed by accident, because a CMS field was not mapped, can cost clicks and rankings the page had earned.",
  fix: "Put the old title back in the new page's title field, or leave the new one if you changed it on purpose.",
  tech: "Both titles are lower-cased with accents, punctuation and spacing removed; they match when equal or when one holds the other as whole words, so adding or dropping the site's name is not a change. The list's title is compared with the new <title>, og:title and first <h1>; the old page's <title> with the new <title> and og:title. With neither an old title nor an old page, the page is could-not-check.",
  run(r, ctx) {
    const out: Finding[] = [];
    for (const { i, facts } of pages(r, ctx)) {
      const page = i.old !== undefined && !("unreadable" in i.old) ? i.old.title : undefined;
      // WordPress names its front page "Home", whatever its <title> says: the old page's own <title> decides.
      const listed = i.item.path === "/" ? undefined : i.item.title;
      if (page === undefined && listed === undefined) {
        ctx.couldNotCheck?.(
          urlOf(r, i),
          "there is no old title to compare with: the list gives none and the old page was not read or has none",
        );
        continue;
      }
      if (
        titleKept(
          { ...(listed !== undefined ? { listed } : {}), ...(page !== undefined ? { page } : {}) },
          {
            ...(facts.title !== undefined ? { title: facts.title } : {}),
            ...(facts.og !== undefined ? { og: facts.og } : {}),
            ...(facts.h1 !== undefined ? { h1: facts.h1 } : {}),
          },
        )
      )
        continue;
      const now = facts.title ?? facts.og ?? facts.h1;
      out.push({
        checkId: this.id,
        severity: this.severity,
        title: this.title,
        evidence: `${i.item.path}: was ${quoted(page ?? listed ?? "")}, now ${now === undefined ? "no title" : quoted(now)}`,
        url: urlOf(r, i),
      });
    }
    return out;
  },
});

export const migrationCanonicalChanged = defineCheck<MigrationReading>({
  id: "migration-canonical-changed",
  size: "S",
  done: "Each page's canonical is the address it had, or the address the page now lives at.",
  estimateChanges:
    "One setting in the framework or the SEO plugin's replacement, then a rebuild. A canonical built from the wrong base address changes every page.",
  area: "Search & sharing",
  severity: MEDIUM,
  title: "A page's canonical address changed in the move",
  what: "The old page named an address as its canonical, and the new page names a different one (or none), and neither is the address the page now lives at.",
  why: "The canonical tells search engines which address to keep. One that points at the blog index, the home page or an address that redirects asks them to drop the page.",
  fix: "Make the new page's canonical the address it is served at. If it moved, that is its new address; the old address should redirect to it.",
  tech: "Paths are compared (the host is left out, since a preview and the live site differ), ignoring a trailing slash and case. The new canonical must equal the old canonical's path or the path the redirects ended on. Needs the old page: with --old, the old site's own address; a page with no old canonical is skipped.",
  run(r, ctx) {
    const out: Finding[] = [];
    for (const { i, trail, facts } of pages(r, ctx)) {
      if (i.old === undefined || "unreadable" in i.old) {
        ctx.couldNotCheck?.(urlOf(r, i), noOldPage(r, i));
        continue;
      }
      const before = i.old.canonical;
      if (before === undefined) continue;
      const last = trail.at(-1);
      const landed = last === undefined ? undefined : new URL(last).pathname;
      const now = facts.canonical;
      if (
        now !== undefined &&
        (samePath(now, before) || (landed !== undefined && samePath(now, landed)))
      )
        continue;
      out.push({
        checkId: this.id,
        severity: this.severity,
        title: this.title,
        evidence: `${i.item.path}: the canonical was ${before}, now ${now ?? "missing"}`,
        url: urlOf(r, i),
      });
    }
    return out;
  },
});

export const migrationSchemaTypeLost = defineCheck<MigrationReading>({
  id: "migration-schema-type-lost",
  size: "M",
  done: "Each page still carries the structured data types it had (Article, FAQPage, Event, Product and so on).",
  estimateChanges:
    "A type the new build never wrote means adding the JSON-LD to the page template and filling its fields from the CMS. One template covers every page of its kind.",
  area: "Search & sharing",
  severity: MEDIUM,
  title: "A page lost a structured data type in the move",
  what: "The old page had structured data of a type (Article, FAQPage, Event, Product, Recipe, LocalBusiness, BreadcrumbList) that the new page no longer has.",
  why: "Structured data is what earns a page its rich result in search: the FAQ dropdown, the event date, the star rating. Without it the page appears as a plain link.",
  fix: "Add the missing JSON-LD to the new page's template, filled from the page's own content, and test it with a rich results tester.",
  tech: "The @type of every JSON-LD node (an @graph read through) and every microdata itemtype, on the old and the new page. Types that describe the whole site (WebSite, WebPage, Organization, Person, ImageObject, SearchAction) are left out. A type the old page had and the new one lacks is the finding; a new type is not. Needs the old page: with --old, the old site's own address.",
  run(r, ctx) {
    const out: Finding[] = [];
    for (const { i, facts } of pages(r, ctx)) {
      if (i.old === undefined || "unreadable" in i.old) {
        ctx.couldNotCheck?.(urlOf(r, i), noOldPage(r, i));
        continue;
      }
      const lost = i.old.types.filter((t) => !facts.types.includes(t));
      if (lost.length === 0) continue;
      out.push({
        checkId: this.id,
        severity: this.severity,
        title: this.title,
        evidence: `${i.item.path}: ${lost.join(", ")} lost (was ${i.old.types.join(", ")}; now ${facts.types.length === 0 ? "none" : facts.types.join(", ")})`,
        url: urlOf(r, i),
      });
    }
    return out;
  },
});

export const MIGRATION_CHECKS = [
  migrationPageMissing,
  migrationRedirectChain,
  migrationTitleChanged,
  migrationCanonicalChanged,
  migrationSchemaTypeLost,
] as const;

/** The checks `gaugeline migration` runs. They are not in the page registry: they read two sites, not a page. */
export function createMigrationRegistry(): CheckRegistry {
  const registry = new CheckRegistry();
  for (const check of MIGRATION_CHECKS) registry.register(check);
  return registry;
}
