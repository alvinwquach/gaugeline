import { ADAPTER_ENTRIES } from "../adapters/entries.generated.js";
import { SANITY_ENV_VARS } from "../connectors/sanity.js";
import type { StackReport } from "./stack.js";

/** A file `gaugeline init` proposes: its name in the working folder and its text. Fits the safe writer's `WritableFile`. */
export interface InitFile {
  name: string;
  text: string;
  /** What it holds, in a line, for the terminal. */
  what: string;
}

/** An environment variable the person sets themselves. Only its name is ever written. */
export interface InitEnvVar {
  name: string;
  /** What it is for: "WordPress (only for drafts and members)". */
  for: string;
}

/** One thing to do next, with the page that explains it. */
export interface NextStep {
  title: string;
  /** A command to run, when there is one. */
  command?: string;
  docs: string;
}

export interface InitPlan {
  files: InitFile[];
  envVars: InitEnvVar[];
  next: NextStep[];
}

export const ADAPTERS_FILE = "gaugeline.adapters.json";
export const PAYMENTS_FILE = "gaugeline.payments.json";
export const HANDOFF_FILE = "gaugeline.handoff.json";
export const LISTINGS_FILE = "gaugeline.listings.json";
export const COST_FILE = "gaugeline.cost.json";
/** The notes file: JSON cannot carry comments, so each setting's evidence goes here. */
export const NOTES_FILE = "gaugeline.init.md";

