import type { CheckRegistry, Finding, Severity } from "../model.js";
import { SEVERITY_LABEL } from "../model.js";
import { COLOR, STYLE, escapeHtml } from "../report/html.js";
import { escapeMarkdown } from "../report/brief.js";
import { writeDate } from "../renewals/dates.js";
import type { CouldNotCheck } from "../runner.js";
import { clip } from "./http.js";
import { adminList, adminsOf, clientAccess } from "./judge.js";
import type { People } from "./people.js";
import type { ClientAccess, Member, Party, PeopleSystem, Role, System } from "./types.js";

/** One file of the report, as text: the CLI decides where it goes. */
export interface HandoffFile {
  name: string;
  text: string;
}

/** The one file name of each part of the report. */
export const HANDOFF_FILES = ["handoff.html", "handoff.md", "handoff.json"] as const;

export interface SummarySystem {
  id: string;
  name: string;
  status: "read" | "could-not-check" | "manual";
  subject?: string;
  /** Whose account it is, as far as the provider says: 'team "Harbour Studio"', "a personal account", the registrar. */
  holder?: string;
  clientAccess?: ClientAccess;
  /** The one-line answer: who holds it and where the client stands. */
  headline: string;
  members?: {
    who: string;
    party: Party;
    role: Role;
    rawRole: string;
    pending: boolean;
    token: boolean;
  }[];
  registrar?: string;
  registrant?: "redacted" | "not-listed" | "published";
  provider?: string;
  nameservers?: string[];
  reason?: string;
  why?: string;
  notes: string[];
  help?: string;
}

export interface SummaryFinding {
  checkId: string;
  severity: Severity;
  title: string;
  evidence: string;
  /** The id of the system the finding is about. */
  system: string;
  /** That system's name, to tell findings of one check apart. */
  systemName: string;
  why: string;
  fix: string;
}

export interface ChecklistItem {
  group: "own" | "add" | "ask";
  system: string;
  text: string;
  link?: string;
}

/**
 * The handoff as data: what the three files and the terminal show, in one value. It holds no address in
 * full, no token and no provider id. The same reads give the same summary, byte for byte.
 */
export interface HandoffSummary {
  schemaVersion: 1;
  site: string;
  generatedAt: string;
  gaugelineVersion: string;
  counts: {
    systems: number;
    read: number;
    couldNotCheck: number;
    manual: number;
    findings: { high: number; medium: number; low: number };
  };
  systems: SummarySystem[];
  findings: SummaryFinding[];
  checklist: ChecklistItem[];
  /** Things that stopped a judgement for every system (no client address in the settings). */
  notes: string[];
}

export interface BuildInput {
  site: string;
  now: Date;
  version: string;
  systems: readonly System[];
  findings: readonly Pick<Finding, "checkId" | "severity" | "title" | "evidence" | "url">[];
  couldNotCheck: readonly CouldNotCheck[];
  people: People;
  registry: CheckRegistry;
}

/** A sentence ends in one full stop: a registrar called "Plume Registrar, Inc." does not get two. */
const end = (text: string): string => (/[.!?]$/u.test(text) ? text : `${text}.`);

const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

function holderOf(s: PeopleSystem): string {
  if (s.account.kind === "team")
    return s.account.name ? `team "${clip(s.account.name)}"` : "a team";
  if (s.account.kind === "personal") return "a personal account";
  return clip(s.subject);
}

const ACCESS_WORDS: Record<ClientAccess, string> = {
  admin: "is an owner or admin",
  member: "is a member, not an owner",
  invited: "has been invited and has not accepted",
  none: "is not listed",
  unknown: "could not be placed: Gaugeline cannot tell where the client stands",
};

/** What a system's subject is, to start its sentence. */
const NOUN: Readonly<Record<string, string>> = {
  vercel: "Project",
  sanity: "Project",
  "google-business": "Location",
};

