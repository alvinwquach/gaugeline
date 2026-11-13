import { load } from "cheerio/slim";
import { AI_AGENTS, type AiAgent } from "../ai-agents.js";
import { wantsAllowed, type AiIntent } from "../ai-intent.js";
import type { PageSnapshot } from "../snapshot.js";

/**
 * The page-level signals about AI crawlers (AI-14): an X-Robots-Tag header and a robots or crawler meta tag, read as a
 * list of (where, which crawler, which directive), and compared with what the owner said they want. Plain rules: the
 * same page gives the same list, and only directives from a fixed vocabulary survive, so no page text reaches a finding.
 *
 * `noai` and `noimageai` are conventions some sites and tools use to opt out of AI training; they are not part of a
 * published standard that Gaugeline could read, so they are treated as asking training crawlers to stay away and nothing
 * more (uncited: the convention is from memory; the sites that document it were unreachable when this was written).
 * `Crawler: directive` in an X-Robots-Tag header and a meta tag named for a crawler follow the same shape as for search crawlers.
 */
export interface Signal {
  where: "header" | "meta";
  /** The crawler the directive is for, lower case; undefined when it is for every crawler. */
  agent?: string;
  directive: string;
}

const DIRECTIVES: ReadonlySet<string> = new Set([
  "all",
  "follow",
  "index",
  "indexifembedded",
  "max-image-preview",
  "max-snippet",
  "max-video-preview",
  "noai",
  "noarchive",
  "nofollow",
  "noimageai",
  "noimageindex",
  "noindex",
  "none",
  "nosnippet",
  "notranslate",
  "unavailable_after",
]);

/** The most of a header read: a hostile one is cut, not parsed to the end. */
const HEADER_MAX = 4096;
/** The most signals kept from one page. */
const SIGNALS_MAX = 100;

const AGENT_PREFIX = /^([A-Za-z0-9_.-]{1,40})\s*:\s*(.*)$/;
const AGENT_TOKENS: ReadonlySet<string> = new Set(AI_AGENTS.map((a) => a.token.toLowerCase()));

/** "noai, GPTBot: noindex": the directives, each under the crawler last named (none named: every crawler). */
function fromHeader(value: string): Signal[] {
  const out: Signal[] = [];
  let agent: string | undefined;
  for (const raw of value.slice(0, HEADER_MAX).split(",")) {
    let token = raw.trim().toLowerCase();
    if (token === "") continue;
    const m = AGENT_PREFIX.exec(token);
    if (m && !DIRECTIVES.has(m[1] ?? "")) {
      agent = m[1];
      token = (m[2] ?? "").trim();
    } else if (m) {
      // "unavailable_after: date": the directive with a value.
      token = m[1] ?? "";
    }
    if (DIRECTIVES.has(token))
      out.push({ where: "header", ...(agent ? { agent } : {}), directive: token });
  }
  return out;
}

/** The directives in a meta tag's content, for the crawler its name gives (robots: every crawler). */
function fromMeta(content: string, agent: string | undefined): Signal[] {
  return content
    .slice(0, HEADER_MAX)
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => DIRECTIVES.has(t))
    .map((directive) => ({ where: "meta" as const, ...(agent ? { agent } : {}), directive }));
}

export function pageSignals(page: PageSnapshot): Signal[] {
  const hop = page.hops.at(-1);
  const out: Signal[] = [...fromHeader(hop?.headers["x-robots-tag"] ?? "")];
  const $ = load(hop?.body ?? "");
  $("meta[name]").each((_, el) => {
    const name = ($(el).attr("name") ?? "").trim().toLowerCase();
    if (name === "robots") out.push(...fromMeta($(el).attr("content") ?? "", undefined));
    else if (AGENT_TOKENS.has(name)) out.push(...fromMeta($(el).attr("content") ?? "", name));
  });
  return out.slice(0, SIGNALS_MAX);
}

export interface SignalMismatch {
  where: "header" | "meta";
  /** The crawler the signal names, as the list writes it, or undefined for one that is for every crawler. */
  scope?: string;
  directive: string;
  /** The known crawlers the signal keeps away although the intent wants them allowed. */
  agents: AiAgent[];
}

/**
 * The signals that keep a crawler away that the owner wants allowed. Only signals about AI crawlers count: noai and
 * noimageai (for the training crawlers, or the one named), and noindex or none for a named AI crawler. A general
 * noindex is about every crawler and is the noindex check's to report. A signal that agrees with the intent, or one
 * that fails to block a crawler the owner wants blocked (robots.txt may block it: ai-crawlers-intent compares that), is no mismatch.
 */
export function signalsAgainstIntent(
  signals: readonly Signal[],
  intent: AiIntent,
): SignalMismatch[] {
  const out: SignalMismatch[] = [];
  const seen = new Set<string>();
  for (const s of signals) {
    const key = `${s.where}|${s.agent ?? "*"}|${s.directive}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let targets: AiAgent[];
    if (s.directive === "noai" || s.directive === "noimageai") {
      targets = AI_AGENTS.filter(
        (a) =>
          a.purpose === "training" && (s.agent === undefined || s.agent === a.token.toLowerCase()),
      );
    } else if ((s.directive === "noindex" || s.directive === "none") && s.agent !== undefined) {
      targets = AI_AGENTS.filter((a) => a.token.toLowerCase() === s.agent);
    } else continue;
    const agents = targets.filter((a) => wantsAllowed(intent, a.purpose));
    if (agents.length === 0) continue;
    const scope =
      s.agent === undefined
        ? undefined
        : AI_AGENTS.find((a) => a.token.toLowerCase() === s.agent)?.token;
    out.push({ where: s.where, ...(scope ? { scope } : {}), directive: s.directive, agents });
  }
  return out;
}
