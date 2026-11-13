/**
 * The scrub (AG-15): finds a client name, an address, an email or a phone number in text that came from review
 * notes, with plain patterns and the owner's own deny-list of names. No model, no network, no clock: the same
 * text gives the same answer. It reports the KIND of leak and the LINE, and never the text it found, so a
 * failing draft cannot become the way a client's details reach a log, a terminal or a pull request.
 *
 * It is a net with holes, and says so (docs/field-findings-miner.md): a name that is not in the deny-list, an
 * address written out in words ("example dot com"), a domain under an unusual ending, a handle and an
 * international number written without a plus or separators all pass. A person reads the draft before it goes
 * anywhere; the scrub exists so the obvious cases never reach that person.
 */
import { normaliseForMatch } from "../ai-directives.js";

/** The kinds of leak, in the order a line lists them. */
export const LEAK_KINDS = ["url", "email", "domain", "ip", "phone", "name"] as const;
export type LeakKind = (typeof LEAK_KINDS)[number];

/** One leak: the kind, and the line of the text it was on (from 1). Never the text. */
export interface TextLeak {
  kind: LeakKind;
  line: number;
}

/** What each kind is called in a report: fixed words, so a report never carries the text it found. */
export const LEAK_LABEL: Readonly<Record<LeakKind, string>> = Object.freeze({
  url: "a web address",
  email: "an email address",
  domain: "a domain name",
  ip: "an IP address",
  phone: "a phone number",
  name: "a client name",
});

export const MAX_DENY_ENTRIES = 1000;
const DENY_MIN = 3;
const DENY_MAX = 80;

/** The deny-list is not usable. The message names a line and the rule, never the entry. */
export class DenyListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DenyListError";
  }
}

