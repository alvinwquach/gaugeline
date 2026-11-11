import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseCliArgs } from "../args.js";
import { FLAGS } from "../flags.js";
import { HELP } from "../help.js";
import { EXIT, main } from "../main.js";
import { nodeFs, type ScaffoldFs } from "../scaffold-write.js";
import {
  BAR_HANDOFF,
  BAR_LISTINGS,
  CLIENT,
  COACH,
  COACH_HANDOFF,
  ENV,
  FREELANCER,
  FREELANCER_HOME,
  GOOGLE_TOKEN,
  NOW,
  SANITY_TOKEN,
  TEAMMATE,
  VERCEL_TOKEN,
  world,
} from "./helpers/handoff-world.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function folder(files: Record<string, unknown> = {}): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gaugeline-handoff-")));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files))
    writeFileSync(join(dir, name), typeof body === "string" ? body : JSON.stringify(body));
  return dir;
}

const BAR_FILES = {
  "gaugeline.handoff.json": BAR_HANDOFF,
  "gaugeline.listings.json": BAR_LISTINGS,
};

async function run(
  argv: string[],
  cwd: string,
  opts: {
    env?: Record<string, string | undefined>;
    over?: Parameters<typeof world>[0];
    handoffFs?: ScaffoldFs;
    dns?: unknown;
  } = {},
) {
  const { transport, seen } = world(opts.over);
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    argv,
    {
      stdout: { write: (s) => out.push(s) },
      stderr: { write: (s) => err.push(s) },
      env: opts.env ?? ENV,
    },
    {
      cwd,
      now: () => NOW,
      fetcher: { transport },
      ...(opts.handoffFs ? { handoffFs: opts.handoffFs } : {}),
      ...(opts.dns ? { dns: opts.dns } : {}),
    } as never,
  );
  return { code, out: out.join(""), err: err.join(""), seen };
}

const lines = (text: string) => text.split("\n");
const readOut = (dir: string, name: string, out = "gaugeline-handoff") =>
  readFileSync(join(dir, out, name), "utf8");
const SECRETS = [
  CLIENT,
  FREELANCER,
  FREELANCER_HOME,
  TEAMMATE,
  COACH,
  VERCEL_TOKEN,
  SANITY_TOKEN,
  GOOGLE_TOKEN,
];