function summarise(system: System, people: People): SummarySystem {
  switch (system.kind) {
    case "people": {
      const access = clientAccess(system, people);
      const admins = adminsOf(system);
      return {
        id: system.id,
        name: system.name,
        status: "read",
        subject: clip(system.subject),
        holder: holderOf(system),
        clientAccess: access,
        headline: `${NOUN[system.id] ?? "Account"} ${clip(system.subject)}${system.account.kind === "team" ? `, in the team${system.account.name ? ` "${clip(system.account.name)}"` : ""}` : system.account.kind === "personal" ? ", in a personal account" : ""}. Owners and admins: ${admins.length === 0 ? "none listed" : adminList(admins)}. The client ${ACCESS_WORDS[access]}.`,
        members: system.members.map((m: Member) => ({
          who: clip(m.who),
          party: m.party,
          role: m.role,
          rawRole: clip(m.rawRole, 40),
          pending: m.pending,
          token: m.token,
        })),
        notes: system.notes.map((n) => clip(n, 200)),
        ...(system.help ? { help: system.help } : {}),
      };
    }
    case "domain":
      return {
        id: system.id,
        name: system.name,
        status: "read",
        subject: clip(system.subject),
        ...(system.registrar
          ? { holder: clip(system.registrar), registrar: clip(system.registrar) }
          : {}),
        registrant: system.registrant,
        headline: `${end(`${clip(system.subject)} is registered at ${system.registrar ? clip(system.registrar) : "a registrar the registry does not name"}`)} ${
          system.registrant === "published"
            ? "The registry publishes the registrant."
            : `The registry ${system.registrant === "redacted" ? "hides" : "does not list"} the registrant, so whose account it is shows only by logging in at the registrar.`
        }`,
        notes: system.notes.map((n) => clip(n, 200)),
      };
    case "dns":
      return {
        id: system.id,
        name: system.name,
        status: "read",
        subject: clip(system.subject),
        ...(system.provider ? { holder: system.provider, provider: system.provider } : {}),
        nameservers: system.nameservers.map((n) => clip(n)),
        headline: system.provider
          ? `Name servers belong to ${system.provider} (${system.nameservers.map((n) => clip(n)).join(", ")}). The account holder is not public.`
          : `Name servers ${system.nameservers.map((n) => clip(n)).join(", ")}. Gaugeline does not recognise the provider.`,
        notes: system.notes.map((n) => clip(n, 200)),
        ...(system.help ? { help: system.help } : {}),
      };
    case "manual":
      return {
        id: system.id,
        name: system.name,
        status: "manual",
        why: clip(system.why, 300),
        headline: `${system.detected ? "The site uses it." : "Listed."} ${clip(system.why, 300)}`,
        notes: [],
        ...(system.help ? { help: system.help } : {}),
      };
    case "could-not-check":
      return {
        id: system.id,
        name: system.name,
        status: "could-not-check",
        ...(system.subject ? { subject: clip(system.subject) } : {}),
        reason: clip(system.reason, 300),
        headline: end(`Could not read: ${clip(system.reason, 300)}`),
        notes: [],
        ...(system.help ? { help: system.help } : {}),
      };
  }
}

const CAN_GET_IN: Readonly<Record<ClientAccess, string>> = {
  admin: "Yes, as an owner or admin",
  member: "Only as a member",
  invited: "Invited, not accepted yet",
  none: "Not listed",
  unknown: "Could not tell",
};

/** The "Can the client get in?" cell: an answer where the system lists people, and where to look where it does not. */
function canGetIn(s: SummarySystem): string {
  if (s.clientAccess) return CAN_GET_IN[s.clientAccess];
  if (s.status === "could-not-check") return "Could not read: check it yourself";
  if (s.status === "manual") return "Check by hand";
  return s.id === "domain" ? "Check at the registrar" : "Check at the DNS host";
}

const heldBy = (s: SummarySystem): string =>
  s.holder ?? (s.status === "read" ? (s.subject ?? "") : "Not read");

