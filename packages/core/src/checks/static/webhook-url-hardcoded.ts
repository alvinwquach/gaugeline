import { defineCheck, type Finding } from "../../model.js";
import type { LocalSourceInput } from "../../local-source/run.js";
import { lineOf, notReadReason, scrub, sortFindings, sourcePathsOf } from "./scan.js";

/**
 * FF-24: a third-party webhook URL written in the source. Such a URL is its own password: anyone who
 * has it can post to the channel, the spreadsheet or the automation behind it. The check finds URLs
 * of the common incoming-webhook services (a table of host and path shapes below) and one generic
 * shape (a `/webhook` or `/hooks` path with a long opaque segment) in code files and in
 * .github/workflows. It never prints the URL: a finding names the file, the line and the service,
 * because the path of the URL is the secret. A URL built from an environment variable is not found.
 *
 * // [docs] next@16.4.1 > environment-variables - https://raw.githubusercontent.com/vercel/next.js/v16.4.1/docs/01-app/02-guides/environment-variables.mdx (configuration belongs in environment variables; supports the fix only)
 * // [GC] no source found (uncited): that a leaked webhook URL "can be posted to by anyone" is how incoming webhooks work, and no page was read that says so.
 */
const ID = "webhook-url-hardcoded";

interface Service {
  label: string;
  host: RegExp;
  /** The path, which must hold the part that is secret: a bare `/services/` is not a webhook. */
  path: RegExp;
  /** Where the secret part is, for the placeholder test: the last path segment unless the service puts it in the host. */
  secret?: (u: URL) => string;
}

const SERVICES: readonly Service[] = [
  {
    label: "a Slack incoming webhook",
    host: /^hooks\.slack\.com$/,
    path: /^\/(?:services|workflows|triggers)\/[^/]+\/[^/]+/,
  },
  {
    label: "a Discord webhook",
    host: /^(?:ptb\.|canary\.)?discord(?:app)?\.com$/,
    path: /^\/api(?:\/v\d+)?\/webhooks\/\d+\/[^/]+/,
  },
  {
    label: "a Microsoft Teams webhook",
    host: /(?:^|\.)webhook\.office\.com$|^outlook\.office\.com$/,
    path: /^\/webhook/,
  },
  {
    label: "a Zapier webhook",
    host: /^hooks\.zapier\.com$/,
    path: /^\/hooks\/catch\/[^/]+\/[^/]+/,
  },
  {
    label: "a Make webhook",
    host: /^hook\.[\w-]+\.make\.com$|^hook\.integromat\.com$/,
    path: /^\/[^/]{8,}/,
  },
  {
    label: "an IFTTT webhook",
    host: /^maker\.ifttt\.com$/,
    path: /^\/trigger\/[^/]+\/(?:json\/)?with\/key\/[^/]+/,
  },
  { label: "an n8n webhook", host: /\.n8n\.cloud$/, path: /^\/webhook(?:-test)?\/[^/]{8,}/ },
  {
    label: "a Pipedream webhook",
    host: /\.m\.pipedream\.net$/,
    path: /^\/[^/]*/,
    secret: (u) => u.hostname.split(".")[0] ?? "",
  },
  {
    label: "a Google Chat webhook",
    host: /^chat\.googleapis\.com$/,
    path: /^\/v1\/spaces\/[^/]+\/messages/,
  },
  {
    label: "a webhook",
    host: /./,
    path: /\/(?:webhooks?|hooks?)\/(?:[^/]+\/)*(?=[^/]*\d)(?=[^/]*[A-Za-z])[A-Za-z0-9_-]{16,}\/?$/,
  },
];

/** The part of a URL that carries the secret is a placeholder when it has almost no variety (`XXXXXXXX`, `000000`) or says so. */
function placeholder(u: URL, service: Service): boolean {
  const tail = service.secret?.(u) ?? u.pathname.split("/").filter(Boolean).pop() ?? "";
  return (
    new Set(tail.toLowerCase()).size <= 3 || /your|example|placeholder|changeme|todo/i.test(tail)
  );
}

/** Workflow files (CI) are read as well as code: a hook pasted into a deploy step is just as public. */
const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;

export const webhookUrlHardcoded = defineCheck<LocalSourceInput>({
  id: ID,
  size: "S",
  done: "No webhook URL is written in the source: each one is read from an environment variable.",
  estimateChanges:
    "Moving the URL into an environment variable is minutes. If the URL was ever committed to a public repository, it must also be replaced at the service, which is the larger job.",
  area: "Security & email",
  severity: "high",
  title: "A webhook URL is written in the source code",
  what: "The source contains the full address of an incoming webhook (Slack, Discord, Zapier, Make and others) as text.",
  why: "A webhook address is its own password: whoever has it can post to the channel, sheet or automation behind it. Written in source, it is in every copy of the repository and, for code that ships to the browser, in the page itself. Someone can then fill the kitchen channel with fake orders or trigger an automation that emails your customers.",
  fix: "Create a new webhook at the service (the old one is exposed), put the address in an environment variable on the server (for example KITCHEN_WEBHOOK_URL) and read it with process.env where it is used. Delete the old webhook.",
  tech: "reads the folder's code files and .github/workflows files (comments are skipped, .env files are never read); an https URL whose host and path match an incoming-webhook service (Slack, Discord, Microsoft Teams, Zapier, Make, IFTTT, n8n, Pipedream, Google Chat) or a /webhook or /hooks path with a segment of 16 or more letters, digits, - or _ is a finding; a placeholder (almost no variety) and a URL with a ${} in its path are not; the URL is never kept or printed, only the file, the line and the service; no source file read, or some left out, is could-not-check",
  run(input, ctx) {
    const { tree } = input;
    const url = `source:${tree.label}`;
    const paths = [
      ...sourcePathsOf(tree),
      ...[...tree.files.keys()].filter((p) => WORKFLOW.test(p)),
    ].sort();
    const findings: Finding[] = [];
    for (const file of paths) {
      const text = tree.files.get(file) ?? "";
      const code = WORKFLOW.test(file) ? text.replace(/(^|\s)#[^\n]*/g, "$1") : scrub(text, false);
      for (const m of code.matchAll(/https:\/\/[^\s"'`<>\\)]+/g)) {
        let parsed: URL;
        try {
          parsed = new URL(m[0]);
        } catch {
          continue;
        }
        if (parsed.pathname.includes("${") || m[0].includes("${")) continue;
        const service = SERVICES.find(
          (s) => s.host.test(parsed.hostname) && s.path.test(parsed.pathname),
        );
        if (service === undefined || placeholder(parsed, service)) continue;
        findings.push({
          checkId: ID,
          severity: "high",
          title: this.title,
          evidence: `${file}: ${service.label} address is written in the source.`,
          url,
          source: { file, line: lineOf(code, m.index) },
        });
      }
    }
    sortFindings(findings);
    if (findings.length === 0) {
      const why = notReadReason(tree);
      if (why !== undefined) ctx.couldNotCheck?.(url, why);
    }
    return findings;
  },
});
