import {
  EMAIL_NETWORK_CHECKS,
  EMAIL_PAGE_CHECKS,
  createEmailRegistry,
  type EmailInput,
  type EmailPlaceholder,
} from "../checks/email-templates.js";
import { createPageRegistry } from "../checks/index.js";
import type { FactsConfig } from "../facts/types.js";
import type { Fetcher } from "../fetcher.js";
import type { LanguageGroup, LanguageRules, LanguageVersion } from "../languages.js";
import { BUDGET_KINDS, createBudget, sampleCounts, type BudgetSummary } from "../limits.js";
import { SEVERITY_ORDER, type CheckContext, type Finding } from "../model.js";
import { normaliseUrl } from "../normalise.js";
import type { PaymentsConfig } from "../payments/types.js";
import { lazyImageSample } from "../checks/images/refs.js";
import { lazyLinkSample } from "../links.js";
import { buildResult, type Result } from "../result.js";
import { runChecks, type RunResult } from "../run.js";
import { isSameSite } from "../sample.js";
import { buildSnapshot, type PageSnapshot } from "../snapshot.js";
import type { EmailsConfig } from "./config.js";
import { isUnsubscribeLink, parseEmail, type ParsedEmail } from "./parse.js";
import { findPlaceholders } from "./placeholders.js";
import { nameEmail, pairEmails } from "./pair.js";
import { readEmailFolder, type EmailSource } from "./read.js";

/** The address emails are read at when no site is named: nothing is ever requested from it. */
const NO_SITE = "https://emails.invalid";

/** Shown for every network check that did not run because no site was named. */
export const NO_BASE_REASON = "no --base, so the links and images were not requested";

export interface EmailsOptions {
  /** The folder (or one .html file) on disk. */
  dir: string;
  /** The folder as typed, put before each file so a line reads as a path from where the command ran. */
  prefix?: string;
  /** The site the emails link to. With it, that site's links and images are asked for (GET or HEAD); without it, nothing is. */
  base?: string;
  fetcher: Fetcher;
  config?: EmailsConfig;
  facts?: FactsConfig;
  payments?: PaymentsConfig;
  languageRules?: LanguageRules;
  now?: () => Date;
}

export interface EmailSummary {
  /** As shown: the folder as typed, then the path. */
  file: string;
  links: number;
  images: number;
  /** A .txt sits beside it. */
  text: boolean;
  lang?: string;
}

export interface EmailsRun {
  result: Result;
  emails: EmailSummary[];
  /** Every language the folder's emails are written in. */
  languages: string[];
  /** What was left out of the read, and links and images cut short, one sentence each. */
  notes: string[];
  /** Summed over the emails: how many links and images were found and how many were asked for. */
  budget: BudgetSummary;
  /** Links and images of the base site were requested. */
  requested: boolean;
  warnings: string[];
}

const absolute = (raw: string): string | undefined => {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : undefined;
  } catch {
    return undefined;
  }
};

/** An email as a page: the file's HTML, at an address that is its path, with only the links and images that are addresses. */
function emailSnapshot(
  url: string,
  site: string,
  source: EmailSource,
  parsed: ParsedEmail,
): PageSnapshot {
  const snap = buildSnapshot([
    {
      url,
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: source.html,
      ms: 0,
    },
  ]);
  // A relative link is resolved against the page's address by the reader, and would then look like a
  // link on the site. In an inbox it has no site, so only the addresses the email spells out are kept.
  const destinations = new Map<string, string>();
  for (const l of parsed.links) {
    const key = absolute(l.raw);
    if (key !== undefined) destinations.set(key, l.href);
  }
  const images = new Set(parsed.images.flatMap((i) => absolute(i.src) ?? []));
  return {
    ...snap,
    links: snap.links.flatMap((l) => {
      const dest = destinations.get(l.href);
      if (dest === undefined) return [];
      // Never asked for: a GET to an unsubscribe link can unsubscribe someone.
      if (isUnsubscribeLink(dest, l.text)) return [];
      return [{ ...l, href: dest, sameSite: isSameSite(dest, site) }];
    }),
    images: snap.images.filter((i) => images.has(i.src)),
  };
}