describe("gaugeline handoff: end to end (recorded responses)", () => {
  it("prints who owns what and the findings, writes the three files, and exits 0", async () => {
    const dir = folder(BAR_FILES);
    const r = await run(["handoff", "marlowe-bar.com"], dir);
    expect(r.code).toBe(EXIT.ok);
    const text = lines(r.out);
    expect(text[0]).toBe("Who owns what for marlowe-bar.com");
    expect(
      text.some((l) =>
        /^Vercel\s+Project marlowe-bar-site, in the team "Harbour Studio"\./.test(l),
      ),
    ).toBe(true);
    expect(r.out).toContain("Vercel: The client is not an owner or admin".replace("Vercel: ", ""));
    expect(readdirSync(join(dir, "gaugeline-handoff")).sort()).toEqual([
      "handoff.html",
      "handoff.json",
      "handoff.md",
    ]);
    expect(r.err).toMatch(/Handoff report written to gaugeline-handoff/);
  });

  it("the JSON file is the summary: schema 1, systems, findings and a checklist", async () => {
    const dir = folder(BAR_FILES);
    await run(["handoff", "marlowe-bar.com", "--quiet"], dir);
    const summary = JSON.parse(readOut(dir, "handoff.json")) as Record<string, unknown>;
    expect(summary.schemaVersion).toBe(1);
    expect(summary.site).toBe("marlowe-bar.com");
    expect((summary.systems as { id: string }[]).map((s) => s.id)).toEqual([
      "domain",
      "dns",
      "vercel",
      "sanity",
      "google-business",
      "stripe",
    ]);
    expect((summary.findings as unknown[]).length).toBe(4);
  });

  it("no password, token or full address reaches the screen, the files or the log", async () => {
    const dir = folder(BAR_FILES);
    const r = await run(["handoff", "marlowe-bar.com", "--verbose"], dir);
    const all = [
      r.out,
      r.err,
      ...["handoff.html", "handoff.md", "handoff.json"].map((n) => readOut(dir, n)),
    ].join("\n");
    for (const secret of SECRETS) expect(all, secret).not.toContain(secret);
    expect(all).toContain("r***@marlowe-bar.example");
  });

  it("only GET is sent, and each token goes only to its own provider", async () => {
    const dir = folder(BAR_FILES);
    const r = await run(["handoff", "marlowe-bar.com", "--quiet"], dir);
    expect(new Set(r.seen.map((s) => s.method))).toEqual(new Set(["GET"]));
    for (const s of r.seen) {
      const auth = s.headers.authorization;
      if (auth === undefined) continue;
      const host = new URL(s.url).hostname;
      if (auth.includes(VERCEL_TOKEN)) expect(host).toBe("api.vercel.com");
      else if (auth.includes(SANITY_TOKEN)) expect(host).toBe("api.sanity.io");
      else if (auth.includes(GOOGLE_TOKEN))
        expect(host).toBe("mybusinessaccountmanagement.googleapis.com");
      else throw new Error(`an unexpected Authorization header went to ${host}`);
    }
  });

  it("exits 1 with --ci when a client is not an admin, and still writes the report", async () => {
    const dir = folder(BAR_FILES);
    const r = await run(["handoff", "marlowe-bar.com", "--ci", "--quiet"], dir);
    expect(r.code).toBe(EXIT.findings);
    expect(existsSync(join(dir, "gaugeline-handoff", "handoff.md"))).toBe(true);
  });

  it("exits 0 with --ci when only a medium finding is left", async () => {
    const dir = folder({ "gaugeline.handoff.json": COACH_HANDOFF });
    const r = await run(["handoff", "juniper-coaching.com", "--ci", "--quiet"], dir, {
      env: { ...ENV, SANITY_PROJECT_ID: undefined },
    });
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain("a personal account");
  });

  it("--out names the folder, and --json prints the summary and nothing else", async () => {
    const dir = folder(BAR_FILES);
    const r = await run(
      ["handoff", "marlowe-bar.com", "--json", "--out", "client/handoff", "--quiet"],
      dir,
    );
    expect(r.code).toBe(EXIT.ok);
    expect(JSON.parse(r.out)).toEqual(
      JSON.parse(readOut(dir, "handoff.json", join("client", "handoff"))),
    );
  });

  it("--json with no --out writes nothing", async () => {
    const dir = folder(BAR_FILES);
    const r = await run(["handoff", "marlowe-bar.com", "--json", "--quiet"], dir);
    expect(r.code).toBe(EXIT.ok);
    expect(JSON.parse(r.out).schemaVersion).toBe(1);
    expect(existsSync(join(dir, "gaugeline-handoff"))).toBe(false);
  });

  it("will not replace a report without --force, and says so before asking anything", async () => {
    const dir = folder(BAR_FILES);
    mkdirSync(join(dir, "gaugeline-handoff"));
    writeFileSync(join(dir, "gaugeline-handoff", "handoff.md"), "mine");
    const r = await run(["handoff", "marlowe-bar.com"], dir);
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.err).toMatch(/handoff\.md already exists/);
    expect(r.seen).toEqual([]);
    expect(readOut(dir, "handoff.md")).toBe("mine");
    const forced = await run(["handoff", "marlowe-bar.com", "--force", "--quiet"], dir);
    expect(forced.code).toBe(EXIT.ok);
    expect(readOut(dir, "handoff.md")).toContain("# Who owns what: marlowe-bar.com");
  });

  it("refuses a folder outside the one it ran in, before asking anything", async () => {
    const dir = folder(BAR_FILES);
    const r = await run(["handoff", "marlowe-bar.com", "--out", ".."], dir);
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.err).toMatch(/outside the folder/);
    expect(r.seen).toEqual([]);
  });

  it("a failed write leaves nothing behind and exits 2", async () => {
    const dir = folder(BAR_FILES);
    let writes = 0;
    const failing: ScaffoldFs = {
      ...nodeFs,
      writeFile: (path, text, flag) => {
        writes += 1;
        if (writes === 2)
          return Promise.reject(Object.assign(new Error("disk"), { code: "ENOSPC" }));
        return nodeFs.writeFile(path, text, flag);
      },
    };
    const r = await run(["handoff", "marlowe-bar.com", "--quiet"], dir, {
      handoffFs: failing,
    });
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.err).toMatch(/Nothing was written/);
    expect(existsSync(join(dir, "gaugeline-handoff"))).toBe(false);
  });

  it("without a settings file it still reads, and says what it could not judge", async () => {
    const dir = folder();
    const r = await run(["handoff", "marlowe-bar.com", "--quiet"], dir, {
      env: { NO_COLOR: "1" },
    });
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain("Who owns what for marlowe-bar.com");
    expect(r.out).toMatch(/GAUGELINE_VERCEL_TOKEN is not set|gaugeline\.handoff\.json/);
  });

  it("without a client address it says what to add instead of judging", async () => {
    const dir = folder({
      "gaugeline.handoff.json": { freelancerEmails: [FREELANCER], vercel: BAR_HANDOFF.vercel },
    });
    const r = await run(["handoff", "marlowe-bar.com", "--quiet"], dir);
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toMatch(/clientEmails/);
  });

  it("a settings file that is wrong is exit 2 and says which key, without echoing an address", async () => {
    const dir = folder({ "gaugeline.handoff.json": { clientEmails: ["not an email"] } });
    const r = await run(["handoff", "marlowe-bar.com"], dir);
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.err).toMatch(/gaugeline\.handoff\.json: clientEmails\.0/);
    expect(r.err).not.toContain("not an email");
    expect(r.seen).toEqual([]);
  });

  it("an address in both lists is exit 2", async () => {
    const dir = folder({
      "gaugeline.handoff.json": {
        clientEmails: [CLIENT],
        freelancerEmails: [CLIENT.toUpperCase()],
      },
    });
    const r = await run(["handoff", "marlowe-bar.com"], dir);
    expect(r.code).toBe(EXIT.couldNotRun);
    expect(r.err).toMatch(/both the client's and the freelancer's/);
    expect(r.err).not.toContain(CLIENT);
  });

  it("a site that does not answer is read anyway", async () => {
    const dir = folder(BAR_FILES);
    const down = (host: string) => ({
      status: 0,
      fail: Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" }),
    });
    const r = await run(["handoff", "marlowe-bar.com"], dir, {
      over: {
        "GET https://marlowe-bar.com/": down("marlowe-bar.com"),
        "GET http://marlowe-bar.com/": down("marlowe-bar.com"),
      },
    });
    expect(r.code).toBe(EXIT.ok);
    expect(r.err).toMatch(/The site did not answer/);
    expect(r.err).toMatch(/report was still made/);
    expect(existsSync(join(dir, "gaugeline-handoff", "handoff.md"))).toBe(true);
  });

  it("--dns reads the name servers from DNS", async () => {
    const dir = folder(BAR_FILES);
    const dns = { txt: async () => [], mx: async () => [], ns: async () => ["ns1.vercel-dns.com"] };
    const r = await run(["handoff", "marlowe-bar.com", "--dns", "--quiet"], dir, {
      dns,
    });
    expect(r.out).toMatch(/^DNS\s+Name servers belong to Vercel/m);
  });

  it("without --dns no resolver is used", async () => {
    const dir = folder(BAR_FILES);
    const dns = {
      txt: async () => [],
      mx: async () => [],
      ns: async () => {
        throw new Error("a resolver was used");
      },
    };
    const r = await run(["handoff", "marlowe-bar.com", "--quiet"], dir, { dns });
    expect(r.out).toMatch(/^DNS\s+Name servers belong to Cloudflare/m);
  });
});

