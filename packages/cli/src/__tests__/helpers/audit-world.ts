import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFixture } from "@gaugeline/fixtures";
import { main } from "../../main.js";
import type { ScaffoldFs } from "../../scaffold-write.js";

/** The clock every audit test injects, in UTC. */
export const NOW = new Date("2026-11-10T09:00:00.000Z");

/**
 * The freelancer's packages the guide shows for the invented Corner Bar: two packages that cover
 * checks the corner-bar fixture finds, one check no package covers (so "Other findings" shows), and her
 * name, logo and contact line. docs/guides/audit-pack.md carries the same JSON; audit-docs.test.ts
 * compares the two.
 */
export const BAR_SERVICES = {
  currency: "usd",
  services: [
    {
      name: "Search and sharing tidy-up",
      covers: { checks: ["canonical-elsewhere", "og-image-missing"] },
      price: { from: 450, to: 700 },
      hours: { from: 4, to: 6 },
      notIncluded: ["New page copy", "Paid search or ads"],
    },
    {
      name: "Phone, booking and alt text",
      covers: { checks: ["viewport", "mailto-cta", "images-alt-missing"] },
      price: { from: 600, to: 900 },
      hours: { from: 5, to: 8 },
      notIncluded: ["Setting up an online booking system", "A redesign"],
    },
  ],
  brand: {
    name: "Harbour Studio",
    logoUrl: "https://harbour-studio.example/logo.png",
    contact: "Mia Okafor, 555 0142, harbour-studio.example",
  },
};

const made: string[] = [];

/** A working folder at its real path (macOS's tmpdir is a link, and Windows may shorten it). */
export function folder(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gaugeline-audit-")));
  made.push(dir);
  return dir;
}

export function removeFolders(): void {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

const nowhere = async (): Promise<never> => {
  throw Object.assign(new Error("getaddrinfo ENOTFOUND (test)"), { code: "ENOTFOUND" });
};

export function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
      env: { NO_COLOR: "1" },
      now: () => NOW,
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

/** Run `gaugeline audit <fixture site> ...flags` in `cwd`; reports the exit code, both streams and every request method the site saw. */
export async function audit(fixture: string, flags: string[], cwd: string, fs?: ScaffoldFs) {
  const site = await startFixture(fixture);
  try {
    const run = capture();
    const code = await main(["audit", site.origin, "--allow-private", ...flags], run.io, {
      version: "0.2.0",
      cwd,
      now: () => NOW,
      fetcher: { hosts: site.hosts, resolver: nowhere },
      ...(fs ? { auditFs: fs } : {}),
    });
    return {
      code,
      out: run.out(),
      err: run.err(),
      origin: site.origin,
      methods: new Map(site.methods),
    };
  } finally {
    await site.close();
  }
}
