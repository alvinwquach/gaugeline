import type { Fetcher } from "../fetcher.js";
import { ConnectorRefusedError } from "./http.js";
import { missingVars } from "./env.js";
import { createRedactor } from "./redact.js";
import type { Connector, ConnectorNotice, ConnectorRun, Env } from "./types.js";

export interface RunConnectorsOptions {
  /** Called with progress lines (for --verbose). Every line is redacted first. */
  debug?: (line: string) => void;
}

/** Longest a notice message gets, measured after redaction so a cut can never expose half a key. */
const MAX_MESSAGE = 300;

type Outcome = { ok: true; id: string; rows: unknown[] } | { ok: false; notice: ConnectorNotice };

/**
 * Read every configured connector at the same time. A connector that is not configured is skipped
 * with a notice; one that fails becomes a notice and the others still return their data. Nothing
 * here throws for a system being down. Every message that leaves is passed through the redactor
 * built from the values of all declared variables.
 */
export async function runConnectors(
  connectors: ReadonlyArray<Connector<unknown>>,
  env: Env,
  fetcher: Fetcher,
  options: RunConnectorsOptions = {},
): Promise<ConnectorRun> {
  const seen = new Set<string>();
  for (const c of connectors) {
    if (seen.has(c.id)) throw new TypeError(`Two connectors are called "${c.id}".`);
    seen.add(c.id);
  }
  const redact = createRedactor(env, [...new Set(connectors.flatMap((c) => c.envVars))]);
  const say = (line: string): void => options.debug?.(redact(line));
  const notice = (connector: string, kind: ConnectorNotice["kind"], message: string): Outcome => ({
    ok: false,
    notice: { connector, kind, message: redact(message).slice(0, MAX_MESSAGE) },
  });

  const settled = await Promise.allSettled(
    connectors.map(async (c): Promise<Outcome> => {
      if (!c.configured(env)) {
        const missing = missingVars(env, c.envVars);
        say(`connector ${c.id}: not configured, skipped`);
        return notice(
          c.id,
          "not-configured",
          `${c.id} is not set up, so it was left out. Set ${missing.length > 0 ? missing.join(", ") : "its variables"} to include it.`,
        );
      }
      say(`connector ${c.id}: reading`);
      try {
        const rows: unknown = await c.read(env, fetcher);
        if (!Array.isArray(rows)) {
          return notice(c.id, "unreachable", `${c.id} returned something other than a list.`);
        }
        say(`connector ${c.id}: ${rows.length} rows`);
        return { ok: true, id: c.id, rows };
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        say(`connector ${c.id}: failed (${text})`);
        return err instanceof ConnectorRefusedError
          ? notice(
              c.id,
              "refused",
              `${c.id} refused the key (HTTP ${err.status}). Check it is the right key and that it can read.`,
            )
          : notice(c.id, "unreachable", `${c.id} could not be read. ${text}`);
      }
    }),
  );

  const data = new Map<string, unknown[]>();
  const notices: ConnectorNotice[] = [];
  settled.forEach((s, i) => {
    // The per-connector function catches everything, so a rejection here is a bug in this file;
    // it still becomes a notice rather than a lost answer.
    const out: Outcome =
      s.status === "fulfilled"
        ? s.value
        : notice(
            connectors[i]?.id ?? "unknown",
            "unreachable",
            `${connectors[i]?.id ?? "A connector"} could not be read.`,
          );
    if (out.ok) data.set(out.id, out.rows);
    else notices.push(out.notice);
  });
  return { data, notices };
}
