import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resultSchema, type Transport } from "@gaugeline/core";
import { afterEach, describe, expect, it } from "vitest";
import { WP_ENV, WP_USER } from "../../../core/src/adapters/__tests__/entries.js";
import { wordpressTransport } from "../../../core/src/adapters/__tests__/wordpress-fixture.js";
import { html, worldTransport } from "../../../core/src/advisory/__tests__/world.js";
import {
  ROUTES,
  wpPage,
  wpWorld,
  type SiteDef,
} from "../../../core/src/wordpress/__tests__/world.js";
import { parseCliArgs } from "../args.js";
import { FLAGS } from "../flags.js";
import { HELP } from "../help.js";
import { EXIT, main } from "../main.js";
import { runAll } from "../run-all.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function folder(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gaugeline-wordpress-")));
  dirs.push(dir);
  return dir;
}

const BAR = "harbour-bar.example";
const HARBOUR: SiteDef = {
  routes: {
    "/": wpPage({
      generator: "WordPress 6.2.1",
      plugins: [
        ["easy-booking", "2.1.3"],
        ["gallery-lite", "1.3.0"],
      ],
    }),
    ...ROUTES.usersOpen,
  },
};

async function run(argv: string[], cwd: string, transport?: Transport, env = {}) {
  const world = wpWorld({ [BAR]: HARBOUR });
  const seen: { method: string; url: string }[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const recorded: Transport = (url, req) => {
    seen.push({ method: req.method, url: url.href });
    return (transport ?? world.transport)(url, req);
  };
  const code = await main(
    argv,
    {
      stdout: { write: (s) => out.push(s) },
      stderr: { write: (s) => err.push(s) },
      env: { NO_COLOR: "1", ...env },
    },
    { cwd, fetcher: { transport: recorded } } as never,
  );
  return { code, out: out.join(""), err: err.join(""), seen };
}

const wpResult = (text: string) => {
  const result = resultSchema.parse(JSON.parse(text));
  const mine = (id: string) => id === "wp-outdated" || id === "wp-users-exposed";
  return {
    findings: result.findings.filter((f) => mine(f.checkId)),
    couldNotCheck: result.couldNotCheck.filter((c) => mine(c.id)),
  };
};

describe("--wordpress: parsing, run --all, help and flags", () => {
  it("parses --wordpress on the page check and on run, off by default", () => {
    const a = parseCliArgs([BAR, "--wordpress"], {});
    expect(a.kind === "run" && a.wordpress).toBe(true);
    const b = parseCliArgs(["run", "--all", "--wordpress"], {});
    expect(b.kind === "run-all" && b.wordpress).toBe(true);
    const c = parseCliArgs([BAR], {});
    expect(c.kind === "run" && c.wordpress).toBe(false);
  });

  it("run --all --wordpress hands the flag to every site's run", async () => {
    const dir = folder();
    mkdirSync(join(dir, "runs"));
    const seen: string[][] = [];
    const site = {
      name: "bar",
      address: `https://${BAR}`,
      host: BAR,
      configDir: dir,
      permission: { by: "Ines Duarte, owner of Harbour Bar", on: "2026-11-01" },
    };
    const runOne = async (argv: string[]) => {
      seen.push(argv);
      return 0;
    };
    await runAll([site], { runsDir: join(dir, "runs"), env: {}, wordpress: true, runOne });
    await runAll([site], { runsDir: join(dir, "runs"), env: {}, runOne });
    expect(seen[0]).toContain("--wordpress");
    expect(seen[1]).not.toContain("--wordpress");
  });

  it("the flag is on the page check and on run, and in --help", () => {
    const flag = FLAGS.find((f) => f.name === "wordpress");
    expect(flag?.commands).toEqual(["check", "run"]);
    expect(HELP[""]).toContain("--wordpress");
  });
});

describe("gaugeline check --wordpress: end to end (the invented bar, in memory)", () => {
  it("names the plugin and WordPress behind, and the users the REST API lists", async () => {
    const r = await run([BAR, "--wordpress", "--no-open", "--quiet"], folder());
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain(
      "WordPress 6.2.1 is shown (read from the generator tag); the current release in the wordpress.org API is 6.8.3.",
    );
    expect(r.out).toContain(
      "The plugin easy-booking 2.1.3 is shown (read from the ?ver= on its files on this page); the current release in the wordpress.org directory is 2.4.0.",
    );
    expect(r.out).toContain("listed 2 users");
    expect(r.out).not.toContain("gallery-lite 1.3.0");
  });

  it("--json carries three medium findings", async () => {
    const r = await run([BAR, "--wordpress", "--json", "--no-open", "--quiet"], folder());
    const got = wpResult(r.out);
    expect(got.findings.map((f) => [f.checkId, f.severity])).toEqual([
      ["wp-outdated", "medium"],
      ["wp-outdated", "medium"],
      ["wp-users-exposed", "medium"],
    ]);
  });

  it("a medium finding is not a reason to fail a --ci run", async () => {
    const r = await run([BAR, "--wordpress", "--ci", "--no-open", "--quiet"], folder());
    expect(r.code).toBe(EXIT.ok);
  });

  it("is not in the run without --wordpress: no finding, no request to wordpress.org or the users route", async () => {
    const r = await run([BAR, "--json", "--no-open", "--quiet"], folder());
    expect(wpResult(r.out)).toEqual({ findings: [], couldNotCheck: [] });
    expect(
      r.seen.some((s) => s.url.includes("api.wordpress.org") || s.url.includes("/users")),
    ).toBe(false);
  });

  it("asks only GET or HEAD, only the site and api.wordpress.org, and never a login, admin or xmlrpc path", async () => {
    const r = await run([BAR, "--wordpress", "--no-open", "--quiet"], folder());
    expect(r.seen.every((s) => s.method === "GET" || s.method === "HEAD")).toBe(true);
    // What --wordpress adds to a run is the wordpress.org API and the users route, and nothing else.
    const plain = await run([BAR, "--no-open", "--quiet"], folder());
    const before = new Set(plain.seen.map((s) => s.url));
    const added = r.seen.map((s) => s.url).filter((u) => !before.has(u));
    expect(added.sort()).toEqual(
      [
        `https://${BAR}/wp-json/wp/v2/users?per_page=100&_fields=id`,
        "https://api.wordpress.org/core/version-check/1.7/",
        "https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&request%5Bslug%5D=easy-booking",
        "https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&request%5Bslug%5D=gallery-lite",
      ].sort(),
    );
    expect(r.seen.some((s) => /xmlrpc|wp-login|wp-admin|wp-config|\.env/.test(s.url))).toBe(false);
  });
});

describe("gaugeline advisory: the WordPress adapter's read reaches the answer", () => {
  const SPEC = "wp-plugin:easy-booking@<2.4.0";

  function transport(): Transport {
    // The site shows no version on the plugin's files; the REST API, asked with the application password, lists it.
    const site = worldTransport({
      [BAR]: {
        headers: { server: "nginx", "x-powered-by": "PHP/8.1.27" },
        routes: {
          "/": html({
            head: '<meta name="generator" content="WordPress 6.4.2">',
            scripts: ["/wp-content/plugins/easy-booking/js/app.js"],
          }),
        },
      },
    }).transport;
    const rest = wordpressTransport(undefined, {
      app: { user: WP_USER, password: WP_ENV.WORDPRESS_APP_PASSWORD },
    });
    return (url, req) => (url.pathname.startsWith("/wp-json/") ? rest(url, req) : site(url, req));
  }

  const settings = JSON.stringify({ adapters: [{ id: "wordpress" }] });
  const env = { ...WP_ENV, WORDPRESS_URL: `https://${BAR}` };

  async function advise(cwd: string, withEnv: Record<string, string> = env) {
    return run(["advisory", BAR, SPEC, "--json"], cwd, transport(), withEnv);
  }

  it("without gaugeline.adapters.json naming wordpress the page's files alone give cannot-tell", async () => {
    const r = await advise(folder());
    expect(JSON.parse(r.out)).toMatchObject({ verdict: "cannot-tell" });
    expect(r.seen.some((s) => s.url.includes("/wp-json/"))).toBe(false);
  });

  it("with it, the plugin's installed version is used: likely-affected, from the adapter's read", async () => {
    const dir = folder();
    writeFileSync(join(dir, "gaugeline.adapters.json"), settings);
    const r = await advise(dir);
    const got = JSON.parse(r.out) as { verdict: string };
    expect(got.verdict).toBe("likely-affected");
    expect(r.out).toContain("the WordPress adapter's read");
    expect(r.out).not.toContain(WP_ENV.WORDPRESS_APP_PASSWORD);
    expect(r.seen.every((s) => s.method === "GET")).toBe(true);
  });

  it("a user who may not list plugins: a note on stderr, and the answer is what the page shows", async () => {
    const dir = folder();
    writeFileSync(join(dir, "gaugeline.adapters.json"), settings);
    const r = await advise(dir, { ...env, WORDPRESS_APP_PASSWORD: "wrong-key-for-this-user" });
    expect(JSON.parse(r.out)).toMatchObject({ verdict: "cannot-tell" });
    expect(r.err).toContain("The WordPress adapter's list of installed plugins was not read");
    expect(r.err).not.toContain("wrong-key-for-this-user");
  });

  it("no key set: the same note, naming the variables", async () => {
    const dir = folder();
    writeFileSync(join(dir, "gaugeline.adapters.json"), settings);
    const r = await advise(dir, { WORDPRESS_URL: `https://${BAR}` });
    expect(r.err).toContain("WORDPRESS_USER and WORDPRESS_APP_PASSWORD are not set");
  });
});
