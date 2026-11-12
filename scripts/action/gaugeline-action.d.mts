export const MARKER: string;
export function summarise(sarifText: string): {
  high: number;
  medium: number;
  low: number;
  total: number;
  rows: { level: string; title: string; evidence: string }[];
};
export function buildComment(sarifText: string, opts: { url: string; failOn: string }): string;
export function decide(a: {
  exit: number;
  failOn: string;
  summary: ReturnType<typeof summarise> | undefined;
}): { fail: boolean; reason: string };
export function upsertComment(a: {
  body: string;
  repo: string;
  pr: number;
  token: string;
  api?: string;
  fetch?: typeof fetch;
}): Promise<{ done: boolean; why: string }>;
export function commentTarget(
  env: Record<string, string | undefined>,
):
  | { ok: true; repo: string; pr: number; why?: undefined }
  | { ok: false; why: string; repo?: undefined; pr?: undefined };
export function run(
  env: Record<string, string | undefined>,
  deps?: { log?: (line: string) => void; fetch?: typeof fetch },
): Promise<{ failed: boolean; message: string }>;
