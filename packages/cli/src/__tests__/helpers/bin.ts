import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export const bin = fileURLToPath(new URL("../../../dist/index.js", import.meta.url));

/** Spawn the built bin without blocking this process, so the fixture server can answer. */
export async function runBin(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ status: number; stdout: string; stderr: string }> {
  try {
    const r = await promisify(execFile)(process.execPath, [bin, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return { status: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      status: typeof e.code === "number" ? e.code : -1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}
