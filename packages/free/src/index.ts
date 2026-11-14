import { main } from "./main.js";

for (const stream of [process.stdout, process.stderr]) stream.on("error", () => undefined);

process.exitCode = await main(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
});
