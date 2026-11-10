import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach } from "vitest";

/** A repository written into a temporary folder and removed after the test. Names use forward slashes. */
const made: string[] = [];

export function repo(files: Record<string, string>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gaugeline-routes-")));
  made.push(dir);
  for (const [name, text] of Object.entries(files)) {
    const target = join(dir, ...name.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  return dir;
}

export function removeRepos(): void {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/** Call in a describe block's scope: removes the folders `repo` made after each test. */
export function cleanUpRepos(): void {
  afterEach(removeRepos);
}

export const PAGE = "export default function Page() { return null; }\n";
export const AUTH_PAGE =
  'import { auth } from "@/auth";\nexport default async function Page() {\n  const session = await auth();\n  return <p>{session ? "in" : "out"}</p>;\n}\n';
