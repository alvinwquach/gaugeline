/**
 * The draft's message, built by small pure functions (RFC 5322 for the headers, RFC 2045 for the base64
 * body, RFC 2047 for a non-ASCII subject) and returned as the base64url `raw` text Gmail's drafts.create
 * takes. The same input is the same bytes: there is no Date, no Message-ID and no From, so Gmail fills
 * them in when the person opens the draft. There are exactly four headers besides MIME-Version, and no
 * Cc, Bcc or Reply-To exists to be added.
 *
 * Header injection is refused, not escaped: a CR, LF or other line break, a control character or a
 * bidirectional control in the subject or a recipient is an error, and a recipient is a bare address
 * (no display name, no quotes, no comment, no second address).
 *
 * `readRaw` is the inverse, for the registry: it reads only what `buildRaw` writes, so a request that
 * says anything else (an extra header, a folded To line) is refused.
 *
 * Specs: RFC 5322 (https://www.rfc-editor.org/rfc/rfc5322), RFC 2045 (https://www.rfc-editor.org/rfc/rfc2045),
 * RFC 2047 (https://www.rfc-editor.org/rfc/rfc2047) [docs].
 */
export class MimeError extends Error {}

export interface MailParts {
  to: readonly string[];
  subject: string;
  body: string;
}

export const MAX_RECIPIENTS = 5;
const ATEXT = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]";
const LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";
const ADDRESS = new RegExp(`^${ATEXT}+(?:\\.${ATEXT}+)*@${LABEL}(?:\\.${LABEL})+$`);

/** True for a bare ASCII address: dot-atom local part, a dotted domain, at most 254 characters. */
export function isPlainAddress(address: unknown): address is string {
  return typeof address === "string" && address.length <= 254 && ADDRESS.test(address);
}

/**
 * Line breaks (CR, LF, NEL, LS, PS), C0 and C1 controls, and everything a person cannot see in a subject:
 * Unicode format characters (category Cf: zero-width space, joiners, the byte order mark, soft hyphen,
 * word joiner, invisible operators and the bidirectional controls) and the tag characters (U+E0000 block).
 */
/* eslint-disable no-control-regex -- the point is to find control characters */
const HEADER_BAD = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cf}\u{E0000}-\u{E007F}\uFFFE\uFFFF]/u;
const BODY_BAD = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/u;
/* eslint-enable no-control-regex */

/**
 * The most the recipients may take in the To line (joined with ", "). RFC 5322 allows 998 characters in a
 * line; five addresses of 253 characters would pass it, so the writer refuses a list this long and does not fold.
 */
export const MAX_TO_LENGTH = 900;

const CRLF = "\r\n";

/** RFC 2047 "B" encoded words of at most 75 characters, one per folded line, cut between characters. */
function encodedWords(subject: string): string {
  const words: string[] = [];
  let chunk = "";
  const flush = () => {
    if (chunk !== "") words.push(`=?UTF-8?B?${Buffer.from(chunk, "utf8").toString("base64")}?=`);
    chunk = "";
  };
  for (const ch of subject) {
    // 45 bytes of UTF-8 are 60 base64 characters, plus 12 for the frame: 72 characters.
    if (Buffer.byteLength(chunk + ch, "utf8") > 45) flush();
    chunk += ch;
  }
  flush();
  return words.join(`${CRLF} `);
}

/** The Subject header's value: plain when it is short printable ASCII, else encoded words. */
function subjectValue(subject: string): string {
  const plain =
    /^[!-~](?:[ -~]*[!-~])?$/.test(subject) && subject.length <= 60 && !subject.includes("=?");
  return plain ? subject : encodedWords(subject);
}

function check(parts: MailParts): void {
  if (!Array.isArray(parts.to) || parts.to.length < 1 || parts.to.length > MAX_RECIPIENTS)
    throw new MimeError(`a draft has 1 to ${MAX_RECIPIENTS} recipients`);
  for (const a of parts.to)
    if (!isPlainAddress(a)) throw new MimeError("a recipient is not a plain address");
  if (parts.to.join(", ").length > MAX_TO_LENGTH)
    throw new MimeError("the recipients do not fit one header line");
  if (typeof parts.subject !== "string" || parts.subject === "" || HEADER_BAD.test(parts.subject))
    throw new MimeError(
      "the subject is empty or has a line break, control, invisible or bidi character",
    );
  if (typeof parts.body !== "string" || BODY_BAD.test(parts.body))
    throw new MimeError("the body has a control character");
}

/** The message text: CRLF line ends, a base64 body wrapped at 76 characters. */
export function buildMessage(parts: MailParts): string {
  check(parts);
  const body = Buffer.from(parts.body.replace(/\r\n?|\n/g, CRLF), "utf8").toString("base64");
  return [
    "MIME-Version: 1.0",
    `To: ${parts.to.join(", ")}`,
    `Subject: ${subjectValue(parts.subject)}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    ...(body.match(/.{1,76}/g) ?? [""]),
  ].join(CRLF);
}

/** The base64url text of the message: Gmail's `message.raw`. */
export function buildRaw(parts: MailParts): string {
  return Buffer.from(buildMessage(parts), "utf8").toString("base64url");
}

/** Read back a message `buildRaw` wrote, or throw: any other shape is a MimeError. */
export function readRaw(raw: string): MailParts {
  if (typeof raw !== "string" || !/^[A-Za-z0-9_-]+$/.test(raw))
    throw new MimeError("raw is not base64url");
  const text = Buffer.from(raw, "base64url").toString("utf8");
  const cut = text.indexOf(`${CRLF}${CRLF}`);
  if (cut < 0 || /(^|[^\r])\n/.test(text)) throw new MimeError("not a message this writer built");
  const head = text.slice(0, cut).split(`${CRLF}`);
  const encoded = text.slice(cut + 4);
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(encoded)) throw new MimeError("the body is not base64");
  // Header lines, with a folded subject joined: only the Subject header may fold, and only with a space.
  const lines: string[] = [];
  for (const l of head) {
    if (l.startsWith(" ") && lines.length > 0 && lines[lines.length - 1]!.startsWith("Subject: ")) {
      lines[lines.length - 1] += `${CRLF}${l}`;
    } else lines.push(l);
  }
  const [mime, to, subject, type, encoding] = lines;
  if (
    lines.length !== 5 ||
    mime !== "MIME-Version: 1.0" ||
    !to?.startsWith("To: ") ||
    !subject?.startsWith("Subject: ") ||
    type !== 'Content-Type: text/plain; charset="UTF-8"' ||
    encoding !== "Content-Transfer-Encoding: base64"
  )
    throw new MimeError("not a message this writer built");
  const parts: MailParts = {
    to: to.slice(4).split(", "),
    subject: decodeSubject(subject.slice(9)),
    body: Buffer.from(encoded.replace(/\r\n/g, ""), "base64").toString("utf8"),
  };
  // A message that does not rebuild to the same bytes is not one this writer built.
  if (buildRaw(parts) !== raw) throw new MimeError("not a message this writer built");
  return parts;
}

function decodeSubject(value: string): string {
  if (!value.startsWith("=?UTF-8?B?")) return value;
  return value
    .split(`${CRLF} `)
    .map((w) => {
      const m = /^=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=$/.exec(w);
      if (!m) throw new MimeError("not a message this writer built");
      return Buffer.from(m[1]!, "base64").toString("utf8");
    })
    .join("");
}
