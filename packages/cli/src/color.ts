/** ANSI colour only for a terminal, and never when NO_COLOR is set (https://no-color.org/). */
export function useColor(
  stream: { isTTY?: boolean },
  env: Record<string, string | undefined>,
): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "" && env.FORCE_COLOR !== "0")
    return true;
  return stream.isTTY === true && env.TERM !== "dumb";
}

export interface Paint {
  red(s: string): string;
  yellow(s: string): string;
  green(s: string): string;
  grey(s: string): string;
  bold(s: string): string;
}

const wrap = (open: number, close: number) => (s: string) => `\u001b[${open}m${s}\u001b[${close}m`;

export function paint(color: boolean): Paint {
  if (!color) {
    const id = (s: string) => s;
    return { red: id, yellow: id, green: id, grey: id, bold: id };
  }
  return {
    red: wrap(31, 39),
    yellow: wrap(33, 39),
    green: wrap(32, 39),
    grey: wrap(90, 39),
    bold: wrap(1, 22),
  };
}
