import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export const bin = fileURLToPath(new URL("../../../dist/index.js", import.meta.url));

/** The parent's environment minus CI and colour settings, plus what the test asks for. */
function cleanEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ["CI", "NO_COLOR", "FORCE_COLOR", "GITHUB_ACTIONS"]) delete env[key];
  return { ...env, ...extra };
}

/** Spawn the built bin without blocking this process, so the fixture server can answer. */
export async function runBin(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ status: number; stdout: string; stderr: string }> {
  try {
    // Fixture servers listen on 127.0.0.1, which Gaugeline refuses unless asked: opt in explicitly.
    const local = args.some((a) => a.startsWith("http://127.0.0.1"));
    const argv = local && !args.includes("--allow-private") ? [...args, "--allow-private"] : args;
    const r = await promisify(execFile)(process.execPath, [bin, ...argv], {
      encoding: "utf8",
      env: cleanEnv(env),
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
