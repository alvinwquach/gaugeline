import { defineCheck, type CheckContext, type Finding } from "../model.js";
import { diffBaselines, type BaselineCheckId } from "../script-baseline/diff.js";
import { buildBaseline, readBaseline, thirdPartyKey } from "../script-baseline/inventory.js";
import { knownBadHost } from "../script-baseline/known-bad.js";
import type { PageSnapshot } from "../snapshot.js";
import { isHtmlPage } from "./page.js";

/** The most findings one check gives for one page. */
const MAX = 20;

export const scriptKnownBadHost = defineCheck<PageSnapshot>({
  id: "script-known-bad-host",
  size: "S",
  done: "The page loads no script from that host, and the script it replaced works.",
  estimateChanges:
    "The same address in the theme, a plugin and a tag manager is three edits. A library that needs the script may need a replacement.",
  area: "Security & email",
  severity: "high",
  title: "A script comes from a host on the known-bad list",
  what: "The page loads a script from a host that a published report says served injected or malicious code.",
  why: "A script runs with the page's full access, including a checkout form. Whoever controls the host controls what it does to your visitors.",
  fix: "Remove the script tag, or point it at a copy you host or at a service you trust. Then ask whoever added it why it was there.",
  tech: "a script src whose host, or a parent domain of it, is in data/known-bad-script-hosts.json. The list names its source for every host. Nothing is requested: the address is read from the page",
  run(page) {
    if (!isHtmlPage(page)) return [];
    const seen = new Set<string>();
    const out: Finding[] = [];
    for (const src of page.scripts) {
      let host: string;
      let where: string;
      try {
        const u = new URL(src);
        host = u.hostname;
        where = `${u.host}${u.pathname}`.slice(0, 200);
      } catch {
        continue;
      }
      const bad = knownBadHost(host);
      if (bad === undefined || seen.has(where)) continue;
      seen.add(where);
      out.push({
        checkId: "script-known-bad-host",
        severity: "high",
        title: this.title,
        evidence: `${where}: ${bad.host} is on the list of hosts to avoid since ${bad.since}. ${bad.note} Source: ${bad.source.title} (${bad.source.url})${bad.proposed ? ". This entry has not been confirmed by a maintainer" : ""}`,
        url: page.finalUrl,
      });
    }
    return out.slice(0, MAX);
  },
});

/**
 * The changes of one kind since the last run. Without --since last there is nothing to compare, like
 * the other change checks; with it, a first run (or a snapshot saved before this was) is could not
 * check, never a pass.
 */
function changes(page: PageSnapshot, ctx: CheckContext, id: BaselineCheckId, title: string) {
  const saved = ctx.previous?.baseline;
  const before = saved === undefined ? undefined : readBaseline(saved);
  if (before === undefined) {
    if (ctx.baselineRequested)
      ctx.couldNotCheck?.(
        page.finalUrl,
        saved !== undefined
          ? "the last run's saved scripts and headers could not be read: this run saves new ones"
          : ctx.previous
            ? "the last run's snapshot has no saved scripts and headers: this run saves them"
            : "no saved scripts and headers to compare with yet: this run saves them",
      );
    return [];
  }
  if (!isHtmlPage(page)) return [];
  return diffBaselines(before, buildBaseline(page))
    .filter((c) => c.checkId === id)
    .slice(0, MAX)
    .map((c): Finding => ({
      checkId: id,
      severity: c.severity,
      title,
      evidence: c.evidence,
      url: page.finalUrl,
    }));
}

export const scriptChanged = defineCheck<PageSnapshot>({
  id: "script-changed",
  size: "S",
  done: "Each script that appeared since the last run is one you or the client added on purpose, and a script that lost its integrity attribute has it back.",
  estimateChanges:
    "Finding out who added a script is the unknown. A tag manager can load many scripts that this page's code never names.",
  area: "Security & email",
  severity: "medium",
  title: "A third-party script is new, or lost its integrity attribute",
  what: "Against the last run saved with --since last, the page loads a third-party script it did not load before, or one that had an integrity attribute no longer has it.",
  why: "Any script on a checkout page can read what customers type. Knowing exactly which ones load, and noticing a new one, is what PCI DSS 11.6.1 asks of a payment page.",
  fix: "Confirm the script was added on purpose and by whom. Remove it if not. For one you keep, add its integrity attribute so a changed file stops loading.",
  tech: "With --since last only. Third-party means a host outside the page's registrable domain. A script is its host and path with no query string; the integrity attribute is present or not. Scripts that went away are not reported. On a first run: could not check",
  run(page, ctx) {
    return changes(page, ctx, "script-changed", this.title);
  },
});

export const cspLoosened = defineCheck<PageSnapshot>({
  id: "csp-loosened",
  size: "M",
  done: "The policy allows what it did before, or the change was meant and the policy is saved as the new baseline.",
  estimateChanges:
    "Tightening a policy again takes testing on every page that loads something new. A tag manager or a payment widget often needs the looser setting.",
  area: "Security & email",
  severity: "high",
  title: "The Content-Security-Policy allows more than it did",
  what: "Against the last run saved with --since last, the Content-Security-Policy header is gone, a directive is gone, or a directive lists a source it did not before (for example 'unsafe-inline').",
  why: "The policy decides which scripts and frames the browser will run. A looser one lets more code in, and a deploy can loosen it without anyone deciding to.",
  fix: "Find the deploy or the setting that changed it. If the change was meant, keep it; if not, restore the line. A new source is better as a nonce or a host than as 'unsafe-inline'.",
  tech: "With --since last only. The header of the page's final response, split into directives. A source added, a directive removed or the header removed is reported; a source removed or a directive added is not. Nonces and hashes are one word, so a new nonce per request is not a change. A risky source ('unsafe-inline', 'unsafe-eval', *, data:, https:) added to default-src or a script directive is high. Meta-tag policies and Content-Security-Policy-Report-Only are not read. On a first run: could not check",
  run(page, ctx) {
    return changes(page, ctx, "csp-loosened", this.title);
  },
});

export const securityHeaderLoosened = defineCheck<PageSnapshot>({
  id: "security-header-loosened",
  size: "S",
  done: "The header is sent as it was, or the change was meant.",
  estimateChanges:
    "Usually one line in the host's or the framework's header settings. A CDN or proxy change can drop several at once.",
  area: "Security & email",
  severity: "medium",
  title: "A security header sends less protection than before",
  what: "Against the last run saved with --since last, one of these headers is gone or weaker: Strict-Transport-Security, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy, Cross-Origin-Opener-Policy, Cross-Origin-Embedder-Policy, Cross-Origin-Resource-Policy.",
  why: "These headers switch browser protections on. They vanish when a host, a CDN or a framework setting changes, and the site looks the same.",
  fix: "Find what changed in the hosting or header settings and put the header back, or confirm the change was meant.",
  tech: "With --since last only. The final response's headers. Reported: a header gone; Strict-Transport-Security with a smaller max-age or without includeSubDomains or preload; X-Content-Type-Options no longer nosniff; X-Frame-Options, Referrer-Policy and the Cross-Origin policies with a less strict value; a Permissions-Policy feature removed or given a new origin. On a first run: could not check",
  run(page, ctx) {
    return changes(page, ctx, "security-header-loosened", this.title);
  },
});

export const SCRIPT_BASELINE_CHECKS = [
  scriptKnownBadHost,
  scriptChanged,
  cspLoosened,
  securityHeaderLoosened,
] as const;

export { thirdPartyKey };
