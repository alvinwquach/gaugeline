import { fingerprint } from "../fingerprint.js";
import type { CheckRegistry, Finding, Severity } from "../model.js";
import { redact } from "../redact.js";
import type { Result } from "../result.js";

/**
 * SARIF and JUnit are two more views of one Result. Each is a pure function: the same result gives
 * the same text, nothing is read, requested or written, and the engine knows nothing of CI.
 * What they carry is each finding's title, its evidence line and the address it is about; never
 * page content beyond that line, and never a key (every text goes through redact()).
 */

/** The longest evidence line either format carries, in characters. */
export const EVIDENCE_LIMIT = 500;

/** The longest title, reason or address either format carries. */
const TEXT_LIMIT = 300;

/**
 * A finding the run muted, kept so a format can still show it, marked, instead of dropping it.
 * `baseline`: it was in --baseline. `suppression`: a --suppress entry or a config suppression.
 * This is the seam for G29 (config, baseline, suppress): once its code is on main, the CLI passes
 * what it removed from the result here. Without it, nothing is marked.
 */
export interface SuppressedFinding {
  finding: Finding;
  kind: "baseline" | "suppression";
  reason?: string;
  /** The last day (YYYY-MM-DD, UTC) the suppression applies. */
  until?: string;
}

export interface FormatOptions {
  /** For each rule's name, what, why and fix. A check the registry does not know gets a bare rule. */
  registry: CheckRegistry;
  /** Gaugeline's version, written as the tool's version. */
  version: string;
  suppressed?: readonly SuppressedFinding[];
  /** Checks left out of this run on purpose (the DNS checks without --dns): a skip, never a failure. */
  notRun?: readonly string[];
}

const DOCS_CHECKS = "https://gaugeline.dev/docs/checks";
const TOOL_URI = "https://gaugeline.dev/";

/** Redacted, one string, cut at `limit` characters with an ellipsis. */
function text(value: string, limit: number): string {
  const clean = redact(value);
  const chars = [...clean];
  return chars.length > limit ? `${chars.slice(0, limit - 1).join("")}…` : clean;
}

type Level = "error" | "warning" | "note";
const LEVEL: Readonly<Record<Severity, Level>> = { high: "error", medium: "warning", low: "note" };

function suppressionText(s: SuppressedFinding): string {
  if (s.kind === "baseline") return "In the baseline";
  const until = s.until ? ` (until ${s.until})` : "";
  return `${s.reason ? text(s.reason, TEXT_LIMIT) : "Suppressed"}${until}`;
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search ? "?…" : ""}`;
  } catch {
    return "";
  }
}

/** A repository-relative URI reference: forward slashes, no leading "./", escaped. */
function relativeUri(file: string): string {
  return encodeURI(file.replace(/\\/g, "/").replace(/^(?:\.\/)+/, ""));
}

interface Entry {
  finding: Finding;
  muted?: SuppressedFinding;
}

function entries(result: Result, suppressed: readonly SuppressedFinding[] | undefined): Entry[] {
  return [
    ...result.findings.map((finding) => ({ finding })),
    ...(suppressed ?? []).map((muted) => ({ finding: muted.finding, muted })),
  ];
}

/** SARIF 2.1.0 as text: one rule per check id, a result per finding. */
export function formatSarif(result: Result, options: FormatOptions): string {
  const all = entries(result, options.suppressed);
  const ids = [...new Set(all.map((e) => e.finding.checkId))].sort();
  const index = new Map(ids.map((id, i) => [id, i]));
  const rules = ids.map((id) => {
    const check = options.registry.get(id);
    if (!check) return { id, name: id, shortDescription: { text: id } };
    return {
      id,
      name: id,
      shortDescription: { text: text(check.title, TEXT_LIMIT) },
      fullDescription: { text: text(check.what, 1000) },
      help: {
        text: text(check.fix, 1000),
        markdown: `**Why it matters:** ${text(check.why, 1000)}\n\n**How to fix:** ${text(check.fix, 1000)}`,
      },
      helpUri: `${DOCS_CHECKS}#${id}`,
      defaultConfiguration: { level: LEVEL[check.severity] },
      properties: { tags: [check.area] },
    };
  });
  const results = all.map(({ finding: f, muted }) => {
    const evidence = text(f.evidence, EVIDENCE_LIMIT);
    const url = text(f.url, TEXT_LIMIT);
    const location = f.source
      ? {
          physicalLocation: {
            artifactLocation: { uri: relativeUri(f.source.file), uriBaseId: "%SRCROOT%" },
            region: { startLine: Math.max(1, f.source.line) },
          },
        }
      : { logicalLocations: [{ fullyQualifiedName: url, kind: "resource" }] };
    return {
      ruleId: f.checkId,
      ruleIndex: index.get(f.checkId) ?? -1,
      level: LEVEL[f.severity],
      message: { text: `${text(f.title, TEXT_LIMIT)}\nEvidence: ${evidence}` },
      locations: [location],
      partialFingerprints: { "gaugeline/v1": fingerprint(f) },
      ...(muted
        ? {
            suppressions: [
              { kind: "external", status: "accepted", justification: suppressionText(muted) },
            ],
          }
        : {}),
      properties: { evidence, url },
    };
  });
  const notifications = [
    ...(options.notRun ?? []).map((id) => ({
      level: "note",
      message: { text: `${text(id, TEXT_LIMIT)} was not run` },
      descriptor: { id },
    })),
    ...result.failed.map((id) => ({
      level: "error",
      message: { text: `${text(id, TEXT_LIMIT)} could not run` },
      descriptor: { id },
    })),
    ...result.couldNotCheck.map((c) => ({
      level: "warning",
      message: {
        text: `${text(c.id, TEXT_LIMIT)} could not be checked: ${text(c.reason, TEXT_LIMIT)} (${text(c.url, TEXT_LIMIT)})`,
      },
      descriptor: { id: c.id },
    })),
  ];
  const log = {
    $schema:
      "https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: { name: "Gaugeline", version: options.version, informationUri: TOOL_URI, rules },
        },
        invocations: [
          {
            executionSuccessful: result.failed.length === 0,
            startTimeUtc: new Date(result.startedAt).toISOString(),
            ...(notifications.length > 0 ? { toolExecutionNotifications: notifications } : {}),
          },
        ],
        results,
      },
    ],
  };
  return `${JSON.stringify(log, null, 2)}\n`;
}