/** A compiled deny-list: one pattern for every name, or null when the list is empty. */
export interface DenyList {
  readonly entries: number;
  readonly pattern: RegExp | null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Reads a deny-list file: one name per line, blank lines and lines that start with # skipped. A name is 3 to 80
 * characters; a space in a name also matches a hyphen, an underscore or any run of spaces. Case, accents and
 * hidden characters do not matter (the text is folded the way the assistant-directive check folds it).
 */
export function compileDenyList(text: string): DenyList {
  const names: string[] = [];
  const lines = text.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/);
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    // eslint-disable-next-line no-control-regex -- the point is to refuse control characters
    if (/[\u0000-\u001F\u007F]/.test(line))
      throw new DenyListError(`Deny-list line ${i + 1} holds a control character.`);
    const folded = normaliseForMatch(line);
    if (folded.length < DENY_MIN || line.length > DENY_MAX)
      throw new DenyListError(
        `Deny-list line ${i + 1} must be ${DENY_MIN} to ${DENY_MAX} characters.`,
      );
    names.push(folded);
    if (names.length > MAX_DENY_ENTRIES)
      throw new DenyListError(`The deny-list holds more than ${MAX_DENY_ENTRIES} names.`);
  }
  if (names.length === 0) return { entries: 0, pattern: null };
  const alternatives = [...new Set(names)]
    .sort((a, b) => b.length - a.length || (a < b ? -1 : 1))
    .map((n) => n.split(" ").map(escapeRe).join("[\\s_-]+"));
  return {
    entries: names.length,
    pattern: new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives.join("|")})(?![\\p{L}\\p{N}])`, "u"),
  };
}

// Web addresses: a scheme and "://", a www. host, or a link scheme that carries an address or a script.
const URL_RE =
  /\b[a-z][a-z0-9+.-]{1,15}:\/\/\S+|\bwww\.\S+|\b(?:mailto|tel|sms|javascript|file|data):\S+/g;
const EMAIL_RE = /(?<![a-z0-9._%+-])[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/g;

/** Endings that are also file extensions (md, sh, py, pl, rs, cc, ps): a file name is not a domain. */
const FILE_LIKE = new Set(["md", "sh", "py", "pl", "rs", "cc", "ps"]);
const CC =
  "ac ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bm bn bo br bs bt bw by bz ca cc cd cf cg ch ci ck cl cm cn co cr cu cv cw cx cy cz de dj dk dm do dz ec ee eg er es et eu fi fj fk fm fo fr ga gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk hm hn hr ht hu id ie il im in io iq ir is it je jm jo jp ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mg mh mk ml mm mn mo mp mq mr ms mt mu mv mw mx my mz na nc ne nf ng ni nl no np nr nu nz om pa pe pf pg ph pk pl pm pn pr ps pt pw py qa re ro rs ru rw sa sb sc sd se sg sh si sk sl sm sn so sr ss st su sv sx sy sz tc td tf tg th tj tk tl tm tn to tr tt tv tw tz ua ug uk us uy uz va vc ve vg vi vn vu wf ws ye yt za zm zw";
const GENERIC =
  "com net org edu gov mil int info biz name pro mobi asia tel jobs travel museum coop aero xyz online site shop store tech cloud app dev page blog agency studio design art email link live news website space club top vip life world today digital network systems solutions services group company business global media";
/** The reserved and private endings a fixture or a staging host uses. */
const RESERVED = "test example invalid localhost local internal lan home corp";
const TLDS = [
  ...new Set(
    [
      ...CC.split(" ").filter((c) => !FILE_LIKE.has(c)),
      ...GENERIC.split(" "),
      ...RESERVED.split(" "),
    ].sort((a, b) => b.length - a.length),
  ),
];
/** A run of labels joined by dots. Found in one pass, then each run is judged by its last label (no backtracking). */
const DOTTED_RE = /(?<![a-z0-9_-])[a-z0-9_-]+(?:\.[a-z0-9_-]+)+/g;
const TLD_SET: ReadonlySet<string> = new Set(TLDS);
const LABEL_RE = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;
function hasDomain(text: string): boolean {
  for (const m of text.matchAll(DOTTED_RE)) {
    const labels = m[0].split(".");
    if (
      TLD_SET.has(labels[labels.length - 1]!) &&
      labels.slice(0, -1).every((l) => LABEL_RE.test(l))
    )
      return true;
  }
  return false;
}
const IP_RE =
  /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\d.])/;
// A phone number: a plus and 8 to 15 digits; or digit groups with separators (020 7946 0958, (555) 010-4477,
// 555.010.4477); or a local number with a dash (555-0142). A plain run of digits is a size or an id, not a phone.
const PHONE_RES = [
  /(?<![\w+])\+\d[\d\s().-]{6,17}\d(?!\d)/,
  /(?<![\d.-])\(?\d{2,4}\)?[\s.-]\d{3,4}[\s.-]\d{3,4}(?![\d.-])/,
  /(?<![\d.-])\d{3}[\s.-]\d{4}(?![\d.-])/,
];

/** The kinds of leak one line holds, in LEAK_KINDS order. Works on the line as the assistant-directive check folds it. */
function kindsOnLine(line: string, deny: DenyList | undefined): LeakKind[] {
  const text = normaliseForMatch(line);
  if (text === "") return [];
  const found = new Set<LeakKind>();
  // `search` ignores a global pattern's lastIndex, so one pattern serves both the test and the removal.
  let rest = text;
  if (rest.search(URL_RE) !== -1) found.add("url");
  rest = rest.replace(URL_RE, " ");
  if (rest.search(EMAIL_RE) !== -1) found.add("email");
  rest = rest.replace(EMAIL_RE, " ");
  if (hasDomain(rest)) found.add("domain");
  if (IP_RE.test(rest)) found.add("ip");
  if (PHONE_RES.some((re) => re.test(rest))) found.add("phone");
  if (deny?.pattern?.test(text)) found.add("name");
  return LEAK_KINDS.filter((k) => found.has(k));
}

/** Every leak in `text`, line by line (lines from 1; CRLF counts once). Never the text found. */
export function scanForLeaks(text: string, deny?: DenyList): TextLeak[] {
  const leaks: TextLeak[] = [];
  for (const [i, line] of text.split(/\r\n|\r|\n/).entries())
    for (const kind of kindsOnLine(line, deny)) leaks.push({ kind, line: i + 1 });
  return leaks;
}

/** The kinds one line holds. For callers that already split the text and know the line. */
export const leakKindsOnLine = kindsOnLine;
