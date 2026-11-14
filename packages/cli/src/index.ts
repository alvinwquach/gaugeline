import { nodeVersionProblem } from "./node-version.js";

// A reader that closes early (gaugeline ... | head -1) must not crash the run or change its exit code.
for (const stream of [process.stdout, process.stderr]) stream.on("error", () => undefined);

// The version guard runs before the rest of the program is loaded (a dynamic import is not hoisted),
// so an old Node prints one line and exits 2 instead of failing on newer syntax in the bundle.
const problem = nodeVersionProblem(process.versions.node);
if (problem) {
  process.stderr.write(`${problem}\n`);
  process.exitCode = 2;
} else {
  const { main } = await import("./main.js");
  process.exitCode = await main(process.argv.slice(2), {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
  });
}
