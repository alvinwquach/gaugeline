import { defineCheck, type Finding } from "../../model.js";
import type { LocalSourceInput } from "../../local-source/run.js";
import {
  helperCall,
  lineOf,
  operandAfter,
  operandBefore,
  sourceUrl,
  unreadReason,
  webhookHandlers,
  type HandlerFile,
} from "./source-scan.js";

// [docs] node@22.12.0 > crypto.timingSafeEqual(a, b) ("using a constant-time algorithm"; "must have the same byte length. An error is thrown if a and b have different byte lengths") - https://raw.githubusercontent.com/nodejs/node/v22.12.0/doc/api/crypto.md
// [docs] @sanity/webhook@4.0.4 > src/signature.ts, assertValidSignature (`if (signature !== encoded)`, a plain comparison) - https://raw.githubusercontent.com/sanity-io/webhook-toolkit/649f5adcd8e9d45f73172b05870863b299ba9bc9/src/signature.ts (the commit npm records as gitHead of 4.0.4)
// [GC] no source found (uncited): that a plain comparison of a signature can be timed to learn the secret. It is the owner's reason for the check; the text says "can" and does not state a measured attack.

/** A name that says the value is a signature or a shared secret. */
const SIGNATURE_LIKE = /sig|hmac|digest|hash|secret|token/i;
/** An operand that is not a signature compared with another: a literal, a length, a type, a yes or no. */
const NOT_A_COMPARE =
  /^(?:undefined|null|true|false|-?\d[\d_.]*|["'`].*["'`]|)$|\.length\b|^typeof\b|\bisValid\w*|\bvalid\w*/i;

const OPERATOR = /(?<![=!<>])(===|!==|==|!=)(?!=)/g;

export const webhookSignatureComparedPlainly = defineCheck<LocalSourceInput>({
  id: "webhook-signature-compared-plainly",
  size: "S",
  done: "The receiver compares the signature with crypto.timingSafeEqual on two buffers of the same length.",
  estimateChanges:
    "A few lines in one route file; larger if the receiver is copied into several routes.",
  area: "Security & email",
  severity: "medium",
  title: "The webhook signature is compared with a plain comparison",
  what: "The code that receives a Sanity publish webhook compares the signature (or a shared secret) with ===, !==, == or !=, instead of a constant-time comparison.",
  why: "A plain comparison stops at the first character that differs, so how long it takes can tell a caller how much of a guess was right. A constant-time comparison takes the same time whatever the input. The official @sanity/webhook helper, read in its source at 4.0.4, itself compares with a plain `!==`, so using it is reported as advice, not as a failure.",
  fix: "Compare with crypto.timingSafeEqual on two Buffers, after checking their lengths are equal (timingSafeEqual throws when they differ, so return a 401 first).",
  tech: "reads the code files of the folder named, never runs them; a receiver is a file that imports @sanity/webhook or next-sanity/webhook, reads the sanity-webhook-signature header, or is a route that revalidates behind a secret; a finding is a ===, !==, == or != with a signature, hmac, digest, hash, secret or token on one side and something that is not a literal, a length, a type test or a yes-or-no on the other; timingSafeEqual in the file passes; the official helper alone is an advice finding (worth knowing) and not a failure; a receiver with none of these is could-not-check; the finding names the file and the line, never the values",
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
        checkId: "webhook-signature-compared-plainly",
        severity,
        title: this.title,
        evidence: `${h.path}:${line}: ${text}`,
        url,
        source: { file: h.path, line },
      };
    };
    for (const h of webhookHandlers(input)) {
      const { bare } = h.scanned;
      const plain: number[] = [];
      for (const m of bare.matchAll(OPERATOR)) {
        const left = operandBefore(bare, m.index);
        const right = operandAfter(bare, m.index + (m[1] ?? "").length);
        const sigLeft = SIGNATURE_LIKE.test(left) && !NOT_A_COMPARE.test(left);
        const sigRight = SIGNATURE_LIKE.test(right) && !NOT_A_COMPARE.test(right);
        if ((sigLeft && !NOT_A_COMPARE.test(right)) || (sigRight && !NOT_A_COMPARE.test(left)))
          plain.push(m.index);
      }
      if (plain.length > 0) {
        for (const at of plain)
          out.push(make(h, at, "medium", "the signature is compared with a plain comparison."));
        continue;
      }
      if (/\btimingSafeEqual\s*\(/.test(bare)) continue;
      const helper = helperCall(bare);
      if (helper !== null) {
        out.push(
          make(
            h,
            helper.index,
            "low",
            "this receiver uses the official verification helper, which compares signatures with a plain comparison (read in @sanity/webhook 4.0.4). Advice, not a failure.",
          ),
        );
        continue;
      }
      ctx.couldNotCheck?.(
        url,
        `${h.path} has no signature comparison Gaugeline can read; it may be in a module it did not match.`,
      );
    }
    const unread = unreadReason(input);
    if (out.length === 0 && unread !== undefined) ctx.couldNotCheck?.(url, unread);
    return out;
  },
});
