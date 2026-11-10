/**
 * What a download route's answer is: the status, the headers and the first bytes of the body. Pure
 * functions, no request. The bytes are the fact; a Content-Type is what the route says about them.
 */

/** What the first bytes of a body are. */
export type Sniff =
  | "pdf"
  | "zip"
  | "mp3"
  | "mp4"
  | "gzip"
  | "ogg"
  | "wav"
  | "flac"
  | "sevenzip"
  | "rar"
  | "html"
  | "json"
  | "text"
  | "binary"
  | "empty";

/** Bytes that start a known file. A table: one row per format, matched at an offset. */
const SIGNATURES: readonly { sniff: Sniff; offset: number; bytes: readonly number[] }[] = [
  { sniff: "pdf", offset: 0, bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  { sniff: "zip", offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] }, // PK\3\4: zip, docx, xlsx, epub
  { sniff: "zip", offset: 0, bytes: [0x50, 0x4b, 0x05, 0x06] }, // an empty zip
  { sniff: "mp3", offset: 0, bytes: [0x49, 0x44, 0x33] }, // ID3
  { sniff: "mp3", offset: 0, bytes: [0xff, 0xfb] }, // MPEG frame sync
  { sniff: "mp3", offset: 0, bytes: [0xff, 0xf3] },
  { sniff: "mp3", offset: 0, bytes: [0xff, 0xf2] },
  { sniff: "mp4", offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] }, // ftyp
  { sniff: "gzip", offset: 0, bytes: [0x1f, 0x8b] },
  { sniff: "ogg", offset: 0, bytes: [0x4f, 0x67, 0x67, 0x53] }, // OggS
  { sniff: "wav", offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF
  { sniff: "flac", offset: 0, bytes: [0x66, 0x4c, 0x61, 0x43] }, // fLaC
  { sniff: "sevenzip", offset: 0, bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] },
  { sniff: "rar", offset: 0, bytes: [0x52, 0x61, 0x72, 0x21] }, // Rar!
];

function startsWith(data: Uint8Array, offset: number, sig: readonly number[]): boolean {
  if (data.byteLength < offset + sig.length) return false;
  return sig.every((b, i) => data[offset + i] === b);
}

/** The first bytes with a byte order mark and leading white space taken off, as lower case text. */
function leadingText(data: Uint8Array): string {
  let start = 0;
  if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) start = 3;
  return Buffer.from(data.subarray(start, Math.min(data.byteLength, start + 512)))
    .toString("latin1")
    .trimStart()
    .toLowerCase();
}

