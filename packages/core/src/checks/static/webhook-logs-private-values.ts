import { defineCheck, type Finding } from "../../model.js";
import type { LocalSourceInput } from "../../local-source/run.js";
import { closeOf, lineOf, sourceUrl, unreadReason, webhookHandlers } from "./source-scan.js";

// [GC] no source found (uncited): a webhook receiver's logs should not hold the request body, a document id or a secret. It is a code-hygiene rule with no framework behaviour behind it, so the check text states it as the check's rule, not as a fact about a platform.

/** A call that writes a log line: the console, or a logger object by its usual names. */
const LOG_CALL = /\b(?:console|logger|log)\s*\.\s*(?:log|info|warn|error|debug|trace)\s*\(/g;

/** What a log line must not carry, by what it is called in the code: each is named in the finding, never shown. */
const KINDS: readonly { kind: string; re: RegExp }[] = [
  {
    kind: "the request body",
    re: /\b(?:body|rawBody|raw|payload)\b(?!\s*[.[])|\b(?:req|request)\s*\.\s*(?:body|text|json)\b/,
  },
  { kind: "a document id", re: /\b(?:_id|documentId|docId)\b/ },
  { kind: "the signature", re: /\bsignature\b|sanity-webhook-signature/i },
];

const SECRET_NAME = /SECRET|SIGNING|WEBHOOK/i;

export const webhookLogsPrivateValues = defineCheck<LocalSourceInput>({
  id: "webhook-logs-private-values",
  size: "S",
  done: "The receiver's log lines hold the document type, the status and what happened, and never the body, an id, the signature or the secret.",
  estimateChanges:
    "One or two log lines in one route file; larger if a shared logger prints whole requests.",
  area: "Security & email",
  severity: "medium",
  title: "The webhook receiver writes the body, an id or a secret to its logs",
  what: "The code that receives a Sanity publish webhook writes the request body, a document id, the signature or the secret to a log.",
  why: "Logs are kept, copied to other tools and read by more people than the content or the secret was meant for. A publish body holds the document's content (a clinic's notice, a customer's name in a booking), and a secret in a log is a secret that has leaked.",
  fix: "Log what happened, not what was received: the document type, the status you answered with, a count. If you need to trace one delivery, log a short random id you made up, not Sanity's document id.",
  tech: "reads the code files of the folder named, never runs them; a receiver is a file that imports @sanity/webhook or next-sanity/webhook, reads the sanity-webhook-signature header, or is a route that revalidates behind a secret; the arguments of every console, logger or log call (log, info, warn, error, debug, trace) are read, strings blanked; a name for the body (body, rawBody, payload, req.body), a document id (_id, documentId), the signature, or the secret read from process.env, is a finding that names the kind, the file and the line, never the value; nothing else in the call is printed",
  run(input, ctx) {
    const url = sourceUrl(input);
    const out: Finding[] = [];
    for (const h of webhookHandlers(input)) {
      const { bare } = h.scanned;
      const envNames = [...bare.matchAll(/process\.env\.([A-Za-z0-9_]+)/g)]
        .map((m) => m[1] ?? "")
        .filter((n) => SECRET_NAME.test(n));
      const aliases = [
        ...bare.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*process\.env\.([A-Za-z0-9_]+)/g),
      ]
        .filter((m) => SECRET_NAME.test(m[1] ?? "") || SECRET_NAME.test(m[2] ?? ""))
        .map((m) => m[1] ?? "");
      const secretRe =
        envNames.length + aliases.length === 0
          ? null
          : new RegExp(
              `\\b(?:${[...envNames.map((n) => `process\\.env\\.${n}`), ...aliases].join("|")})\\b`,
            );
      for (const m of bare.matchAll(LOG_CALL)) {
        const open = m.index + m[0].length - 1;
        const close = closeOf(bare, open);
        const args = bare.slice(open + 1, close < 0 ? bare.length : close);
        const kinds = KINDS.filter((k) => k.re.test(args)).map((k) => k.kind);
        if (secretRe?.test(args)) kinds.push("the secret");
        if (kinds.length === 0) continue;
        const line = lineOf(bare, m.index);
        out.push({
          checkId: "webhook-logs-private-values",
          severity: "medium",
          title: this.title,
          evidence: `${h.path}:${line}: a log call includes ${kinds.join(" and ")}.`,
          url,
          source: { file: h.path, line },
        });
      }
    }
    const unread = unreadReason(input);
    if (out.length === 0 && unread !== undefined) ctx.couldNotCheck?.(url, unread);
    return out;
  },
});
