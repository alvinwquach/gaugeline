import { defineCheck, type Finding } from "../../model.js";
import type { LocalSourceInput } from "../../local-source/run.js";
import {
  helperCall,
  lineOf,
  sourceUrl,
  unreadReason,
  webhookHandlers,
  type HandlerFile,
} from "./source-scan.js";

// [docs] @sanity/webhook@4.0.4 > src/signature.ts (the header is `t=<ms>,v1=<signature>`; the signature is an HMAC SHA-256 over `<t>.<body>`; assertValidSignature makes no age check) - https://raw.githubusercontent.com/sanity-io/webhook-toolkit/649f5adcd8e9d45f73172b05870863b299ba9bc9/src/signature.ts
// [GC] no source found (uncited): that a signed timestamp should have an age limit and a future limit. It is the check's premise (a captured request can be replayed); Sanity's webhook documentation was not reachable, so the text does not state it as Sanity's rule.

const NOW = String.raw`(?:Date\.now\s*\(\s*\)|\bnow\b)`;
const VALUE = String.raw`[\w$.]+(?:\([\w$.]*\))?`;
/** The signed timestamp is read: a `t=` in the header's pattern, or a name that says so. */
const DECODES = /(?:^|[^\w])t=|\btimestamp\b|\bsignedAt\b|\bsentAt\b|\bts\b/;
/** Both limits at once: the distance from now, either way. */
const DISTANCE = new RegExp(
  String.raw`Math\.abs\s*\(\s*(?:${NOW}\s*-\s*${VALUE}|${VALUE}\s*-\s*${NOW})\s*\)`,
);
/** The age: now minus the timestamp, compared. */
const AGE = new RegExp(String.raw`${NOW}\s*-\s*${VALUE}\s*[<>]`);
/** The future: the timestamp minus now, or the timestamp against now. */
const FUTURE = new RegExp(String.raw`${VALUE}\s*-\s*${NOW}\s*[<>]|${VALUE}\s*[<>]=?\s*${NOW}\b`);

export const webhookTimestampUnbounded = defineCheck<LocalSourceInput>({
  id: "webhook-timestamp-unbounded",
  size: "S",
  done: "The receiver rejects a signed timestamp that is more than a few minutes old, and one that is in the future.",
  estimateChanges:
    "A few lines in one route file, once the timestamp is read from the header; larger if the receiver only uses the official helper, which hides it.",
  area: "Security & email",
  severity: "medium",
  title: "The webhook's signed timestamp has no age limit",
  what: "The code that receives a Sanity publish webhook reads the signed timestamp but does not reject one that is old, or one that is in the future.",
  why: "The signature covers the timestamp and the body, but a request that was captured once stays valid for as long as nothing compares the timestamp with the time now. Anyone who can capture a delivery can send it again. The official @sanity/webhook helper, read in its source at 4.0.4, makes no age check, so a receiver that only uses it has none, and is reported as advice.",
  fix: "Read t from the signature header, and reject the request with a 401 when Math.abs(Date.now() - t) is more than a few minutes (five is common). Check the signature first, so the rejection does not leak which part was wrong.",
  tech: "reads the code files of the folder named, never runs them; a receiver is a file that imports @sanity/webhook or next-sanity/webhook, reads the sanity-webhook-signature header, or is a route that revalidates behind a secret; a file that reads the timestamp (a t= pattern, or a name such as timestamp or signedAt) and never compares it with Date.now() is a finding; Math.abs of the distance passes; an age test without a future test, or the other way round, is a finding; a file that only uses the official helper is an advice finding (worth knowing); a comparison Gaugeline cannot read, or a receiver with no timestamp and no helper, is could-not-check; the finding names the file and the line, never the values",
  run(input, ctx) {
    const url = sourceUrl(input);
    const out: Finding[] = [];
    const make = (
      h: HandlerFile,
      index: number,
      severity: Finding["severity"],
      text: string,
    ): Finding => {
      const line = lineOf(h.scanned.bare, index);
      return {
        checkId: "webhook-timestamp-unbounded",
        severity,
        title: this.title,
        evidence: `${h.path}:${line}: ${text}`,
        url,
        source: { file: h.path, line },
      };
    };
    for (const h of webhookHandlers(input)) {
      const { bare, code } = h.scanned;
      const read = DECODES.exec(code);
      if (read === null) {
        const helper = helperCall(bare);
        if (helper !== null)
          out.push(
            make(
              h,
              helper.index,
              "low",
              "this receiver uses the official verification helper, which makes no age check (read in @sanity/webhook 4.0.4). Advice, not a failure.",
            ),
          );
        else
          ctx.couldNotCheck?.(
            url,
            `${h.path} reads no signed timestamp Gaugeline can see; it may be in a module it did not match.`,
          );
        continue;
      }
      if (!/\bDate\.now\s*\(|\bnew Date\s*\(|\bnow\b/.test(bare)) {
        out.push(
          make(
            h,
            read.index,
            "medium",
            "the signed timestamp is read but never compared with the time now.",
          ),
        );
        continue;
      }
      if (DISTANCE.test(bare)) continue;
      const past = AGE.exec(bare);
      const future = FUTURE.exec(bare);
      if (past !== null && future !== null) continue;
      if (past !== null)
        out.push(
          make(
            h,
            past.index,
            "medium",
            "the timestamp has an age limit but no limit for one in the future.",
          ),
        );
      else if (future !== null)
        out.push(
          make(
            h,
            future.index,
            "medium",
            "the timestamp has no age limit, only a test against the future.",
          ),
        );
      else
        ctx.couldNotCheck?.(
          url,
          `${h.path} compares something with the time now in a way Gaugeline cannot read as a limit on the timestamp.`,
        );
    }
    const unread = unreadReason(input);
    if (out.length === 0 && unread !== undefined) ctx.couldNotCheck?.(url, unread);
    return out;
  },
});