function checklistFor(summary: readonly SummarySystem[]): ChecklistItem[] {
  const out: ChecklistItem[] = [];
  for (const s of summary) {
    const link = s.help ? { link: s.help } : {};
    const where = s.subject && s.id !== "domain" && s.id !== "dns" ? ` ${s.subject}` : "";
    const label = `${s.name}${where}`;
    if (s.id === "domain") {
      out.push({
        group: "ask",
        system: s.id,
        text: `${s.name}: ${end(s.registrar ? `registered at ${s.registrar}` : "the registrar is not shown")} Ask whose account it is in, and to be added to it (or to have the domain moved into an account) under your own email, so you can renew it and change where it points.`,
      });
    } else if (s.id === "dns") {
      out.push({
        group: "ask",
        system: s.id,
        text: s.provider
          ? `DNS is at ${s.provider}. Ask for an invitation to that account under your own email, so you can change where the domain points.`
          : "Ask where the domain's DNS is hosted, and for an invitation to that account under your own email.",
        ...link,
      });
    } else if (s.status === "manual") {
      out.push({
        group: "ask",
        system: s.id,
        text: `${s.name}: ask to be added as an administrator under your own email.`,
        ...link,
      });
    } else if (s.status === "could-not-check") {
      out.push({
        group: "add",
        system: s.id,
        text: `${label}: Gaugeline could not read who has access. Open it and check that your own address is listed as an owner.`,
        ...link,
      });
    } else if (s.clientAccess === "admin") {
      out.push({
        group: "own",
        system: s.id,
        text: `${label}: you can add and remove people here. Check that the recovery email and phone on the account are yours.`,
        ...link,
      });
    } else {
      const text: Record<Exclude<ClientAccess, "admin">, string> = {
        member: "you are a member, not an owner. Ask a current owner to make you an owner.",
        invited:
          "you have been invited. Accept the invitation in your email, then ask an owner to make you an owner.",
        none: "your address is not listed. Ask a current owner to invite your own address as an owner.",
        unknown:
          "Gaugeline could not tell whether you are an owner. Open the members page and check that your own address is listed as one.",
      };
      out.push({
        group: "add",
        system: s.id,
        text: `${label}: ${text[s.clientAccess ?? "unknown"]}`,
        ...link,
      });
    }
  }
  const order = { own: 0, add: 1, ask: 2 } as const;
  // Stable: each group keeps the order the systems were read in.
  return out
    .map((c, i) => ({ c, i }))
    .sort((a, b) => order[a.c.group] - order[b.c.group] || a.i - b.i)
    .map(({ c }) => c);
}

/** Builds the summary from what the checks read and found. Pure: the same input gives the same summary. */
export function buildHandoff(input: BuildInput): HandoffSummary {
  const systems = input.systems.map((s) => summarise(s, input.people));
  const order = new Map(systems.map((s, i) => [s.id, i]));
  const systemOf = (url: string): string =>
    url.startsWith("handoff:") ? url.slice("handoff:".length) : url;
  const findings: SummaryFinding[] = input.findings
    .map((f): SummaryFinding => {
      const check = input.registry.get(f.checkId);
      return {
        checkId: f.checkId,
        severity: f.severity,
        title: f.title,
        evidence: clip(f.evidence, 400),
        system: systemOf(f.url),
        systemName: systems.find((x) => x.id === systemOf(f.url))?.name ?? "",
        why: check?.why ?? "",
        fix: check?.fix ?? "",
      };
    })
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        (order.get(a.system) ?? 99) - (order.get(b.system) ?? 99) ||
        a.checkId.localeCompare(b.checkId),
    );
  const count = (s: Severity) => findings.filter((f) => f.severity === s).length;
  const notes = [
    ...new Set(
      input.couldNotCheck.filter((c) => c.url === "handoff:config").map((c) => clip(c.reason, 300)),
    ),
  ];
  return {
    schemaVersion: 1,
    site: clip(input.site),
    generatedAt: input.now.toISOString(),
    gaugelineVersion: input.version,
    counts: {
      systems: systems.length,
      read: systems.filter((s) => s.status === "read").length,
      couldNotCheck: systems.filter((s) => s.status === "could-not-check").length,
      manual: systems.filter((s) => s.status === "manual").length,
      findings: { high: count("high"), medium: count("medium"), low: count("low") },
    },
    systems,
    findings,
    checklist: checklistFor(systems),
    notes,
  };
}

const INTRO =
  "This report is read-only. It comes from public records and from the access the freelancer already had, and it holds no passwords, tokens or recovery codes. Email addresses are shown as their first letter and their domain.";
const GROUPS: Readonly<Record<ChecklistItem["group"], string>> = {
  own: "What you own",
  add: "What to add yourself to",
  ask: "What to ask the person who built the site for",
};
const CLOSING =
  "Ask to be added under your own email address. Never accept a password, a token or a recovery code in a message: an invitation gives you your own way in, and those do not.";

