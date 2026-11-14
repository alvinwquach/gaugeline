/**
 * The scrub for the check writer (AG-16): finds what must not reach a draft in text that came from an advisory
 * or a docs page, with plain patterns and the owner's own deny-list. It differs from the miner's scrub in one
 * way: the draft MUST carry the file's public web address and quote lines that hold other public addresses, so
 * a public web address is fine and a PRIVATE one (a private network, a loopback or link-local or metadata
 * address, a name with no public ending, a login in the address, a scheme that is not http or https) is the leak.
 * It reports the KIND of problem and the line, never the text, so a failing draft cannot become the way a
 * client's details reach a log, a terminal or a pull request. No model, no network, no clock.
 *
 * It is a net with holes, and says so (docs/check-writer.md): a client name that is not in the deny-list, an
 * address written out in words, and a public-looking address that is private in fact all pass. A person reads
 * the draft before it goes anywhere.
 */
import { findDirective } from "../ai-directives.js";
import { leakKindsOnLine, type DenyList } from "../field-findings/scrub.js";

export const PROBLEM_KINDS = [
  "private-url",
  "email",
  "ip",
  "phone",
  "name",
  "instruction",
  "no-cite",
  "cite-mismatch",
  "cite-not-in-file",
] as const;
export type ProblemKind = (typeof PROBLEM_KINDS)[number];

/** What each kind is called in a report: fixed words, so a report never carries the text it found. */
export const PROBLEM_LABEL: Readonly<Record<ProblemKind, string>> = Object.freeze({
  "private-url": "a web address that is not public",
  email: "an email address",
  ip: "an IP address",
  phone: "a phone number",
  name: "a client name",
  instruction: "words that give an order to an assistant",
  "no-cite": "a claim with no cited line",
  "cite-mismatch": "a cited line that does not hold the claim",
  "cite-not-in-file": "a cited line that is not in the file",
});

/** Endings that are reserved, private or local: a public advisory's address never ends in one. */
const PRIVATE_ENDINGS: ReadonlySet<string> = new Set([
  "localhost",
  "local",
  "localdomain",
  "internal",
  "intranet",
  "private",
  "lan",
  "home",
  "corp",
  "test",
  "invalid",
  "example",
  "arpa",
]);
/** A scheme and "://", or a link scheme that carries an address or a script. */
const URL_TOKEN =
  /\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s<>"'`)\]]+|\b(?:mailto|tel|sms|javascript|file|data):[^\s<>"'`)]+/gi;
const BARE_PRIVATE = new RegExp(
  `\\b[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.(?:${[...PRIVATE_ENDINGS].join("|")})\\b(?!\\.[a-z0-9-])`,
  "i",
);

/** True when the address is not a public web address: see the file's header. */
export function isPrivateUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw.replace(/[.,;:!?]+$/, ""));
  } catch {
    return true;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return true;
  if (u.username !== "" || u.password !== "") return true;
  const host = u.hostname.toLowerCase();
  // An IP address (the URL parser turns 0x7f.1 and 2130706433 into one too), IPv6 or a name with no dot.
  if (host.startsWith("[") || /^\d+(?:\.\d+){3}$/.test(host) || !host.includes(".")) return true;
  return PRIVATE_ENDINGS.has(host.split(".").pop() ?? "");
}

/**
 * The kinds of problem one piece of text holds, in PROBLEM_KINDS order. A public web address is allowed and is
 * left out before the rest is read; a client name is looked for in it too.
 */
export function textProblems(text: string, deny?: DenyList): ProblemKind[] {
  const found = new Set<ProblemKind>();
  if (findDirective(text) !== undefined) found.add("instruction");
  let rest = text;
  for (const m of text.matchAll(URL_TOKEN)) {
    if (isPrivateUrl(m[0])) found.add("private-url");
    else if (leakKindsOnLine(m[0], deny).includes("name")) found.add("name");
    rest = rest.replace(m[0], " ");
  }
  // A name with a private ending as its LAST label (not "example.org"); an email's host is the email's business.
  if (BARE_PRIVATE.test(rest.replace(/\S+@\S+/g, " "))) found.add("private-url");
  // The miner's rules for the rest; its "url" and "domain" kinds are not problems here (a public address is
  // the point of a citation), the others are.
  for (const k of leakKindsOnLine(rest, deny))
    if (k === "email" || k === "ip" || k === "phone" || k === "name") found.add(k);
  return PROBLEM_KINDS.filter((k) => found.has(k));
}