const sameAddress = (a: string, b: string): boolean => {
  try {
    return normaliseUrl(a) === normaliseUrl(b);
  } catch {
    return false;
  }
};

/**
 * The line of a finding that a page check made, found from what it says. A link or an image by its
 * address, a language by the html element, anything else by the first quoted value in the evidence
 * that the file contains as written. 0 when none is found: the finding is then about the whole email.
 */
function lineFor(f: Finding, source: string, parsed: ParsedEmail, own: string): number {
  if (f.checkId === "lang-price-mismatch") {
    const at = source.search(/ld\+json/i);
    if (at >= 0) return parsed.lineAt(at);
  }
  if (f.checkId.startsWith("lang-")) return parsed.htmlLine ?? 0;
  for (const l of [
    ...parsed.links.map((x) => ({ a: x.href, line: x.line })),
    ...parsed.images.map((x) => ({ a: x.src, line: x.line })),
  ])
    if (f.url !== own && sameAddress(l.a, f.url)) return l.line;
  const candidates = [...f.evidence.matchAll(/"([^"\n]{3,200})"/g)].map((m) => m[1] ?? "");
  for (const c of candidates) {
    let at = source.indexOf(c);
    if (at < 0) at = source.indexOf(c.replace(/&/g, "&amp;"));
    if (at >= 0) return parsed.lineAt(at);
  }
  return 0;
}

/** The email an untranslated-string finding is about ("Book again" on /appointment.es.html (es)), and the string. */
function twinOf(
  f: Finding,
  emails: readonly EmailSource[],
  addressOf: (file: string) => string,
): { file: string; html: string; text: string } | undefined {
  const m = /"([^"\n]+)" on (\S+) \(/.exec(f.evidence);
  if (!m) return undefined;
  const path = m[2] ?? "";
  const email = emails.find((e) => new URL(addressOf(e.file)).pathname === path);
  return email ? { file: email.file, html: email.html, text: m[1] ?? "" } : undefined;
}

/** The first line of the file that holds the text, ignoring case; 0 when it is not there as written. */
function lineOfText(html: string, text: string): number {
  const at = html.toLowerCase().indexOf(text.toLowerCase());
  return at < 0 ? 0 : html.slice(0, at).split("\n").length;
}

const sum = (a: BudgetSummary, b: BudgetSummary): BudgetSummary => {
  const out = {} as BudgetSummary;
  for (const kind of BUDGET_KINDS)
    out[kind] = {
      limit: a[kind].limit + b[kind].limit,
      sampled: a[kind].sampled + b[kind].sampled,
      found: a[kind].found + b[kind].found,
    };
  return out;
};

/**
 * Check the rendered emails in a folder. Each is read as text: the project exports them, Gaugeline
 * never renders or runs a template. Four email checks and the existing page checks for links,
 * images, payment details, facts and language parity run on each one; the language checks see the
 * email's twin files (order.en.html and order.es.html). Without `base` nothing is requested at all.
 */
