import { defineCheck, type Finding } from "../../model.js";
import type { LocalSourceInput } from "../../local-source/run.js";
import {
  envReads,
  lineOf,
  matching,
  notReadReason,
  scrub,
  sortFindings,
  sourcePathsOf,
} from "./scan.js";

/**
 * FF-05. The setting that turns indexing on is read from an environment variable. A variable is
 * text, so what counts as "on" has to be decided by the code: only the exact text `true` should turn
 * indexing on, so that an unset variable, a typo, `1` or `yes` leaves the site hidden.
 *
 * This reads the same text rules as the other static checks (comments blanked, no code run). A read
 * belongs to the indexing setting when it sits inside a `robots` value, inside a robots file or near
 * an `X-Robots-Tag` header, or when its name says so (INDEX, CRAWL, ROBOTS, SEO).
 *
 * // [GC] no source found (uncited): this is a code-hygiene rule with no framework behaviour behind it. The check says what the code accepts as "on" and does not claim more.
 */
const ID = "indexing-switch-loose";

const SWITCH_NAME = /index|crawl|robots|seo/i;
/** A name that reads the other way round (NO_INDEX, BLOCK_CRAWLERS): "true" there means hidden, so the safe direction flips. */
const NEGATIVE_NAME = /no_?index|no_?crawl|no_?follow|block|hide|hidden|disallow/i;
const DIRECT =
  /^(?:process\.env|import\.meta\.env)(?:\s*\.\s*[A-Za-z_]\w*|\s*\[\s*(["'])[A-Za-z_]\w*\1\s*\])/;

type Verdict =
  { kind: "strict" } | { kind: "loose"; how: string } | { kind: "unsure"; why: string };

/** How the code decides from the variable, from the text just before and after the read. */
function judge(code: string, start: number, end: number): Verdict {
  let after = code.slice(end, end + 90);
  // Trimming or changing case is still a test against "true": it is no looser about a typo.
  for (;;) {
    const next = after.replace(/^\s*\??\.\s*(?:toLowerCase|toUpperCase|trim)\(\s*\)/, "");
    if (next === after) break;
    after = next;
  }
  const before = code.slice(Math.max(0, start - 20), start);
  const equal = /^\s*(?:===|==)\s*(?:(["'])([^"']*)\1|(\d+)\b)/.exec(after);
  if (equal !== null) {
    const value = equal[2] ?? equal[3] ?? "";
    return value === "true"
      ? { kind: "strict" }
      : { kind: "loose", how: `turns indexing on for "${value}", not only for "true"` };
  }
  const notEqual = /^\s*(?:!==|!=)\s*(["'])([^"']*)\1/.exec(after);
  if (notEqual !== null)
    return (notEqual[2] ?? "") === "true"
      ? {
          kind: "unsure",
          why: 'it is compared with !== "true", so which way it reads is not clear',
        }
      : {
          kind: "loose",
          how: `turns indexing on for any value except "${notEqual[2] ?? ""}", so an unset variable or a typo turns it on`,
        };
  if (
    /(?:!!|Boolean\(\s*)$/.test(before) ||
    /!\s*$/.test(before) ||
    /^\s*(?:\?(?!\.)|&&|\|\|)/.test(after)
  )
    return {
      kind: "loose",
      how: 'turns indexing on for any non-empty value, and "false" and "0" are non-empty',
    };
  if (/[\w$]\s*\(\s*$/.test(before))
    return {
      kind: "unsure",
      why: "it is passed to a function, so how its value is tested is not known",
    };
  if (/^\s*(?:,|\)|;|\}|$)/.test(after))
    return { kind: "loose", how: "is passed on as it is, so any non-empty text turns indexing on" };
  return { kind: "unsure", why: "how its value is tested could not be read" };
}

export const indexingSwitchLoose = defineCheck<LocalSourceInput>({
  id: ID,
  size: "S",
  done: 'The setting that turns indexing on is tested against the exact text "true", and nothing else turns it on.',
  estimateChanges:
    "One comparison per place the setting is read. If the variable is already set to 1 or yes on the host, it is changed there at the same time.",
  area: "Search & sharing",
  severity: "medium",
  title: 'The indexing switch accepts more than "true"',
  what: 'The environment variable that turns indexing on is accepted when it is `1`, `yes`, any non-empty text, or anything but one word, instead of only the exact text "true".',
  why: "An environment variable is text, and people mistype it. If anything but `true` turns indexing on, an unset variable on a new preview, a typo or a value of `1` puts a site that should be hidden in front of search engines. Only an exact `true` should do that.",
  fix: 'Compare it with the exact text: `process.env.INDEXING === "true"`. Remove `!== "false"`, `Boolean(...)`, `!!...` and the bare `?` test, and set the variable to the word `true` on the host that should be indexed.',
  tech: 'static, reads the folder\'s code files as text and makes no request; a read of an environment variable belongs to the indexing switch when it is inside a robots value, a robots file or near an X-Robots-Tag header, or its name has INDEX, CRAWL, ROBOTS or SEO in it; === "true" (also after toLowerCase or trim) passes; another literal, !== a literal, Boolean(...), !!..., !..., a bare ?, && or || test, or the value passed on as it is, is a finding; a name that reads the other way round (NO_INDEX, BLOCK_CRAWLERS), !== "true", and a test that could not be read are not sure; the value is never printed, only the variable name, the file and the line',
  run(input, ctx) {
    const { tree } = input;
    const url = `source:${tree.label}`;
    const findings: Finding[] = [];
    let unsure: string | undefined;
    for (const file of sourcePathsOf(tree)) {
      const text = tree.files.get(file) ?? "";
      const code = scrub(text, false);
      if (!/process\.env|import\.meta\.env/.test(code)) continue;
      const bare = scrub(text, true);
      // The stretches of the file that are about robots.
      const ranges: [number, number][] = /(^|\/)robots\.[cm]?[jt]s$/.test(file)
        ? [[0, code.length]]
        : [];
      for (const m of code.matchAll(/\brobots\s*:\s*/g)) {
        const at = m.index + m[0].length;
        const end = bare[at] === "{" ? matching(bare, at) : bare.slice(at).search(/[,\n]/) + at;
        ranges.push([at, end < 0 ? code.length : end]);
      }
      for (const m of code.matchAll(/x-robots-tag/gi))
        ranges.push([Math.max(0, m.index - 300), m.index + 300]);
      for (const read of envReads(code)) {
        const direct = DIRECT.exec(code.slice(read.index));
        // A read inside a string (a name in a message) is not a read.
        if (direct === null || bare[read.index] !== code[read.index]) continue;
        const inRobots = ranges.some(([a, b]) => read.index >= a && read.index <= b);
        if (!inRobots && !SWITCH_NAME.test(read.name)) continue;
        const line = lineOf(code, read.index);
        if (NEGATIVE_NAME.test(read.name)) {
          unsure ??= `${file}:${line} reads ${read.name}, which reads the other way round (true means hidden), so which values turn indexing on was not judged`;
          continue;
        }
        const verdict = judge(code, read.index, read.index + direct[0].length);
        if (verdict.kind === "strict") continue;
        if (verdict.kind === "unsure") {
          unsure ??= `${file}:${line} reads ${read.name}, and ${verdict.why}`;
          continue;
        }
        findings.push({
          checkId: ID,
          severity: "medium",
          title: this.title,
          evidence: `${file}:${line} ${read.name} ${verdict.how}`,
          url,
          source: { file, line },
        });
      }
    }
    sortFindings(findings);
    if (findings.length === 0) {
      const why = unsure ?? notReadReason(tree);
      if (why !== undefined) ctx.couldNotCheck?.(url, why);
    }
    return findings;
  },
});