const HTML_START =
  /^(?:<!doctype\s+html|<!--|<\?xml|<(?:html|head|body|title|meta|link|script|style|div|span|p|h[1-6]|a|form|main|section|header|nav|ul|table|iframe|img|center|br|!\[cdata)[\s>/])/;

/** Bytes that are text: no NUL and no control characters other than tab, line feed and carriage return. */
function isText(data: Uint8Array): boolean {
  const n = Math.min(data.byteLength, 512);
  for (let i = 0; i < n; i++) {
    const b = data[i] ?? 0;
    if (b === 0 || (b < 32 && b !== 9 && b !== 10 && b !== 13)) return false;
  }
  return true;
}

/** What the first bytes of a body are: a known file, HTML, JSON, other text, other binary, or nothing. */
export function sniff(data: Uint8Array): Sniff {
  if (data.byteLength === 0) return "empty";
  for (const s of SIGNATURES) if (startsWith(data, s.offset, s.bytes)) return s.sniff;
  const text = leadingText(data);
  if (HTML_START.test(text)) return "html";
  if (text.startsWith("{") || text.startsWith("[")) return isText(data) ? "json" : "binary";
  return isText(data) ? "text" : "binary";
}

const FILE_SNIFFS: ReadonlySet<Sniff> = new Set([
  "pdf",
  "zip",
  "mp3",
  "mp4",
  "gzip",
  "ogg",
  "wav",
  "flac",
  "sevenzip",
  "rar",
]);

/** Content types that say "this is a file". Images are left out on purpose: they are not what people sell. */
const FILE_TYPES: ReadonlySet<string> = new Set([
  "application/pdf",
  "application/zip",
  "application/x-zip-compressed",
  "application/x-zip",
  "application/octet-stream",
  "application/force-download",
  "application/x-download",
  "application/download",
  "application/epub+zip",
  "application/gzip",
  "application/x-gzip",
  "application/x-tar",
  "application/x-7z-compressed",
  "application/vnd.rar",
  "application/x-rar-compressed",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "text/csv",
  "application/csv",
]);

/** The media type of a Content-Type, lower case, without parameters. */
function mediaType(headers: Readonly<Record<string, string>>): string {
  return (headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

function isFileType(type: string): boolean {
  return (
    FILE_TYPES.has(type) ||
    type.startsWith("audio/") ||
    type.startsWith("video/") ||
    type.startsWith("application/vnd.openxmlformats-officedocument.") ||
    type.startsWith("application/vnd.oasis.opendocument.")
  );
}

/** Content-Disposition: attachment (RFC 6266). "inline" and a missing header are not. */
function isAttachment(headers: Readonly<Record<string, string>>): boolean {
  return /^\s*attachment\b/i.test(headers["content-disposition"] ?? "");
}

/**
 * The words of a login address: log in, sign in, auth, sso, account, session, as a whole word of the
 * path ("/blog/logins-explained" is not one), or a sign-in host of an identity provider.
 */
const LOGIN_PATH =
  /(?:^|[/._-])(?:log-?in|sign-?in|sign_in|signon|sso|auth|authenticate|account|session)(?:[/._-]|$)/i;
const LOGIN_HOST =
  /^(?:login|auth|accounts|signin|sso|id|identity)\.|\.(?:auth0\.com|okta\.com|oktapreview\.com|clerk\.accounts\.dev|b2clogin\.com|kinde\.com|stytch\.com)$/i;

/** Does this address, as a redirect points at it, lead to a login or sign-in page? */
export function isLoginAddress(location: string, base?: string): boolean {
  let u: URL;
  try {
    u = new URL(location, base ?? "https://site.invalid/");
  } catch {
    return false;
  }
  let path = u.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep the path as written
  }
  return LOGIN_PATH.test(path) || LOGIN_HOST.test(u.hostname);
}

/** What a download route's answer is. */
export type Verdict =
  /** The file would be handed over: status 200 and the bytes are a file. */
  | { kind: "open"; status: number; contentType: string }
  /** A 200 HTML page: a login page or a message, not the file. */
  | { kind: "page" }
  /** 401, 403, 404 or another 4xx: the route refused. */
  | { kind: "refused"; status: number }
  /** A redirect. `toLogin` when it points at a sign-in address; otherwise the caller may follow it once. */
  | { kind: "redirect"; location: string; toLogin: boolean }
  /** A 200 that is not a file (JSON, text, nothing), a 204, or any other answer that hands nothing over. */
  | { kind: "other"; status: number }
  /** The route did not give an answer to judge: a server error, "slow down", a redirect to nowhere. */
  | { kind: "unclear"; status: number };

const REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * Classify what a route answered to a request with no session and no purchase. `firstBytes` is the
 * start of the body (up to 1,024 bytes), or what `sniff` already made of it. Header names are lower case.
 *
 * It is a file when the status is 200, the route says so (a file Content-Type or an attachment) and
 * the bytes agree: a known file signature, or any bytes that are not HTML, not JSON or plain text
 * (those only count with an attachment header or text/csv), and not empty. The bytes win over the
 * header: an octet-stream whose body is a "please sign in" page is a page.
 */
export function classify(
  status: number,
  headers: Readonly<Record<string, string>>,
  firstBytes: Uint8Array | Sniff,
  base?: string,
): Verdict {
  if (REDIRECTS.has(status)) {
    const to = (headers.location ?? "").trim();
    if (to === "") return { kind: "unclear", status };
    let absolute = to;
    try {
      absolute = new URL(to, base).href;
    } catch {
      // keep it as the route wrote it
    }
    return { kind: "redirect", location: absolute, toLogin: isLoginAddress(to, base) };
  }
  if (status === 429 || status >= 500) return { kind: "unclear", status };
  if (status >= 400) return { kind: "refused", status };
  if (status !== 200) return { kind: "other", status };

  const seen = typeof firstBytes === "string" ? firstBytes : sniff(firstBytes);
  if (seen === "html") return { kind: "page" };
  const type = mediaType(headers);
  const attachment = isAttachment(headers);
  if (!attachment && !isFileType(type)) return { kind: "other", status };
  if (seen === "empty") return { kind: "other", status };
  const isOpen =
    FILE_SNIFFS.has(seen) ||
    seen === "binary" ||
    // Text and JSON are a file only when the route says so loudly: an error body is text too.
    ((seen === "text" || seen === "json") && (attachment || type === "text/csv"));
  return isOpen
    ? { kind: "open", status, contentType: type === "" ? "unknown" : type }
    : { kind: "other", status };
}