/** An address as masked in this report: its first letter (not a character Markdown or a code span can use), "***", "@" and a domain. */
const MASKED = /[\p{L}\p{N}]\*\*\*@[a-z0-9.-]+\.[a-z0-9-]+/giu;

/**
 * Text for a Markdown line, from a provider or from a check. Escaped, so nothing in it starts a heading,
 * a link or a table; brackets stay plain where they cannot matter (a link needs "]", which is escaped),
 * and a masked address is a code span so its asterisks read as asterisks.
 */
function md(text: string): string {
  const plain = (t: string): string => {
    const core = escapeMarkdown(t).replace(/\\([()])/gu, "$1");
    // escapeMarkdown trims, and the spaces next to a code span matter.
    return `${/^\s/u.test(t) ? " " : ""}${core}${core !== "" && /\s$/u.test(t) ? " " : ""}`;
  };
  let out = "";
  let last = 0;
  for (const m of text.matchAll(MASKED)) {
    out += plain(text.slice(last, m.index)) + `\`${m[0]}\``;
    last = (m.index ?? 0) + m[0].length;
  }
  return out + plain(text.slice(last));
}

/** The report as Markdown: findings, each system, then a checklist for the owner. Every provider value is escaped. */
export function renderHandoffMarkdown(summary: HandoffSummary): string {
  const out: string[] = [
    `# Who owns what: ${md(summary.site)}`,
    "",
    `Prepared ${writeDate(summary.generatedAt)} with Gaugeline ${md(summary.gaugelineVersion)}. ${INTRO}`,
    "",
    "## At a glance",
    "",
    "| System | Held by | Can the client get in? |",
    "| --- | --- | --- |",
    ...summary.systems.map((s) => `| ${md(s.name)} | ${md(heldBy(s))} | ${md(canGetIn(s))} |`),
    "",
    "## What to fix",
    "",
  ];
  if (summary.findings.length === 0) out.push("Nothing to fix.", "");
  for (const f of summary.findings) {
    out.push(
      `### ${md(f.systemName === "" ? f.title : `${f.systemName}: ${f.title}`)} (${SEVERITY_LABEL[f.severity]})`,
      "",
      `- ${md(f.evidence)}`,
      `- Why it matters: ${md(f.why)}`,
      `- How to fix it: ${md(f.fix)}`,
      "",
    );
  }
  for (const n of summary.notes) out.push(`Note: ${md(n)}`, "");
  out.push("## System by system", "");
  for (const s of summary.systems) {
    out.push(`### ${md(s.name)}`, "", md(s.headline), "");
    if (s.members && s.members.length > 0)
      out.push(
        "| Who | Whose | Role |",
        "| --- | --- | --- |",
        ...s.members.map(
          (m) =>
            `| ${md(m.who)} | ${m.party === "unknown" ? "not shown" : m.token ? "not a person" : m.party === "other" ? "someone else" : m.party === "client" ? "the client" : "the freelancer"} | ${md(m.rawRole === "" ? m.role : `${m.role} (${m.rawRole})`)}${m.pending ? ", invited" : ""} |`,
        ),
        "",
      );
    for (const n of s.notes) out.push(`- ${md(n)}`);
    if (s.notes.length > 0) out.push("");
  }
  out.push("## A checklist for the owner", "");
  for (const group of ["own", "add", "ask"] as const) {
    out.push(`### ${GROUPS[group]}`, "");
    const items = summary.checklist.filter((c) => c.group === group);
    if (items.length === 0) out.push("Nothing here.");
    for (const c of items)
      out.push(`- [ ] ${md(c.text)}${c.link ? ` [Where to do it](${c.link})` : ""}`);
    out.push("");
  }
  out.push(CLOSING, "");
  return out.join("\n");
}

const e = escapeHtml;