const DOCS = "https://gaugeline.dev/docs";

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** Variables an adapter reads that its entry file does not list (Sanity's are listed by its connector). */
const EXTRA_ENV: Readonly<Record<string, readonly string[]>> = { sanity: SANITY_ENV_VARS };

const KEY_NOTE = (keyKind: string | undefined, noKey: boolean | undefined): string =>
  noKey ? "no key needed" : keyKind === "scoped" ? "scoped key" : "read-only key";

/** The path of a cost page must be a plain path: no query, no star. */
const PLAIN_PATH = /^\/[^\s?#*]*$/;

/**
 * The starter files for what was detected. Pure and deterministic: the same report gives the same text, in the
 * same order. Nothing here is a key or a secret: settings files hold only public identifiers (a project id, a
 * payment link the site already shows), and the keys an adapter needs are named as environment variables.
 */
export function planInit(report: StackReport, typedAddress: string): InitPlan {
  const files: InitFile[] = [];
  const chosen =
    report.adapters.length > 0
      ? report.adapters.map((a) => ({ id: a.id }))
      : [{ id: "sitemap-feed" }];
  files.push({
    name: ADAPTERS_FILE,
    text: json({ adapters: chosen.slice(0, 8) }),
    what:
      report.adapters.length > 0
        ? `the content system to read: ${report.adapters.map((a) => a.name).join(", ")}`
        : "the sitemap and feeds adapter, which needs no key and works on any site",
  });
  if (report.payments.length > 0)
    files.push({
      name: PAYMENTS_FILE,
      text: json({ payments: report.payments.map((p) => ({ kind: p.kind, value: p.value })) }),
      what: `the ${report.payments.length === 1 ? "payment detail" : "payment details"} the site shows, to be kept the same everywhere`,
    });
  if (report.sanityProjectId)
    files.push({
      name: HANDOFF_FILE,
      text: json({ sanity: { projectId: report.sanityProjectId } }),
      what: "the Sanity project the handoff report reads",
    });
  if (report.yelpBusiness)
    files.push({
      name: LISTINGS_FILE,
      text: json({ yelp: { businessId: report.yelpBusiness } }),
      what: "the Yelp page the listing checks compare with the site",
    });
  const costPages = report.pages
    .slice(1)
    .filter((p) => PLAIN_PATH.test(p))
    .slice(0, 5);
  if (report.hosting?.id === "vercel" && costPages.length > 0)
    files.push({
      name: COST_FILE,
      text: json({ pages: costPages }),
      what: "the pages the cost check visits twice",
    });

  const envVars: InitEnvVar[] = [];
  for (const a of report.adapters) {
    const entry = ADAPTER_ENTRIES.find((e) => e.id === a.id);
    const names = [...(entry?.envVars ?? []), ...(EXTRA_ENV[a.id] ?? [])];
    for (const name of [...new Set(names)])
      envVars.push({
        name,
        for: `${a.name} (${KEY_NOTE(entry?.describe?.keyKind, entry?.describe?.noKey)})`,
      });
  }
  if (report.yelpBusiness) envVars.push({ name: "YELP_API_KEY", for: "Yelp (read-only key)" });
  if (report.hosting?.id === "vercel")
    envVars.push({
      name: "GAUGELINE_VERCEL_TOKEN",
      for: "Vercel (read-only token, for handoff and renewals)",
    });

  const next: NextStep[] = [];
  next.push({
    title: "Run the first check and read what it says",
    command: `npx gaugeline ${typedAddress}`,
    docs: `${DOCS}/running-a-check`,
  });
  for (const a of report.adapters) {
    const entry = ADAPTER_ENTRIES.find((e) => e.id === a.id);
    next.push({
      title: `Set up the ${a.name} adapter: set its variables, then check that what is published is live`,
      command: `npx gaugeline ${typedAddress} --published`,
      docs: entry?.describe?.docsUrl ?? `${DOCS}/integrations`,
    });
  }
  if (report.forms.length > 0)
    next.push({
      title: `Watch the ${report.forms.map((f) => f.name).join(" and ")} form: a changed provider or a dead endpoint loses leads`,
      docs: `${DOCS}/forms-and-crm`,
    });
  if (report.payments.length > 0)
    next.push({
      title: "Review gaugeline.payments.json, then keep the payment details the same on every page",
      docs: `${DOCS}/guides/payments`,
    });
  if (report.hosting?.id === "vercel")
    next.push({
      title: "Check what runs up the Vercel bill",
      command: `npx gaugeline cost ${typedAddress}`,
      docs: `${DOCS}/guides/hosting-cost`,
    });
  if (report.analytics.length > 0)
    next.push({
      title: "List the pages where a tracker should never run (booking, intake, conditions)",
      docs: `${DOCS}/guides/trackers-on-sensitive-pages`,
    });
  if (report.listings.length > 0)
    next.push({
      title: "Compare the site with its Google, Yelp and TripAdvisor listings",
      docs: `${DOCS}/connectors/listings`,
    });
  next.push({
    title: "Before you hand the site over: who owns what, and can the client get in without you",
    command: `npx gaugeline handoff ${typedAddress}`,
    docs: `${DOCS}/guides/handoff`,
  });

  files.push({
    name: NOTES_FILE,
    text: "",
    what: "what was detected, the evidence for each setting and the next steps",
  });
  const plan: InitPlan = { files, envVars, next };
  const notes = files.find((f) => f.name === NOTES_FILE);
  if (notes) notes.text = renderNotes(report, plan, typedAddress);
  return plan;
}

const bullet = (s: { name: string; evidence: string }): string => `- ${s.name}: ${s.evidence}`;

/** gaugeline.init.md: the evidence for each setting, since the settings files are JSON and cannot hold comments. */
export function renderNotes(report: StackReport, plan: InitPlan, typedAddress: string): string {
  const lines: string[] = [`# What gaugeline init found on ${report.site}`, ""];
  lines.push(
    `Written by \`gaugeline init ${typedAddress}\` from the public pages ${report.pages.join(", ")}. Review every file before you commit it. Nothing here is a key: the variables below are names for you to set in your own environment.`,
    "",
    "## What it saw",
    "",
  );
  const seen: string[] = [];
  for (const a of report.adapters) seen.push(`- Content system, ${bullet(a).slice(2)}`);
  if (report.framework) seen.push(`- Framework, ${bullet(report.framework).slice(2)}`);
  if (report.hosting) seen.push(`- Host, ${bullet(report.hosting).slice(2)}`);
  if (report.cdn) seen.push(`- CDN, ${bullet(report.cdn).slice(2)}`);
  if (report.dns) seen.push(`- DNS, ${bullet(report.dns).slice(2)}`);
  for (const f of report.forms) seen.push(`- Form, ${bullet(f).slice(2)}`);
  for (const p of report.payments) seen.push(`- Payment, ${p.evidence} (${p.kind})`);
  for (const t of report.analytics) seen.push(`- Analytics, ${bullet(t).slice(2)}`);
  for (const l of report.listings) seen.push(`- Listing, ${bullet(l).slice(2)}`);
  lines.push(...(seen.length > 0 ? seen : ["- Nothing it could name."]), "");
  lines.push("## Files", "");
  for (const f of plan.files) if (f.name !== NOTES_FILE) lines.push(`- \`${f.name}\`: ${f.what}`);
  lines.push("");
  if (plan.envVars.length > 0) {
    lines.push("## Variables to set", "");
    for (const v of plan.envVars) lines.push(`- \`${v.name}\`: ${v.for}`);
    lines.push("");
  }
  if (report.notes.length > 0) lines.push("## Notes", "", ...report.notes.map((n) => `- ${n}`), "");
  lines.push("## Next, in order of value", "");
  plan.next.forEach((n, i) =>
    lines.push(`${i + 1}. ${n.title}${n.command ? ` (\`${n.command}\`)` : ""}: ${n.docs}`),
  );
  lines.push("");
  return lines.join("\n");
}
