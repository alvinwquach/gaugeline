import { main } from "./main.js";

// A reader that closes early (gaugeline ... | head -1) must not crash the run or change its exit code.
for (const stream of [process.stdout, process.stderr]) stream.on("error", () => undefined);

process.exitCode = await main(process.argv.slice(2), {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
});
