import { defineCheck, type Finding } from "../../model.js";
import type { LocalSourceInput } from "../../local-source/run.js";
import {
  conditions,
  lineOf,
  sourceUrl,
  unreadReason,
  webhookHandlers,
  type HandlerFile,
} from "./source-scan.js";

// [docs] next-sanity@13.4.0 > webhook parseBody ("If no secret is provided then no validation is done on the signature, and it'll return `null`") - https://raw.githubusercontent.com/sanity-io/next-sanity/main/packages/next-sanity/src/webhook/index.ts (read on main, the 13.4.0 tag was not read)
// [GC] no source found (uncited): that a sender retries a 5xx and gives up on a 4xx. Sanity's webhook documentation was not reachable, so the check text does not state it as fact.

/** Environment variables a webhook secret is usually kept in. */
const SECRET_NAME = /SECRET|SIGNING|WEBHOOK/i;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The ways the file names its secret: `process.env.NAME`, or a variable it was copied into. */
function secretRefs(bare: string): string[] {
  const refs = new Set<string>();
  for (const m of bare.matchAll(/process\.env\.([A-Za-z0-9_]+)/g))
    if (SECRET_NAME.test(m[1] ?? "")) refs.add(`process.env.${m[1]}`);
  for (const m of bare.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*process\.env\.([A-Za-z0-9_]+)/g))
    if (SECRET_NAME.test(m[1] ?? "") || SECRET_NAME.test(m[2] ?? "")) refs.add(m[1] ?? "");
  for (const m of bare.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*process\.env\b/g))
    for (const name of (m[1] ?? "").split(","))
      if (SECRET_NAME.test(name))
        refs.add(name.split(":").pop()?.trim().split("=")[0]?.trim() ?? "");
  refs.delete("");
  return [...refs];
}

type Outcome = { kind: "status"; code: number } | { kind: "unreadable" };

/** What a branch answers: the status it names, a throw (a 500), or a bare response (a 200). */
function answer(body: string): Outcome {
  const named =
    /\bstatus\s*:\s*(\d{3})\b/.exec(body) ??
    /\.status\(\s*(\d{3})\s*\)/.exec(body) ??
    /\.(?:sendStatus|writeHead)\(\s*(\d{3})\b/.exec(body);
  if (named !== null) return { kind: "status", code: Number(named[1]) };
  if (/\bstatus\s*:\s*[A-Za-z_$(]|\.status\(\s*[A-Za-z_$]/.test(body))
    return { kind: "unreadable" };
  if (/\bthrow\b/.test(body)) return { kind: "status", code: 500 };
  if (/\breturn\b/.test(body)) return { kind: "status", code: 200 };
  return { kind: "unreadable" };
}

export const webhookMissingSecretStatus = defineCheck<LocalSourceInput>({
  id: "webhook-missing-secret-status",
  size: "S",
  done: "When the webhook secret is not set, the receiver answers with a 500 (or throws) before it looks at the request.",
  estimateChanges:
    "One branch in one route file; it is larger if the receiver is copied into several routes.",
  area: "Security & email",
  severity: "high",
  title: "A missing webhook secret is answered with the wrong status",
  what: "The code that receives a Sanity publish webhook answers a request with a 4xx or a 2xx status when its secret is not set, or lets the null that next-sanity returns for a missing secret through.",
  why: "With no secret set the receiver cannot tell a real publish from anyone's request. A 200 accepts every request. A 4xx tells the sender the request itself was wrong, and senders generally treat that as a delivery that will not succeed on a retry, so publishes can stop reaching the site until someone notices; a 5xx says the receiver is at fault, which is the status a sender is expected to retry. (Gaugeline has not confirmed Sanity's own retry rules from its documentation.) next-sanity's parseBody returns null for isValidSignature when no secret is passed, so a test written as `=== false` lets that request through.",
  fix: "Where the secret is read from the environment, return a 500 (or throw) when it is missing, before the signature is looked at, and log that the secret is not set. With parseBody, test `isValidSignature !== true` instead of `=== false`.",
  tech: "reads the code files of the folder named, never runs them; a receiver is a file that imports @sanity/webhook or next-sanity/webhook, reads the sanity-webhook-signature header, or is a route that revalidates behind a secret; the branch taken when the secret read from process.env is missing is an if that tests it; a status option, .status() or a throw is the answer (a bare response is 200); 5xx passes, any other status is a finding; parseBody tested with === false and no such branch is a finding; no branch, a status that is not a number or a receiver that reads no secret is could-not-check; the finding names the file, the line and the status, never the secret, the body or an id",
  run(input, ctx) {
    const url = sourceUrl(input);
    const handlers = webhookHandlers(input);
    const out: Finding[] = [];
    const unsure = (reason: string): void => ctx.couldNotCheck?.(url, reason);
    const finding = (h: HandlerFile, index: number, evidence: string): Finding => {
      const line = lineOf(h.scanned.bare, index);
      return {
        checkId: "webhook-missing-secret-status",
        severity: "high",
        title: this.title,
        evidence: `${h.path}:${line}: ${evidence}`,
        url,
        source: { file: h.path, line },
      };
    };
    for (const h of handlers) {
      const { bare } = h.scanned;
      const refs = secretRefs(bare);
      if (refs.length === 0) {
        unsure(
          `${h.path} reads no secret from process.env, so Gaugeline cannot tell what it answers when the secret is missing.`,
        );
        continue;
      }
      const ref = refs.map(escapeRe).join("|");
      const missing = new RegExp(
        `(?:^|\\|\\|)\\s*(?:!\\s*(?:${ref})\\b(?!\\s*[.(\\[])|(?:${ref})\\s*(?:===|==)\\s*(?:undefined|null|["'\`]\\s*["'\`])|typeof\\s+(?:${ref})\\s*(?:===|==)\\s*["'\`]undefined["'\`])`,
      );
      const guard = conditions(bare).find((c) => missing.test(c.cond));
      if (guard !== undefined) {
        const said = answer(guard.body);
        if (said.kind === "unreadable") {
          unsure(
            guard.body.includes("status")
              ? `${h.path} answers a missing secret with a status Gaugeline cannot read as a number.`
              : `${h.path} answers a missing secret in a way Gaugeline cannot read.`,
          );
        } else if (said.code < 500 || said.code > 599) {
          out.push(
            finding(h, guard.index, `a missing webhook secret is answered with ${said.code}.`),
          );
        }
        continue;
      }
      const nullPass = /\bisValidSignature\s*===\s*false\b/.exec(bare);
      if (nullPass !== null && /\bparseBody\s*[<(]/.test(bare)) {
        out.push(
          finding(
            h,
            nullPass.index,
            "with no secret parseBody returns null, and this test lets null through.",
          ),
        );
        continue;
      }
      unsure(
        `${h.path} has no branch for a missing secret, so Gaugeline cannot tell what it answers.`,
      );
    }
    const unread = unreadReason(input);
    if (out.length === 0 && unread !== undefined) unsure(unread);
    return out;
  },
});