describe("gaugeline handoff: the command line", () => {
  it("needs one address", () => {
    expect(parseCliArgs(["handoff"], {})).toMatchObject({ kind: "error" });
    expect(parseCliArgs(["handoff", "a.example", "b.example"], {})).toMatchObject({
      kind: "error",
    });
  });

  it("takes --out, --force, --dns, --ci and --json, and not the page check's notification flags", () => {
    const ok = parseCliArgs(
      ["handoff", "marlowe-bar.com", "--out", "x", "--force", "--dns", "--ci", "--json"],
      {},
    );
    expect(ok).toMatchObject({
      kind: "run",
      command: "handoff",
      handoff: { out: "x", force: true },
      dns: true,
    });
    expect(
      parseCliArgs(["handoff", "marlowe-bar.com", "--slack", "https://hooks.example/x"], {}),
    ).toMatchObject({ kind: "error" });
    expect(parseCliArgs(["handoff", "marlowe-bar.com", "--out", ""], {})).toMatchObject({
      kind: "error",
    });
    expect(parseCliArgs(["handoff", "marlowe-bar.com", "--json", "--force"], {})).toMatchObject({
      kind: "error",
    });
  });

  it("--help lists exactly the flags the command accepts", () => {
    const text = HELP.handoff ?? "";
    for (const f of FLAGS.filter((f) => f.commands.includes("handoff") || f.commands.includes("*")))
      expect(text, f.name).toContain(`--${f.name}`);
    expect(text).toContain("gaugeline handoff <address> [options]");
  });
});
