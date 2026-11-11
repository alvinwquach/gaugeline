import type {
  CutoverConfig,
  CutoverRecord,
  CutoverSnapshot,
  HostBehaviour,
} from "../dns/cutover-snapshot.js";
import { CheckRegistry, defineCheck, type Finding } from "../model.js";
import { certificateExpiring } from "./certificate-expiring.js";

/**
 * gaugeline cutover: the domain read again and compared with the snapshot taken before. Pure over
 * two snapshots, so the same pair always gives the same findings.
 */
export interface CutoverCheckInput {
  before: CutoverSnapshot;
  now: CutoverSnapshot;
  /** Changes that were meant (gaugeline.cutover.json): left out, and said once. */
  expected?: CutoverConfig["expectedChanges"];
}

const shown = (xs: readonly string[]) => (xs.length === 0 ? "none" : xs.join(", "));

/** "was X; now Y" when two sorted lists differ as sets, else undefined. */
export function changed(before: readonly string[], now: readonly string[]): string | undefined {
  const a = [...new Set(before)].sort();
  const b = [...new Set(now)].sort();
  if (a.length === b.length && a.every((x, i) => x === b[i])) return undefined;
  return `was ${shown(a)}; now ${shown(b)}`;
}

const expects = (input: CutoverCheckInput, record: CutoverRecord) =>
  (input.expected ?? []).some((e) => e.record === record);

/** A record whose lookup failed in either run can't be compared: could not check, never a change. */
function failedFor(input: CutoverCheckInput, rrtype: string, name: string): boolean {
  const key = `${rrtype} ${name} (`;
  return [...input.before.records.failed, ...input.now.records.failed].some((f) =>
    f.startsWith(key),
  );
}

interface RecordDiff {
  record: CutoverRecord;
  label: string;
  rrtype: string;
  name: string;
  before: string[];
  now: string[];
}

function diffs(input: CutoverCheckInput, records: readonly CutoverRecord[]): RecordDiff[] {
  const d = input.now.domain;
  const b = input.before.records;
  const n = input.now.records;
  const all: RecordDiff[] = [
    { record: "mx", label: "MX", rrtype: "MX", name: d, before: b.mx, now: n.mx },
    { record: "spf", label: "SPF", rrtype: "TXT", name: d, before: b.spf, now: n.spf },
    { record: "a", label: "A", rrtype: "A", name: d, before: b.a, now: n.a },
    { record: "aaaa", label: "AAAA", rrtype: "AAAA", name: d, before: b.aaaa, now: n.aaaa },
    {
      record: "dmarc",
      label: "DMARC",
      rrtype: "TXT",
      name: `_dmarc.${d}`,
      before: b.dmarc,
      now: n.dmarc,
    },
    ...Object.keys({ ...b.dkim, ...n.dkim })
      .sort()
      .map((sel): RecordDiff => ({
        record: "dkim",
        label: `DKIM (${sel})`,
        rrtype: "TXT",
        name: `${sel}._domainkey.${d}`,
        before: b.dkim[sel] ?? [],
        now: n.dkim[sel] ?? [],
      })),
  ];
  return all.filter((x) => records.includes(x.record));
}

function recordFindings(
  input: CutoverCheckInput,
  ctx: { couldNotCheck?(url: string, reason: string): void },
  records: readonly CutoverRecord[],
  check: { id: string; severity: Finding["severity"]; title: string },
): Finding[] {
  const url = `https://${input.now.domain}/`;
  const out: Finding[] = [];
  for (const x of diffs(input, records)) {
    if (expects(input, x.record)) continue;
    if (failedFor(input, x.rrtype, x.name)) {
      ctx.couldNotCheck?.(
        url,
        `the ${x.rrtype} lookup for ${x.name} failed in one of the two runs`,
      );
      continue;
    }
    const change = changed(x.before, x.now);
    if (change)
      out.push({
        checkId: check.id,
        severity: check.severity,
        title: check.title,
        evidence: `${x.label} for ${x.name} ${change}`,
        url,
      });
  }
  return out;
}

export const cutoverMailChanged = defineCheck<CutoverCheckInput>({
  id: "cutover-mail-changed",
  size: "M",
  done: "The mail records match the old values, or the change is listed under expectedChanges with a reason.",
  estimateChanges:
    "Mail that already stopped working means finding what was lost. Records edited at a registrar and a host both need checking.",
  area: "Security & email",
  severity: "high",
  title: "The domain's mail records changed at cutover",
  what: "Against the snapshot taken before cutover, the domain's MX records (where its mail is delivered) or its SPF record (who may send as it) are different.",
  why: "A new host's DNS template often replaces the mail records: mail then bounces or goes to an old server, and receipts and confirmations land in spam, with nothing on the site to show it.",
  fix: "Put the old MX and SPF values back unless the move was meant. If it was, list mx or spf under expectedChanges in gaugeline.cutover.json with the reason.",
  tech: "gaugeline cutover --before <file>. MX and TXT (v=spf1) at the domain, compared as sets, so order is not a change. A lookup that failed in either run is could not check, never a change",
  run(input, ctx) {
    return recordFindings(input, ctx, ["mx", "spf"], this);
  },
});

