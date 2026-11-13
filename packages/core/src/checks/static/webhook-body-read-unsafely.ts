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

// [docs] @sanity/webhook@4.0.4 > src/signature.ts, jsdoc (the payload "should be straight from the request, not a re-encoded JSON string") - https://raw.githubusercontent.com/sanity-io/webhook-toolkit/649f5adcd8e9d45f73172b05870863b299ba9bc9/src/signature.ts
// [docs] @sanity/webhook > README, Next.js example ("Next.js will by default parse the body, which can lead to invalid signatures"; the example turns bodyParser off) - https://raw.githubusercontent.com/sanity-io/webhook-toolkit/main/README.md (main when read)
// [GC] no source found (uncited): that a webhook body should have a size cap (memory abuse). It is the owner's reason for the check; the text says "can".

/** The request is read as parsed JSON, not as the raw text the signature is over. */
const PARSED = /\b(?:req|request)\s*\.\s*json\s*\(\s*\)/;
/** The request is read as raw text or bytes. */
const RAW =
  /\b(?:req|request)\s*\.\s*(?:text|arrayBuffer|blob)\s*\(\s*\)|\bgetRawBody\s*\(|\bgetReader\s*\(/;
/** Evidence of a size limit before the body is read in full: the content-length header, a stream counted as it is read, or a `limit` option. */
const CAP = /["'`]content-length["'`]|\bgetReader\s*\(|\blimit\s*:/i;
/** Where the signature is checked. */
const VERIFY =
  /\bcreateHmac\s*\(|\btimingSafeEqual\s*\(|\b(?:isValidSignature|assertValidSignature|isValidRequest|assertValidRequest)\s*[<(]/;

export const webhookBodyReadUnsafely = defineCheck<LocalSourceInput>({
  id: "webhook-body-read-unsafely",
  size: "S",
  done: "The receiver checks the size, reads the raw body, checks the signature over it, and only then parses it.",
  estimateChanges:
    "A few lines in one route file; larger if the receiver is a pages/api route that must turn the body parser off.",
  area: "Security & email",
  severity: "medium",
  title: "The webhook body is parsed before its signature is checked, or read with no size limit",
  what: "The code that receives a Sanity publish webhook parses the body (req.json(), or Next's parsed req.body) before the signature is checked over the raw body, or reads the whole body with no size limit.",
  why: "The signature is over the raw bytes the sender sent, and the helper's documentation says to pass it the payload straight from the request, not a re-encoded JSON string. Parsing first and signing the re-encoded value can make a valid delivery fail, or hide a difference between what was signed and what is used. A body read in full with no size limit can be made to use a lot of memory by anyone who sends one, before the signature is looked at.",
  fix: "Check the Content-Length header against a limit (64 KB is plenty for a publish), read the body once as text with req.text(), check the signature over that text, and only then JSON.parse it. In a pages/api route, export config with api.bodyParser set to false.",
  tech: "reads the code files of the folder named, never runs them; a receiver is a file that imports @sanity/webhook or next-sanity/webhook, reads the sanity-webhook-signature header, or is a route that revalidates behind a secret; req.json() with no raw read, or JSON.parse before the first signature step, or req.body in a pages/api route without bodyParser false, is a finding; a raw read or the helper's parseBody with no content-length check, stream reader or limit option is a finding; a receiver with neither a body read nor the helper is could-not-check; the finding names the file and the line, never the body",
  run(input, ctx) {
    const url = sourceUrl(input);
    const out: Finding[] = [];
    const make = (h: HandlerFile, index: number, text: string): Finding => {
      const line = lineOf(h.scanned.bare, index);
      return {
        checkId: "webhook-body-read-unsafely",
        severity: "medium",
        title: this.title,
        evidence: `${h.path}:${line}: ${text}`,
        url,
        source: { file: h.path, line },
      };
    };
    for (const h of webhookHandlers(input)) {
      const { bare, code } = h.scanned;
      const parsed = PARSED.exec(bare);
      const raw = RAW.exec(bare);
      const helper = /\bparseBody\s*[<(]/.exec(bare) ?? helperCall(bare);
      const verify = VERIFY.exec(bare);
      const pagesBody = /(?:^|\/)pages\/api\//.test(h.path)
        ? /\b(?:req|request)\s*\.\s*body\b/.exec(bare)
        : null;
      const before = verify === null ? bare.length : verify.index;
      const jsonParse = /\bJSON\s*\.\s*parse\s*\(/.exec(bare);
      let found = 0;
      if (parsed !== null && raw === null) {
        out.push(
          make(
            h,
            parsed.index,
            "the body is parsed with req.json(), so the signature cannot be checked over the raw body.",
          ),
        );
        found++;
      } else if (jsonParse !== null && jsonParse.index < before && verify !== null) {
        out.push(
          make(
            h,
            jsonParse.index,
            "the body is parsed with JSON.parse before the signature is checked.",
          ),
        );
        found++;
      }
      if (pagesBody && !/\bbodyParser\s*:\s*false\b/.test(code)) {
        out.push(
          make(
            h,
            pagesBody.index,
            "Next parses the body of this route (req.body) before the signature can be checked over the raw body.",
          ),
        );
        found++;
      }
      const reads = raw ?? parsed ?? helper;
      if (reads !== null && !CAP.test(code)) {
        out.push(make(h, reads.index, "the body is read in full with no size limit."));
        found++;
      }
      if (found === 0 && reads === null && pagesBody === null)
        ctx.couldNotCheck?.(
          url,
          `${h.path} reads no request body Gaugeline can see; it may be read in a module it did not match.`,
        );
    }
    const unread = unreadReason(input);
    if (out.length === 0 && unread !== undefined) ctx.couldNotCheck?.(url, unread);
    return out;
  },
});
