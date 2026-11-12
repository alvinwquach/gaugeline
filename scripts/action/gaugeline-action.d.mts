export function summarise(sarifText: string): {
  high: number;
  medium: number;
  low: number;
  total: number;
};
export function decide(a: {
  exit: number;
  failOn: string;
  summary: ReturnType<typeof summarise> | undefined;
}): { fail: boolean; reason: string };
export function run(
  env: Record<string, string | undefined>,
  deps?: { log?: (line: string) => void },
): Promise<{ failed: boolean; message: string }>;
