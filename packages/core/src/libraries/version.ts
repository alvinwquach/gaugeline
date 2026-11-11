/**
 * A library version as three whole numbers and an optional pre-release word. Never a float: "3.10.0" is newer than
 * "3.9.0", and as a decimal it would not be. Only what the detection and the advisory list write is read:
 * two or three numbers ("1.12", "3.5.1") and "-beta1" style pre-release. Anything else is not a version.
 */
export interface ParsedVersion {
  /** Major, minor, patch (patch is 0 when the version has two numbers). */
  parts: [number, number, number];
  pre: string | undefined;
}

const VERSION = /^(\d{1,6})\.(\d{1,6})(?:\.(\d{1,6}))?(?:-([0-9A-Za-z.]{1,16}))?$/;

export function parseVersion(text: string): ParsedVersion | undefined {
  const m = VERSION.exec(text);
  if (!m) return undefined;
  return { parts: [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)], pre: m[4] };
}

/**
 * Negative when a is older than b, zero when equal, positive when newer; undefined when either is not a version.
 * A pre-release is older than its release and compared as text with another pre-release of the same numbers.
 */
export function compareVersions(a: string, b: string): number | undefined {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return undefined;
  for (let i = 0; i < 3; i++) {
    const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
    if (d !== 0) return d;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre < y.pre ? -1 : 1;
}
