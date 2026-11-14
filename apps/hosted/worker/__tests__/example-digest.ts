// check-community: allow-email (invented addresses on the reserved .example and .test domains, for the docs example)
/**
 * The docs example for the digest in the morning email (docs/hosted/morning-email.md): an invented inbox, a
 * local stand-in for Resend on 127.0.0.1, and the real sender. Nothing leaves the machine and no key is real.
 * Run from apps/hosted with `node --import tsx worker/__tests__/example-digest.ts`.
 */
import { createServer } from "node:http";
import { buildApprovalsDigest, postEmail } from "@gaugeline/core";
import { buildMorningEmail, waitingFor } from "../email/morning.js";
import { DEFAULT_MAIL_FROM, resendSender } from "../email/send.js";

const NOW = new Date("2026-11-13T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const draft = (n: number, hours: number, title: string) => ({
  id: `a1d20000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  siteId: "a1000000-0000-4000-8000-0000000000a1",
  kind: "email",
  title,
  createdAt: hoursAgo(hours),
  expiresAt: hoursAgo(hours - 72),
});

export async function runDigestExample(): Promise<string> {
  const digest = buildApprovalsDigest(
    [draft(1, 70, "Your menu link is fixed"), draft(2, 21, "Point the menu link at /drinks")],
    NOW,
    { appUrl: "https://app.northgate.example" },
  );
  const mail = buildMorningEmail({
    orgName: "Northgate Studio",
    changes: [],
    dashboardUrl: "https://app.northgate.example/",
    preferencesUrl: "https://app.northgate.example/email/preferences?t=v1.eyJvIjoiMGEw....c2ln",
    waiting: waitingFor("every_change", digest),
  })!;

  // The stand-in: records what the sender posts and answers like Resend does.
  const seen: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        from: string;
        to: string[];
      };
      seen.push(
        `${req.method} ${req.url} from ${body.from} to ${body.to.join(", ")} (authorization: ${String(req.headers.authorization).replace(/\S+$/, "<key>")}, idempotency-key: ${String(req.headers["idempotency-key"])})`,
      );
      res.writeHead(200, { "content-type": "application/json" }).end('{"id":"stand-in-0001"}');
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/emails`;
  const key = "stand-in-key";
  const to = "owner@northgate.example";
  const out = [`Subject: ${mail.subject}`, "", mail.text];
  for (const from of [DEFAULT_MAIL_FROM, "Gaugeline <morning@mail.northgate.example>"]) {
    const send = resendSender({ RESEND_API_KEY: key, GAUGELINE_EMAIL_FROM: from }, (settings, m) =>
      postEmail({ ...settings, endpoint, publicOnly: false }, m),
    )!;
    out.push(
      `sender ${from}: ${JSON.stringify(await send({ to, mail, idempotencyKey: "morning/org-1/user-1/2026-11-13" }))}`,
    );
  }
  await new Promise((r) => server.close(r));
  out.push(`requests the stand-in received: ${seen.length}`, ...seen);
  return out.join("\n");
}

if (process.argv[1]?.endsWith("example-digest.ts")) console.log(await runDigestExample());
