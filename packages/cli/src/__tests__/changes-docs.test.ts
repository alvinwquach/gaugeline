import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describeChange } from "@gaugeline/core";
import { expectedOutput } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, type FixtureServer } from "../../../core/src/__tests__/helpers/server.js";
import { FLAGS, flagsFor } from "../flags.js";
import { HELP } from "../help.js";
import { main } from "../main.js";
import { runBin } from "./helpers/bin.js";

const page = readFileSync(
  fileURLToPath(new URL("../../../../docs/guides/what-changed.md", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");

const servers: FixtureServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("docs/options.md: gaugeline changes --help", () => {
  it("shows exactly what the built bin prints", async () => {
    const r = await runBin(["changes", "--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trimEnd()).toBe(HELP.changes);
    expect(r.stdout.trimEnd()).toBe(expectedOutput("options", "The changes command"));
  });
  it("the flags --help lists are the flags docs/options lists", () => {
    const own = flagsFor(FLAGS, "changes").map((f) => `--${f.name}`);
    const options = readFileSync(
      fileURLToPath(new URL("../../../../docs/options.md", import.meta.url)),
      "utf8",
    );
    for (const n of own) {
      expect(HELP.changes, n).toContain(n);
      expect(options, n).toContain(n);
    }
  });
});

describe("docs/guides/what-changed.md", () => {
  it("has the freelancer example, every own flag, and no talk of fault or price", () => {
    expect(page).toMatch(/pop-up bar owner/);
    expect(page).toContain("--since");
    expect(page).toContain("--json");
    expect(page.match(/^\$ npx gaugeline changes /gm)?.length).toBeGreaterThanOrEqual(1);
    expect(page).not.toMatch(/client's fault/i);
  });

  it("the two-run output on the page is what the command prints", async () => {
    const state = { markup: true, book: true };
    const server = await startServer({
      "/events": (_q: unknown, res: ServerResponse) => {
        res
          .writeHead(200, { "content-type": "text/html" })
          .end(
            `<html><head><title>Events</title>${state.markup ? `<script type="application/ld+json">${JSON.stringify({ "@type": "Event", name: "Quiz night", startDate: "2026-11-12T19:00:00" })}</script>` : ""}</head><body><main><h1>Events</h1><p>Quiz night</p>${state.book ? '<a href="/book">Book a table</a>' : ""}</main></body></html>`,
          );
      },
    });
    servers.push(server);
    const cwd = mkdtempSync(join(tmpdir(), "gaugeline-changes-docs-"));
    dirs.push(cwd);
    const run = async (argv: string[], at: string) => {
      const out: string[] = [];
      await main(
        argv,
        {
          stdout: { write: (s: string) => out.push(s) },
          stderr: { write: () => 0 },
          env: { NO_COLOR: "1" },
          now: () => new Date(at),
        },
        { cwd },
      );
      return out.join("");
    };
    const url = `${server.origin}/events`;
    await run([url, "--no-open", "--allow-private", "--since", "last"], "2026-11-01T10:00:00Z");
    state.markup = false;
    state.book = false;
    await run([url, "--no-open", "--allow-private", "--since", "last"], "2026-11-03T10:00:00Z");
    const out = (await run(["changes", url], "2026-11-04T10:00:00Z")).trimEnd();
    expect(page).toContain(out);
  });

  it("the content-edit sentence on the page is the one the code writes", () => {
    const sentence = describeChange(
      {
        label: "content-edit",
        revisions: [
          { documentId: "events-page", time: "2026-10-03T14:00:00.000Z", editor: "Sam Ortiz" },
        ],
        deploys: [],
        reasons: [],
        notChecked: [],
      },
      "/events",
    );
    expect(page).toContain(`content-edit: ${sentence}`);
  });
});