export async function checkEmails(opts: EmailsOptions): Promise<EmailsRun> {
  const folder = readEmailFolder(opts.dir, opts.prefix ?? opts.dir);
  const base = opts.base === undefined ? undefined : new URL(opts.base);
  const origin = base?.origin ?? NO_SITE;
  const prefix = opts.prefix ?? "";
  const shown = (file: string): string => (prefix === "" ? file : `${prefix}/${file}`);
  const addressOf = (file: string): string =>
    `${origin}/${file.split("/").map(encodeURIComponent).join("/")}`;
  const tracking = opts.config?.tracking ?? [];
  const now = opts.now ?? (() => new Date());

  const parsed = new Map<string, ParsedEmail>();
  const snapshots = new Map<string, PageSnapshot>();
  for (const e of folder.emails) {
    const p = parseEmail(e.html, tracking);
    parsed.set(e.file, p);
    snapshots.set(e.file, emailSnapshot(addressOf(e.file), origin, e, p));
  }
  const pairs = pairEmails(folder.emails.map((e) => e.file));

  const ownRegistry = createEmailRegistry();
  const pageRegistry = createPageRegistry();
  const network = base !== undefined;
  const pageOnly = EMAIL_PAGE_CHECKS.filter((id) => network || !EMAIL_NETWORK_CHECKS.includes(id));

  const defaultLang = opts.languageRules?.default?.toLowerCase();
  const findings: { f: Finding; email: number }[] = [];
  const ranClean = new Set<string>();
  const notClean = new Set<string>();
  const failed = new Map<string, string>();
  const couldNot: Result["couldNotCheck"] = [];
  const warnings: string[] = [];
  const notes = [...folder.notes];
  let budget: BudgetSummary | undefined;
  const summaries: EmailSummary[] = [];

  const tally = (
    run: RunResult,
    email: number,
    file: string,
    source: string,
    p: ParsedEmail,
  ): void => {
    for (const id of run.passed) ranClean.add(id);
    for (const f of run.findings) {
      notClean.add(f.checkId);
      // The email checks name their own line; a page check's line is found from what it says.
      if (f.source) {
        findings.push({ f, email });
        continue;
      }
      // An untranslated string is fixed in the other language's file: that is where the finding points.
      const twin =
        f.checkId === "lang-untranslated" ? twinOf(f, folder.emails, addressOf) : undefined;
      const where = twin?.file ?? file;
      const line = twin ? lineOfText(twin.html, twin.text) : lineFor(f, source, p, addressOf(file));
      findings.push({
        f: {
          ...f,
          evidence: `${line > 0 ? `${shown(where)}:${line}` : shown(where)} ${f.evidence}`,
          url: f.url === addressOf(file) ? shown(where) : f.url,
          source: { file: shown(where), line },
        },
        email,
      });
    }
    for (const x of run.failed) {
      notClean.add(x.id);
      failed.set(x.id, x.error);
    }
    for (const c of run.couldNotCheck) {
      notClean.add(c.id);
      couldNot.push(c);
    }
    warnings.push(...run.warnings);
  };

  for (const [index, email] of folder.emails.entries()) {
    const p = parsed.get(email.file) as ParsedEmail;
    const snapshot = snapshots.get(email.file) as PageSnapshot;
    const named = nameEmail(email.file);
    const placeholders: EmailPlaceholder[] = [
      ...findPlaceholders(p.masked).map((m) => ({
        rule: m.rule,
        label: m.label,
        text: m.text,
        file: shown(email.file),
        line: p.lineAt(m.index),
      })),
    ];
    if (email.text) {
      const lines = email.text.body.split("\n");
      const starts: number[] = [];
      let at = 0;
      for (const l of lines) {
        starts.push(at);
        at += l.length + 1;
      }
      for (const m of findPlaceholders(email.text.body)) {
        let line = starts.findIndex((s) => s > m.index);
        line = line === -1 ? starts.length : line;
        placeholders.push({
          rule: m.rule,
          label: m.label,
          text: m.text,
          file: shown(email.text.file),
          line,
        });
      }
    }
    const input: EmailInput = {
      file: shown(email.file),
      links: p.links,
      images: p.images,
      placeholders,
      hasTextPart: email.text !== undefined,
      textExpected: opts.config?.textVersion === true,
    };
    summaries.push({
      file: input.file,
      links: p.links.length,
      images: p.images.length,
      text: input.hasTextPart,
      ...(named.lang ? { lang: named.lang } : {}),
    });
    tally(await runChecks(input, ownRegistry, {}), index, email.file, email.html, p);

    // The language checks look at an email and all its twins, so they run once for each set of twins, on its
    // primary email (the default language, else the first in name order). The untranslated strings are in the
    // default language, so they are looked for on the other versions of an email written in it.
    const group = pairs.groups.get(named.base);
    const primary =
      named.lang === undefined
        ? undefined
        : defaultLang !== undefined && group?.has(defaultLang)
          ? group.get(defaultLang)
          : [...(group?.entries() ?? [])].sort((a, b) => (a[0] < b[0] ? -1 : 1))[0]?.[1];
    const only = pageOnly.filter((id) => {
      if (!id.startsWith("lang-")) return true;
      if (primary !== email.file) return false;
      return id !== "lang-untranslated" || named.lang === defaultLang;
    });
    // The page checks: the email as a page, with its twins as its language versions.
    const own = createBudget();
    const ctx: Partial<CheckContext> = {
      now,
      pages: () => Promise.resolve([snapshot]),
      ...(opts.facts ? { facts: opts.facts } : {}),
      ...(opts.payments ? { payments: opts.payments } : {}),
      ...(opts.languageRules ? { languageRules: opts.languageRules } : {}),
      ...(network
        ? {
            fetcher: opts.fetcher,
            budget: own,
            links: lazyLinkSample({ page: snapshot, fetcher: opts.fetcher, budget: own }),
            images: lazyImageSample({ page: snapshot, fetcher: opts.fetcher, budget: own }),
          }
        : {}),
    };
    if (named.lang !== undefined) {
      const versions: LanguageVersion[] = pairs.languages
        .filter((l) => l !== named.lang)
        .map((lang): LanguageVersion => {
          const twin = group?.get(lang);
          const twinPage = twin === undefined ? undefined : snapshots.get(twin);
          if (twin === undefined || twinPage === undefined)
            return {
              lang,
              url: addressOf(`${named.base}.${lang}.html`),
              hops: [],
              missing: "is not in the folder",
            };
          return { lang, url: addressOf(twin), hops: [], page: twinPage };
        });
      const urls = new Map<string, string>([[named.lang, addressOf(email.file)]]);
      for (const v of versions) urls.set(v.lang, v.url);
      const languages: LanguageGroup = { lang: named.lang, urls, versions };
      ctx.languages = () => Promise.resolve(languages);
    }
    tally(await runChecks(snapshot, pageRegistry, { only, ctx }), index, email.file, email.html, p);
    const summary = own.summary();
    budget = budget === undefined ? summary : sum(budget, summary);
    for (const [kind, noun] of [
      ["links", "links"],
      ["images", "images"],
    ] as const) {
      const t = summary[kind];
      if (t.found > t.sampled)
        notes.push(`${shown(email.file)}: ${t.sampled} of ${t.found} ${noun} checked.`);
    }
  }

  if (!network)
    for (const id of EMAIL_NETWORK_CHECKS) {
      notClean.add(id);
      couldNot.push({ id, reason: NO_BASE_REASON, url: prefix === "" ? opts.dir : prefix });
    }

  if ((opts.languageRules?.untranslated?.length ?? 0) > 0 && defaultLang === undefined) {
    notClean.add("lang-untranslated");
    couldNot.push({
      id: "lang-untranslated",
      reason:
        'gaugeline.languages.json lists strings but no "default" language to look for them in',
      url: prefix === "" ? opts.dir : prefix,
    });
  }
  const order = [
    ...createEmailRegistry().all(),
    ...pageOnly.flatMap((id) => pageRegistry.get(id) ?? []),
  ];
  const rank = new Map(order.map((c, i) => [c.id, i] as const));
  findings.sort(
    (a, b) =>
      SEVERITY_ORDER[a.f.severity] - SEVERITY_ORDER[b.f.severity] ||
      a.email - b.email ||
      (a.f.source?.line ?? 0) - (b.f.source?.line ?? 0) ||
      (rank.get(a.f.checkId) ?? 0) - (rank.get(b.f.checkId) ?? 0),
  );
  // The language checks compare language versions: with none in the folder they compared nothing.
  const passed = order
    .map((c) => c.id)
    .filter(
      (id) =>
        ranClean.has(id) &&
        !notClean.has(id) &&
        !(pairs.languages.length === 0 && id.startsWith("lang-")),
    );
  const finalBudget = budget ?? createBudget().summary();
  const result = buildResult({
    url: prefix === "" ? opts.dir : prefix,
    startedAt: now(),
    findings: findings.map((x) => x.f),
    passed,
    failed: [...failed.keys()],
    couldNotCheck: couldNot,
    sampled: sampleCounts(finalBudget),
  });
  return {
    result,
    emails: summaries,
    languages: pairs.languages,
    notes,
    budget: finalBudget,
    requested: network,
    warnings,
  };
}
