/** pnpm adr:check: decision records are numbered, complete and indexed. */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkAdrs } from "./lib/adr.js";

const dir = process.env.ADR_DIR ?? fileURLToPath(new URL("../docs/adr/", import.meta.url));
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".md"))
  .map((name) => ({ name, text: readFileSync(`${dir}/${name}`, "utf8") }));
const readme = files.find((f) => f.name === "README.md")?.text ?? "";
const problems = checkAdrs(files, readme);
for (const p of problems) process.stderr.write(`adr:check: ${p}\n`);
if (problems.length > 0) process.exitCode = 1;
else process.stdout.write(`adr:check: ${files.length - 1} records ok\n`);