export const cutoverRecordsChanged = defineCheck<CutoverCheckInput>({
  id: "cutover-records-changed",
  size: "M",
  done: "Each changed record matches what the new host and the mail provider publish, or is listed under expectedChanges.",
  estimateChanges: "The number of records, and records edited at both a registrar and a host.",
  area: "Security & email",
  severity: "medium",
  title: "The domain's DNS records changed at cutover",
  what: "Against the snapshot taken before cutover, the domain's DMARC record, a DKIM key (for the selectors in gaugeline.cutover.json) or its address records (A, AAAA) are different.",
  why: "A lost DKIM key or DMARC record breaks mail authentication quietly; new address records are the cutover itself, worth confirming they point where the new host says.",
  fix: "Check each value against what the new host and your mail provider publish. List a change that was meant under expectedChanges in gaugeline.cutover.json.",
  tech: "TXT at _dmarc.<domain> (v=DMARC1), TXT at <selector>._domainkey.<domain>, A and AAAA at the domain; sets compared. A lookup that failed in either run is could not check",
  run(input, ctx) {
    return recordFindings(input, ctx, ["dmarc", "dkim", "a", "aaaa"], this);
  },
});

export const cutoverCertificateChanged = defineCheck<CutoverCheckInput>({
  id: "cutover-certificate-changed",
  size: "S",
  done: "The new certificate covers every name the old one did.",
  estimateChanges: "Most hosts add www as a separate domain, and each extra name is one more.",
  area: "Security & email",
  severity: "medium",
  title: "The certificate no longer covers a name it did",
  what: "The https certificate after cutover lacks a name the one before covered (www, a subdomain), or there is no certificate where there was one.",
  why: "Visitors on the name that dropped off see a security warning instead of the site.",
  fix: "Add the missing name to the new host's certificate (most hosts add www as a separate domain).",
  tech: "Names from subjectAltName, a wildcard covering one label. A new issuer or a renewed date alone is not a change",
  run(input) {
    if (expects(input, "certificate") || !input.before.certificate) return [];
    const now = input.now.certificate;
    const lost = input.before.certificate.names.filter((n) => !(now?.names ?? []).includes(n));
    if (lost.length === 0) return [];
    return [
      {
        checkId: this.id,
        severity: this.severity,
        title: this.title,
        evidence: now
          ? `The certificate covered ${shown(input.before.certificate.names)}; now ${shown(now.names)} (${shown(lost)} dropped off)`
          : `The certificate covered ${shown(input.before.certificate.names)}; now no certificate could be read`,
        url: `https://${input.now.domain}/`,
      },
    ];
  },
});

const said = (h: HostBehaviour) =>
  "error" in h ? `no answer (${h.error})` : `${h.status}${h.location ? ` to ${h.location}` : ""}`;
const PERMANENT = new Set([301, 308]);

export const cutoverCanonicalHost = defineCheck<CutoverCheckInput>({
  id: "cutover-canonical-host",
  size: "S",
  done: "The bare domain and www settle on one address with a 301.",
  estimateChanges: "Mail or a certificate on the second name adds a step.",
  area: "Launch day",
  severity: "high",
  title: "The bare domain and www don't settle on one address",
  what: "Of the bare domain and www, exactly one should answer 200 and the other redirect to it permanently (301 or 308). After cutover, both answer, neither does, or the redirect is temporary.",
  why: "Two live copies split links and ranking between them; a missing one is a dead address for everyone who types it; a temporary redirect tells search engines to keep the old one.",
  fix: "Pick one (most sites use the bare domain or www, either is fine) and redirect the other to it with a 301. Most hosts have a primary-domain setting for this.",
  tech: "GET https://<domain>/ and https://www.<domain>/ through the fetcher, first hop each. Also reported when how either answers changed since the snapshot, with both values",
  run(input) {
    const { bare, www } = input.now.hosts;
    const url = `https://${input.now.domain}/`;
    const d = input.now.domain;
    const ok = (h: HostBehaviour) => !("error" in h) && h.status === 200;
    const to = (h: HostBehaviour, host: string) =>
      !("error" in h) &&
      PERMANENT.has(h.status) &&
      (h.location ?? "").replace(/\/$/, "").split("/")[0] === host;
    const out: Finding[] = [];
    const finding = (evidence: string, severity: Finding["severity"] = "high") =>
      out.push({ checkId: this.id, severity, title: this.title, evidence, url });
    const settled = (ok(bare) && to(www, d)) || (ok(www) && to(bare, `www.${d}`));
    if (!settled)
      finding(
        `${d} answers ${said(bare)}; www.${d} answers ${said(www)}: one should answer 200 and the other redirect to it with 301`,
      );
    if (!expects(input, "hosts"))
      for (const [label, host] of [
        [d, "bare"],
        [`www.${d}`, "www"],
      ] as const) {
        const was = said(input.before.hosts[host]);
        const is = said(input.now.hosts[host]);
        if (was !== is) finding(`${label} answered ${was} before cutover; now ${is}`, "medium");
      }
    return out;
  },
});

/** The checks gaugeline cutover runs, sorted by id. certificate-expiring is shared with page runs. */
export const CUTOVER_ONLY_CHECKS = [
  cutoverCanonicalHost,
  cutoverCertificateChanged,
  cutoverMailChanged,
  cutoverRecordsChanged,
] as const;

export function createCutoverRegistry(): CheckRegistry {
  const registry = new CheckRegistry();
  registry.register(certificateExpiring);
  for (const c of CUTOVER_ONLY_CHECKS) registry.register(c);
  return registry;
}