/** The report as one self-contained HTML file: inline CSS, no script, no image, no request. Every value is escaped. */
export function renderHandoffHtml(summary: HandoffSummary): string {
  const body: string[] = [
    `<h1>Who owns what: ${e(summary.site)}</h1>`,
    `<p class="meta">Prepared ${e(writeDate(summary.generatedAt))} with Gaugeline ${e(summary.gaugelineVersion)}. ${e(INTRO)}</p>`,
    "<h2>At a glance</h2>",
    '<table><thead><tr><th scope="col">System</th><th scope="col">Held by</th><th scope="col">Can the client get in?</th></tr></thead><tbody>',
    ...summary.systems.map(
      (s) =>
        `<tr><th scope="row">${e(s.name)}</th><td>${e(heldBy(s))}</td><td>${e(canGetIn(s))}</td></tr>`,
    ),
    "</tbody></table>",
    "<h2>What to fix</h2>",
  ];
  if (summary.findings.length === 0) body.push("<p><strong>Nothing to fix.</strong></p>");
  for (const f of summary.findings)
    body.push(
      `<article class="f" style="border-color:${COLOR[f.severity]}">`,
      `<h3 dir="auto">${e(f.systemName === "" ? f.title : `${f.systemName}: ${f.title}`)} <span class="id">${e(SEVERITY_LABEL[f.severity])}</span></h3>`,
      `<p dir="auto"><code>${e(f.evidence)}</code></p>`,
      `<p><strong>Why it matters:</strong> ${e(f.why)}</p>`,
      `<p><strong>How to fix it:</strong> ${e(f.fix)}</p>`,
      "</article>",
    );
  for (const n of summary.notes) body.push(`<p class="meta">Note: ${e(n)}</p>`);
  body.push("<h2>System by system</h2>");
  for (const s of summary.systems) {
    body.push(`<h3>${e(s.name)}</h3>`, `<p dir="auto">${e(s.headline)}</p>`);
    if (s.members && s.members.length > 0)
      body.push(
        '<table><thead><tr><th scope="col">Who</th><th scope="col">Whose</th><th scope="col">Role</th></tr></thead><tbody>',
        ...s.members.map(
          (m) =>
            `<tr><td>${e(m.who)}</td><td>${m.party === "unknown" ? "not shown" : m.token ? "not a person" : m.party === "other" ? "someone else" : m.party === "client" ? "the client" : "the freelancer"}</td><td>${e(m.rawRole === "" ? m.role : `${m.role} (${m.rawRole})`)}${m.pending ? ", invited" : ""}</td></tr>`,
        ),
        "</tbody></table>",
      );
    if (s.notes.length > 0) body.push("<ul>", ...s.notes.map((n) => `<li>${e(n)}</li>`), "</ul>");
  }
  body.push("<h2>A checklist for the owner</h2>");
  for (const group of ["own", "add", "ask"] as const) {
    body.push(`<h3>${e(GROUPS[group])}</h3>`);
    const items = summary.checklist.filter((c) => c.group === group);
    if (items.length === 0) body.push("<p>Nothing here.</p>");
    else
      body.push(
        '<ul class="check">',
        ...items.map(
          (c) =>
            `<li>\u2610 ${e(c.text)}${c.link ? ` <a href="${e(c.link)}" rel="noreferrer">Where to do it</a>` : ""}</li>`,
        ),
        "</ul>",
      );
  }
  body.push(`<p class="meta">${e(CLOSING)}</p>`);
  const extra =
    "table{border-collapse:collapse;width:100%;margin:.5rem 0 1rem}th,td{border:1px solid #eaecf0;padding:.4rem .6rem;text-align:left;vertical-align:top}ul.check{list-style:none;padding-left:0}ul.check li{margin:.4rem 0}a{color:#175cd3}";
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>Who owns what: ${e(summary.site)}</title>`,
    `<style>${STYLE}${extra}</style>`,
    "</head>",
    "<body>",
    ...body,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/** The three files `gaugeline handoff` writes, in order: the HTML report, the Markdown report and the JSON summary. */
export function handoffFiles(summary: HandoffSummary): HandoffFile[] {
  return [
    { name: HANDOFF_FILES[0], text: renderHandoffHtml(summary) },
    { name: HANDOFF_FILES[1], text: renderHandoffMarkdown(summary) },
    { name: HANDOFF_FILES[2], text: `${JSON.stringify(summary, null, 2)}\n` },
  ];
}

/** The terminal view: one line a system, aligned. The same text as the report's "At a glance", with the headline. */
export function formatHandoffLines(summary: HandoffSummary): string[] {
  const width = Math.max(0, ...summary.systems.map((s) => s.name.length));
  return [
    `Who owns what for ${summary.site}`,
    ...summary.systems.map((s) => `${s.name.padEnd(width)}  ${s.headline}`),
  ];
}
