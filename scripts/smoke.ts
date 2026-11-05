/**
 * Pack the gaugeline CLI the way npm would publish it, check what is inside and how big it is,
 * then run it with npx against the local "clean" fixture site.
 *   pnpm build && pnpm smoke
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { withFixture } from "../packages/fixtures/src/index.js";

export const SIZE_BUDGET_BYTES = 1024 * 1024;
const ALLOWED = /^package\/(dist\/.+|README\.md|LICENSE|package\.json)$/;

const cliDir = fileURLToPath(new URL("../packages/cli/", import.meta.url));
const out = mkdtempSync(join(tmpdir(), "gaugeline-smoke-"));
const shell = process.platform === "win32";
let failed = false;
const fail = (msg: string) => {
  process.stderr.write(`smoke: ${msg}\n`);
  failed = true;
};

try {
  execFileSync("npm", ["pack", "--pack-destination", out], { cwd: cliDir, stdio: "pipe", shell });
  const tarball = readdirSync(out).find((f) => f.endsWith(".tgz"));
  if (!tarball) throw new Error("npm pack produced no tarball");
  const path = join(out, tarball);

  const files = execFileSync("tar", ["-tzf", path], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const unexpected = files.filter((f) => !ALLOWED.test(f));
  if (unexpected.length > 0) fail(`unexpected files in the tarball: ${unexpected.join(", ")}`);
  for (const required of [
    "package/package.json",
    "package/dist/index.js",
    "package/README.md",
    "package/LICENSE",
  ]) {
    if (!files.includes(required)) fail(`${required} is missing from the tarball`);
  }
  const size = statSync(path).size;
  if (size > SIZE_BUDGET_BYTES)
    fail(`tarball is ${size} bytes, over the ${SIZE_BUDGET_BYTES}-byte budget`);
  process.stdout.write(
    `smoke: ${tarball} is ${(size / 1024).toFixed(1)} kB with ${files.length} files\n`,
  );

  await withFixture("clean", async (site) => {
    // Async spawn: the fixture server runs in this process and must keep answering.
    const run = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolve) => {
        const child = spawn(
          "npx",
          ["--yes", `--package=${path}`, "gaugeline", `${site.origin}/`, "--allow-private"],
          {
            cwd: out,
            shell,
            env: { ...process.env, CI: "", NO_COLOR: "1" },
          },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
        child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
        const timer = setTimeout(() => child.kill(), 120_000);
        child.on("close", (status) => {
          clearTimeout(timer);
          resolve({ status, stdout, stderr });
        });
      },
    );
    if (run.status !== 0)
      fail(`npx run exited ${String(run.status)}\n${run.stdout}\n${run.stderr}`);
    else if (!run.stdout.includes("Nothing to look at.")) fail(`unexpected output:\n${run.stdout}`);
    else process.stdout.write(`smoke: npx ran under Node ${process.version} and exited 0\n`);
  });
} finally {
  rmSync(out, { recursive: true, force: true });
}
if (failed) process.exitCode = 1;
