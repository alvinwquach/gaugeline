export interface ManifestEntry {
  path: string;
  type: string;
  bytes: number;
  gzipBytes: number;
  sha256: string;
}
export interface Budget {
  ok: boolean;
  total: number;
  largest: ManifestEntry[];
  problems: string[];
}
export const TOTAL_GZIP_BUDGET: number;
export const FILE_GZIP_BUDGET: number;
export const MANIFEST_FILE: string;
export const DEMO_SOURCE: string;
export const DEMO_TARGET: string;
export function contentType(path: string): string;
export function listFiles(dir: string, prefix?: string): string[];
export function entryFor(path: string, body: Buffer): ManifestEntry;
export function buildManifest(dir: string): ManifestEntry[];
export function checkBudget(
  entries: Pick<ManifestEntry, "path" | "gzipBytes">[],
  limits?: { total?: number; file?: number },
): Budget;
export function report(entries: ManifestEntry[], budget?: Budget): string;
export function embed(
  app: string,
  out: string,
  extra?: { from: string; to: string }[],
): ManifestEntry[];
export function verify(dir: string): { entries: ManifestEntry[]; problems: string[] };
