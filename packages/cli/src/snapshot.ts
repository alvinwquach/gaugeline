import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ConfigError,
  createDnsReader,
  createFetcher,
  daysLeft,
  takeCutoverSnapshot,
  type CutoverSnapshot,
  type DnsReader,
  type FetcherOptions,
  type HostBehaviour,
  type Outcome,
} from "@gaugeline/core";
import { manualChecklist } from "./manual-checklist.js";
import { readCutoverConfig } from "./schema-config.js";

export interface CutoverIo {
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
}

export interface CutoverDeps {
  cwd?: string;
  fetcher?: FetcherOptions;
  dns?: DnsReader;
  now?: () => Date;
}

const host = (h: HostBehaviour) =>
  "error" in h ? `no answer (${h.error})` : `${h.status}${h.location ? ` to ${h.location}` : ""}`;
const list = (xs: readonly string[]) => (xs.length === 0 ? "none" : xs.join(", "));

/** The snapshot as lines a person can check by eye before cutover. */
export function describeSnapshot(s: CutoverSnapshot, now: Date): string {
  const r = s.records;
  const width = Math.max(12, `www.${s.domain}`.length + 2);
  const pad = (label: string) => label.padEnd(width);
  const dkim = Object.entries(r.dkim);
  const lines = [
    `${pad("Address")}A ${list(r.a)}${r.aaaa.length > 0 ? `; AAAA ${list(r.aaaa)}` : ""}`,
    `${pad("Mail")}MX ${list(r.mx)}`,
    `${pad("SPF")}${list(r.spf)}`,
    `${pad("DMARC")}${list(r.dmarc)}`,
    `${pad("DKIM")}${dkim.length === 0 ? "no selectors named in gaugeline.cutover.json" : dkim.map(([k, v]) => `${k}: ${v.length > 0 ? "found" : "none"}`).join(", ")}`,
    `${pad("Certificate")}${s.certificate ? `${list(s.certificate.names)}; expires ${s.certificate.validTo.slice(0, 10)} (${daysLeft(s.certificate, now)} days)` : "none read"}`,
    `${pad(s.domain)}${host(s.hosts.bare)}`,
    `${pad(`www.${s.domain}`)}${host(s.hosts.www)}`,
  ];
  return lines.map((l) => `  ${l}`).join("\n");
}

export async function takeSnapshot(
  domain: string,
  opts: { allowPrivate: boolean; selectors?: readonly string[] },
  deps: CutoverDeps,
): Promise<CutoverSnapshot> {
  return takeCutoverSnapshot({
    domain,
    dns: deps.dns ?? createDnsReader(),
    fetcher: createFetcher({
      ...deps.fetcher,
      ...(opts.allowPrivate ? { allowPrivate: true } : {}),
    }),
    ...(opts.selectors ? { selectors: opts.selectors } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
}

/** gaugeline snapshot <domain> --out before.json */
export async function runSnapshot(
  args: { domain: string; out: string; allowPrivate: boolean; quiet: boolean },
  io: CutoverIo,
  deps: CutoverDeps,
): Promise<Outcome> {
  const cwd = deps.cwd ?? process.cwd();
  const config = readCutoverConfig(cwd);
  const snap = await takeSnapshot(
    args.domain,
    {
      allowPrivate: args.allowPrivate,
      ...(config?.dkimSelectors ? { selectors: config.dkimSelectors } : {}),
    },
    deps,
  );
  const path = resolve(cwd, args.out);
  try {
    writeFileSync(path, `${JSON.stringify(snap, null, 2)}\n`);
  } catch (err) {
    throw new ConfigError(`${args.out} could not be written: ${(err as Error).message}`);
  }
  io.stdout.write(
    `Snapshot of ${snap.domain} written to ${args.out}\n${describeSnapshot(snap, (deps.now ?? (() => new Date()))())}\n`,
  );
  for (const f of snap.records.failed) io.stdout.write(`? ${f}: could not be read\n`);
  if (!args.quiet) io.stderr.write(`${manualChecklist("snapshot")}\n`);
  return {
    kind: "ran",
    highFindings: 0,
    drift: false,
    // A record that couldn't be read would make tomorrow's comparison could not check.
    incomplete: snap.records.failed.length > 0,
  };
}
