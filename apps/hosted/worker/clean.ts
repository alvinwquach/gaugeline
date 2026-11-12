/**
 * What the worker does to page text before it is stored (M2, M4). A site chooses its own words, so a
 * title, an evidence line, an address or a reason can hold a key-shaped string or a NUL byte. The runs
 * API refuses such an upload; for a night the worker made itself that would stop the site's monitoring
 * every night, by something a stranger posted on the page. So the worker cleans instead: the string is
 * made safe (N17: no control, bidi or tag characters, a length cap), anything the secret scan matches is
 * replaced by a fixed placeholder, and the finding stays. The scan itself is core's and is not loosened:
 * a last scan of the whole upload still refuses it (toUpload).
 *
 * Nothing here logs, returns or counts by value: the matched text goes nowhere, only how many fields
 * were touched.
 */
import { DETECTORS, keyPatterns, sanitise, secretsInValue, UNTRUSTED_CAPS } from "@gaugeline/core";
import type { Upload } from "../lib/api/schema.js";

/** Stands where a secret-shaped string was. */
export const REMOVED = "[removed]";
/** Stands where a title that cannot be shown was. */
const TITLE_REMOVED = "(title removed)";
/** The most characters of an address kept (the table's limit). */
const URL_CAP = 2048;
/** The most characters of a could-not-check reason the summary keeps. */
const REASON_CAP = 200;

type Scan = (value: unknown) => string[];

/** `value` with U+0000 taken out of every string and object key. */
export function stripNul<T>(value: T): T {
  const nul = new RegExp(String.fromCharCode(0), "g");
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return v.replace(nul, "");
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === "object" && v !== null && Object.getPrototypeOf(v) === Object.prototype)
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k.replace(nul, ""), walk(x)]));
    return v;
  };
  return walk(value) as T;
}

/**
 * `text` with every substring the secret scan would match replaced by REMOVED: core's key shapes (not the
 * generic one, which the scan leaves out too) and the leak detectors, each with its own verify step.
 */
export function scrubSecrets(text: string): { text: string; removed: number } {
  const spans: [number, number][] = [];
  for (const k of keyPatterns()) {
    if (k.name === "generic-secret") continue;
    for (const m of text.matchAll(k.pattern)) spans.push([m.index, m.index + m[0].length]);
  }
  for (const d of DETECTORS) {
    for (const m of text.matchAll(new RegExp(d.pattern.source, d.pattern.flags))) {
      const secret = m.groups?.secret;
      if (!secret || (d.verify && !d.verify(secret, m))) continue;
      const start = m.index + m[0].indexOf(secret);
      spans.push([start, start + secret.length]);
    }
  }
  if (spans.length === 0) return { text, removed: 0 };
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let out = "";
  let at = 0;
  let removed = 0;
  for (const [from, to] of spans) {
    if (from < at) {
      at = Math.max(at, to);
      continue;
    }
    out += text.slice(at, from) + REMOVED;
    at = to;
    removed += 1;
  }
  return { text: out + text.slice(at), removed };
}

/** Page text made safe to store: N17 first (so hidden characters cannot join a key together), then the scrub. */
function cleanText(raw: string, cap: number): { text: string; touched: boolean } {
  let text: string = sanitise(raw, cap).text;
  let touched = false;
  // A replacement can only shorten the text; two rounds settle a match made of the pieces of another.
  for (let round = 0; round < 2; round++) {
    const s = scrubSecrets(text);
    if (s.removed === 0) break;
    text = s.text;
    touched = true;
  }
  return { text, touched };
}

/** Stands where a could-not-check reason that cannot be shown was. */
const REASON_REMOVED = "(reason removed)";

/**
 * The result with the limits the runs API enforces already met, BEFORE parseUpload checks them: an
 * address over the table's limit is cut, and a title that is empty (or only blanks) gets a fixed one. Both
 * are page text a stranger chose; refusing the run over them would stop the site's monitoring every night.
 */
export function fitLimits<R extends { findings: { title: string; url: string }[] }>(result: R): R {
  return {
    ...result,
    findings: result.findings.map((f) => ({
      ...f,
      title: f.title.replace(/\s+/g, " ").trim() === "" ? TITLE_REMOVED : f.title,
      url: f.url.length > URL_CAP ? f.url.slice(0, URL_CAP) : f.url,
    })),
  };
}

/** A could-not-check reason, cleaned like the rest of the page text. */
export function cleanReason(reason: string): { text: string; touched: boolean } {
  return cleanText(reason, REASON_CAP);
}

/**
 * Cleans every field of the upload's findings that can hold page text (title, evidence, address), in
 * place; the fingerprint, taken from the finding as core made it, is kept. A finding whose fields still
 * trip `scan` after cleaning keeps its title (or gets a fixed one) and loses its evidence and address.
 * Returns how many fields were changed because of a secret shape or dropped.
 */
export function cleanFindings(upload: Upload, scan: Scan = secretsInValue): number {
  let fields = 0;
  upload.findings = upload.findings.map((f) => {
    const title = cleanText(f.title, UNTRUSTED_CAPS.title);
    const evidence = cleanText(f.evidence, UNTRUSTED_CAPS.evidence);
    const url = cleanText(f.url, URL_CAP);
    fields += Number(title.touched) + Number(evidence.touched) + Number(url.touched);
    const out = {
      ...f,
      title: title.text === "" ? TITLE_REMOVED : title.text,
      evidence: evidence.text,
      url: url.text,
    };
    if (scan({ title: out.title, evidence: out.evidence, url: out.url }).length === 0) return out;
    fields += 1;
    return {
      ...out,
      title: scan({ title: out.title }).length === 0 ? out.title : TITLE_REMOVED,
      evidence: "",
      url: upload.url,
    };
  });
  return fields;
}

/** The could-not-check entries of an upload's summary, as the runs API builds them. */
function reasonsOf(upload: Upload): { id: string; reason: string }[] {
  const list = upload.summary.couldNotCheck;
  return Array.isArray(list) ? (list as { id: string; reason: string }[]) : [];
}

/**
 * What is left when the last scan (the runs API's: every string of the upload joined) still matches after
 * each field was cleaned on its own. Some core detectors read context from the whole text (a Contentful
 * preview token needs "contentful" somewhere), so a token in one field and its context in another is
 * invisible to the per-field scrub. Rather than refuse the night, the worker drops page text in steps and
 * scans the same joined text again after each: first every finding's evidence and every reason, then every
 * title and address. The findings, their fingerprints and the check ids stay. Returns how many fields it
 * dropped (0 when the upload was clean); it never logs or returns the text. A scan that still matches
 * after both steps is left to the caller to refuse.
 */
export function settleCrossField(upload: Upload, scan: Scan = secretsInValue): number {
  if (scan(upload).length === 0) return 0;
  let dropped = 0;
  for (const f of upload.findings)
    if (f.evidence !== "") {
      f.evidence = "";
      dropped += 1;
    }
  for (const c of reasonsOf(upload))
    if (c.reason !== REASON_REMOVED) {
      c.reason = REASON_REMOVED;
      dropped += 1;
    }
  if (scan(upload).length === 0) return dropped;
  for (const f of upload.findings) {
    if (f.title !== TITLE_REMOVED) {
      f.title = TITLE_REMOVED;
      dropped += 1;
    }
    if (f.url !== upload.url) {
      f.url = upload.url;
      dropped += 1;
    }
  }
  return dropped;
}