// XML 1.0 allows tab, line feed, carriage return and everything from U+0020 up except U+FFFE and U+FFFF.
// eslint-disable-next-line no-control-regex -- these are the characters to remove
const NOT_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

function xml(value: string, limit: number, attribute = false): string {
  const safe = text(value, limit)
    .replace(NOT_XML, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return attribute
    ? safe
        .replace(/"/g, "&quot;")
        .replace(/\t/g, "&#9;")
        .replace(/\n/g, "&#10;")
        .replace(/\r/g, "&#13;")
    : safe;
}

const attr = (name: string, value: string, limit = TEXT_LIMIT) =>
  `${name}="${xml(value, limit, true)}"`;

/**
 * JUnit XML (the Jenkins/Ant dialect: testsuites > testsuite > testcase) as text. A "Fix this
 * first" or "Fix soon" finding is a failure, a "Worth knowing" one a pass with a note, a check
 * that could not run an error, and a page the site refused, or a muted finding, a skip.
 */
export function formatJunit(result: Result, options: FormatOptions): string {
  const cases: { xml: string; failure?: true; error?: true; skipped?: true }[] = [];
  const title = (id: string) => options.registry.get(id)?.title ?? id;
  for (const { finding: f, muted } of entries(result, options.suppressed)) {
    const path = pathOf(f.url);
    const open = `<testcase ${attr("classname", f.checkId)} ${attr("name", `${f.title}${path ? ` (${path})` : ""}`)}`;
    const body = `${xml(f.evidence, EVIDENCE_LIMIT)}\n${xml(f.url, TEXT_LIMIT)}`;
    if (muted)
      cases.push({
        xml: `${open}><skipped ${attr("message", suppressionText(muted))}/></testcase>`,
        skipped: true,
      });
    else if (f.severity === "low")
      cases.push({ xml: `${open}><system-out>${body}</system-out></testcase>` });
    else
      cases.push({
        xml: `${open}><failure ${attr("message", f.title)} ${attr("type", f.severity)}>${body}</failure></testcase>`,
        failure: true,
      });
  }
  for (const id of result.passed)
    cases.push({ xml: `<testcase ${attr("classname", id)} ${attr("name", title(id))}/>` });
  for (const id of result.failed)
    cases.push({
      xml: `<testcase ${attr("classname", id)} ${attr("name", title(id))}><error ${attr("message", `${id} could not run`)} type="could-not-run"/></testcase>`,
      error: true,
    });
  for (const id of options.notRun ?? [])
    cases.push({
      xml: `<testcase ${attr("classname", id)} ${attr("name", title(id))}><skipped message="not run"/></testcase>`,
      skipped: true,
    });
  for (const c of result.couldNotCheck)
    cases.push({
      xml: `<testcase ${attr("classname", c.id)} ${attr("name", title(c.id))}><skipped ${attr("message", `${c.reason} (${c.url})`, 2 * TEXT_LIMIT)}/></testcase>`,
      skipped: true,
    });
  const count = (key: "failure" | "error" | "skipped") => cases.filter((c) => c[key]).length;
  const counts = `tests="${cases.length}" failures="${count("failure")}" errors="${count("error")}"`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites ${attr("name", "Gaugeline")} ${counts}>`,
    `<testsuite ${attr("name", result.url)} ${counts} skipped="${count("skipped")}" ${attr("timestamp", result.startedAt)}>`,
    ...cases.map((c) => c.xml),
    "</testsuite>",
    "</testsuites>",
    "",
  ].join("\n");
}
