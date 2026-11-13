import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const dir = fileURLToPath(new URL("../../.github/workflows/", import.meta.url));

describe("GitHub Actions supply chain", () => {
  it("every action in .github/workflows is pinned to a full commit SHA with its version in a comment", () => {
    const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
    expect(files.length).toBeGreaterThan(0);
    const bad: string[] = [];
    for (const f of files) {
      readFileSync(join(dir, f), "utf8")
        .split("\n")
        .forEach((line, i) => {
          const m = /^\s*-?\s*uses:\s*(\S+)(.*)$/.exec(line);
          if (!m || m[1]?.startsWith("./")) return;
          if (!/@[0-9a-f]{40}$/.test(m[1] ?? "") || !/#\s*v\d+(\.\d+)*/.test(m[2] ?? "")) {
            bad.push(`${f}:${i + 1} ${line.trim()}`);
          }
        });
    }
    expect(bad).toEqual([]);
  });

  it("the example workflows are pinned the same way; the weekly one checks daily and sends only with secrets", () => {
    const examples = fileURLToPath(new URL("../../examples/workflows/", import.meta.url));
    const text = readFileSync(join(examples, "weekly.yml"), "utf8");
    for (const [i, line] of text.split("\n").entries()) {
      const m = /^\s*-?\s*uses:\s*(\S+)(.*)$/.exec(line);
      if (!m) continue;
      expect(`${i + 1}: ${m[1] ?? ""}`).toMatch(/@[0-9a-f]{40}$/);
      expect(m[2] ?? "").toMatch(/#\s*v\d+(\.\d+)*/);
    }
    expect(text).toContain('cron: "0 15 * * *"');
    expect(text).toContain("permissions:\n  contents: read\n  actions: read");
    expect(text).toContain("npx --yes gaugeline digest --runs all --time-zone America/Los_Angeles");
    // Sending comes only from secrets; no address or key is written in the file.
    for (const name of [
      "GAUGELINE_EMAIL",
      "RESEND_API_KEY",
      "GAUGELINE_EMAIL_FROM",
      "GAUGELINE_WEBHOOK",
    ])
      expect(text).toContain(`${name}: \${{ secrets.${name} }}`);
  });

  it("CODEOWNERS covers .github/, CLAUDE.md, .mcp.json and package.json", () => {
    const owners = readFileSync(
      fileURLToPath(new URL("../../.github/CODEOWNERS", import.meta.url)),
      "utf8",
    );
    for (const path of ["/.github/", "/CLAUDE.md", "/.mcp.json", "/package.json"]) {
      expect(owners).toMatch(new RegExp(`^${path.replace(/\./g, "\\.")}\\s+@alvinwquach$`, "m"));
    }
  });

  it("dependabot updates npm and github-actions weekly", () => {
    const text = readFileSync(
      fileURLToPath(new URL("../../.github/dependabot.yml", import.meta.url)),
      "utf8",
    );
    for (const eco of ["npm", "github-actions"]) {
      expect(text).toMatch(
        new RegExp(
          `package-ecosystem: ${eco}\\n\\s+directory: /\\n\\s+schedule:\\n\\s+interval: weekly`,
        ),
      );
    }
  });
});

describe("forks and the npm token", () => {
  const read = (f: string) => readFileSync(join(dir, f), "utf8");
  it("the CI workflow never reads a secret and only has read permission", () => {
    const ci = read("ci.yml");
    expect(ci).not.toMatch(/secrets\./);
    expect(ci).toMatch(/permissions:\n\s+contents: read/);
    expect(ci).not.toMatch(/pull_request_target/);
  });

  it("the release workflow runs only on pushes to main and is off unless the owner opts in", () => {
    const release = read("release-pr.yml");
    const on = release.slice(release.indexOf("\non:"), release.indexOf("\npermissions:"));
    expect(on).toMatch(/push:\n\s+branches: \[main\]/);
    expect(on).not.toMatch(/pull_request|tags:|schedule:/);
    expect(release).toContain("if: vars.RELEASE_PR_ENABLED == 'true'");
    expect(release).toContain("vars.PUBLISH_ENABLED == 'true' && 'pnpm run release' || ''");
    expect(release).toMatch(/id-token: write/);
    expect(release).toContain('NPM_CONFIG_PROVENANCE: "true"');
  });
});

describe("K01 publish path, moved into the Release PR workflow by K02", () => {
  it("the old tag-triggered and manual publish workflows are gone; the smoke job runs after a publish", () => {
    const files = readdirSync(dir);
    expect(files).not.toContain("skeleton.yml");
    expect(files).not.toContain("release.yml");
    const release = readFileSync(join(dir, "release-pr.yml"), "utf8");
    expect(release).toContain("if: needs.release.outputs.published == 'true'");
    expect(release).toContain("scripts/smoke-published.sh");
  });
});

describe("docs workflow", () => {
  const text = readFileSync(join(dir, "docs.yml"), "utf8");
  it("a pull request from a fork still builds and uploads, and the preview deploy is skipped without failing", () => {
    expect(text).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(text.slice(text.indexOf("  build:"), text.indexOf("  preview:"))).not.toMatch(
      /secrets\./,
    );
    expect(text).toContain("upload-artifact");
  });

  it("deploys are switched off unless DOCS_DEPLOY_ENABLED is set, and the host lives in one script", () => {
    expect(text.match(/vars\.DOCS_DEPLOY_ENABLED == 'true'/g)).toHaveLength(2);
    expect(text.match(/scripts\/deploy-docs\.sh/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe("faster pull request runs", () => {
  const read = (f: string) => readFileSync(join(dir, f), "utf8");

  // The two JSON strings the CI matrix chooses between, read out of the workflow file itself.
  // OWNER POLICY (11 Nov 2026, "CI diet"): a pull request runs Node 22 on Linux only; the full matrix runs on
  // pushes to main and on the Release pull request (head ref changeset-release/main).
  function matrices(): { pullRequest: unknown; full: unknown } {
    const m =
      /fromJSON\(github\.event_name == 'pull_request' && github\.head_ref != 'changeset-release\/main' && '(.*?)' \|\| '(.*?)'\)/.exec(
        read("ci.yml"),
      );
    if (!m) throw new Error("ci.yml does not choose its matrix from the event and the head ref");
    return { pullRequest: JSON.parse(m[1] ?? ""), full: JSON.parse(m[2] ?? "") };
  }

  it("a pull request runs Linux on Node 22, nothing else", () => {
    expect(matrices().pullRequest).toEqual({ include: [{ os: "ubuntu-latest", node: "22" }] });
  });

  it("the public surface and since checks compare a pull request with the commit its merge ref was built from, not main's moving tip", () => {
    const ci = parse(read("ci.yml")) as {
      jobs: { lint: { steps: { name?: string; run?: string; env?: Record<string, string> }[] } };
    };
    const steps = ci.jobs.lint.steps;
    const fetchIdx = steps.findIndex((s) => s.name === "Fetch the base commit");
    expect(fetchIdx).toBeGreaterThan(-1);
    const step = steps[fetchIdx];
    // A pull request fetches its base commit; any other event keeps fetching the tip of main.
    expect(step?.env?.BASE_SHA).toBe("${{ github.event.pull_request.base.sha }}");
    expect(step?.env?.BASE_REF).toBe("${{ github.base_ref || 'main' }}");
    expect(step?.run).toContain('git fetch --depth=1 origin "${BASE_SHA:-$BASE_REF}"');
    // Both comparisons run against what was fetched: the surface rules inside gen:all, and the since lock.
    const after = steps.slice(fetchIdx + 1).flatMap((s) => (s.run ? [s.run] : []));
    expect(after).toContain("pnpm gen:all --base FETCH_HEAD");
    expect(after).toContain("pnpm since --base FETCH_HEAD");
  });

  it("main and the Release pull request run the full matrix: three systems on Node 22 and 24", () => {
    expect(matrices().full).toEqual({
      os: ["ubuntu-latest", "windows-latest", "macos-latest"],
      node: ["22", "24"],
    });
  });

  it("build-heavy jobs (docs examples, pack and smoke, the local Supabase stack) run on pushes to main and the Release pull request only", () => {
    const ci = parse(read("ci.yml")) as { jobs: Record<string, { if?: string }> };
    for (const job of ["docs-examples", "pack", "supabase-local"]) {
      const cond = ci.jobs[job]?.if ?? "";
      expect(cond, job).toContain("github.event_name == 'push'");
      expect(cond, job).toContain("github.head_ref == 'changeset-release/main'");
    }
    // lint and test are the two jobs every pull request runs.
    expect(ci.jobs.lint?.if).not.toContain("changeset-release");
    expect(ci.jobs.test?.if).not.toContain("changeset-release");
  });

  it("every workflow that runs on pull_request shares one concurrency rule: one group per pull request, a newer run cancels the older, and a run on main is never cancelled", () => {
    // Owner order, 11 Nov 2026. github.workflow keeps the workflows apart; the pull request number keeps
    // the pull requests apart; on a push the ref (refs/heads/main) is main's own group in each workflow.
    const group = "${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}";
    const onPullRequest: string[] = [];
    for (const f of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n))) {
      const wf = parse(read(f)) as {
        on: Record<string, unknown>;
        concurrency?: { group: string; "cancel-in-progress": unknown } | string;
      };
      const events = Object.keys(wf.on);
      if (!events.includes("pull_request")) {
        // A workflow that never runs on a pull request must not cancel a run on main either.
        if (typeof wf.concurrency === "object")
          expect(wf.concurrency["cancel-in-progress"], f).not.toBe(true);
        continue;
      }
      onPullRequest.push(f);
      expect(typeof wf.concurrency, `${f} has a concurrency block`).toBe("object");
      const c = wf.concurrency as { group: string; "cancel-in-progress": unknown };
      expect(c.group, f).toBe(group);
      // Pull request only: cancel the older run. Pull request and push: cancel on a pull request, never on main.
      expect(c["cancel-in-progress"], f).toBe(
        events.includes("push") ? "${{ github.event_name == 'pull_request' }}" : true,
      );
      // The earlier shared "ci-main" group (cancel-in-progress: true) is gone.
      expect(read(f), f).not.toContain("ci-main");
    }
    // The workflows this rule was written for are all covered; a new pull request workflow is covered too.
    expect(onPullRequest).toEqual(
      expect.arrayContaining(["ci.yml", "docs.yml", "pr-checks.yml", "on-merge.yml"]),
    );
  });

  it("every job has a timeout of at most 15 minutes (the release wait for the full matrix is the one longer job)", () => {
    const problems: string[] = [];
    for (const f of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n))) {
      const lines = read(f).split("\n");
      const start = lines.findIndex((l) => l === "jobs:");
      let job = "";
      let timeout: number | undefined;
      const flush = () => {
        if (!job) return;
        const allowed = f === "release-pr.yml" && job === "ci-gate" ? 60 : 15;
        if (timeout === undefined) problems.push(`${f}: ${job} has no timeout-minutes`);
        else if (timeout > allowed)
          problems.push(`${f}: ${job} has ${timeout} minutes (max ${allowed})`);
      };
      for (const l of lines.slice(start + 1)) {
        const j = /^ {2}([a-z][\w-]*):\s*$/.exec(l);
        if (j) {
          flush();
          job = j[1] ?? "";
          timeout = undefined;
          continue;
        }
        const m = /^ {4}timeout-minutes:\s*(\d+)\s*$/.exec(l);
        if (m) timeout = Number(m[1]);
      }
      flush();
    }
    expect(problems).toEqual([]);
  });

  it("the pull request checks are ONE job, pr-checks, that runs the PR gate and then the PR body check", () => {
    const files = readdirSync(dir);
    expect(files).not.toContain("pr-gate.yml");
    expect(files).not.toContain("pr-body.yml");
    const text = read("pr-checks.yml");
    const wf = parse(text) as {
      on: { pull_request: { types: string[] } };
      jobs: Record<string, { name?: string; steps: { run?: string; if?: string }[] }>;
    };
    expect(Object.keys(wf.jobs)).toEqual(["pr-checks"]);
    expect(wf.jobs["pr-checks"]?.name).toBeUndefined(); // the check is reported as "pr-checks"
    const runs = (wf.jobs["pr-checks"]?.steps ?? []).map((s) => s.run ?? "");
    const gate = runs.findIndex((r) => r.startsWith("pnpm pr-gate"));
    const body = runs.findIndex((r) => r === "pnpm pr:check");
    expect(gate).toBeGreaterThan(-1);
    expect(body).toBeGreaterThan(gate);
    // The Release pull request deletes changesets by design, so the gate step skips it; the body check does not.
    expect(wf.jobs["pr-checks"]?.steps[gate]?.if).toContain("changeset-release/main");
    expect(wf.jobs["pr-checks"]?.steps[body]?.if).toBeUndefined();
  });

  it("the docs workflow runs on a pull request only when the docs or what the docs build reads change; it still runs on every push to main", () => {
    const wf = parse(read("docs.yml")) as {
      on: { pull_request: { paths: string[] }; push: { branches: string[]; paths?: unknown } };
    };
    const paths = wf.on.pull_request.paths;
    for (const p of [
      "docs/**",
      "e2e/**",
      "packages/core/src/checks/**",
      "scripts/gen-*",
      "scripts/lib/**",
      ".github/workflows/docs.yml",
    ])
      expect(paths, p).toContain(p);
    expect(wf.on.push.branches).toEqual(["main"]);
    expect(wf.on.push.paths).toBeUndefined();
  });

  it("the release workflow waits for the full matrix of its own commit before it does anything, and never releases a cancelled one", () => {
    const text = read("release-pr.yml");
    expect(text).toContain("ci-gate:");
    expect(text).toContain("actions/workflows/ci.yml/runs?head_sha=$SHA&event=push");
    expect(text).toMatch(/release:\n\s+needs: ci-gate/);
    // A newer merge cancels the older run on main. The gate then fails that commit (it never releases it);
    // the newer commit's own gate waits for its own full matrix and releases everything from there.
    expect(text).toContain('"$conclusion" = "cancelled"');
    expect(text).toContain("success");
  });

  it("the browser tests run only on the decision of scripts/needs-browser-tests.sh", () => {
    const text = read("docs.yml");
    expect(text).toContain("bash scripts/needs-browser-tests.sh");
    for (const step of ["playwright install --with-deps chromium", "pnpm docs:e2e"]) {
      expect(text).toMatch(
        new RegExp(
          `- if: steps\\.browser\\.outputs\\.run == 'true'\\n\\s+run: pnpm (exec )?${step.replace(/^pnpm /, "").replace(/[.]/g, "\\.")}`,
        ),
      );
    }
  });
});

describe("draft pull requests do not run CI", () => {
  type Job = { if?: string | boolean; name?: string };
  type Workflow = { on: Record<string, unknown>; jobs: Record<string, Job> };
  const workflows = readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => ({ f, wf: parse(readFileSync(join(dir, f), "utf8")) as Workflow }));
  // A workflow that only reacts to a pull request closing (on-merge.yml) is not a draft concern.
  const prWorkflows = workflows.filter(({ wf }) => {
    const pr = wf.on.pull_request as { types?: string[] } | null | undefined;
    return pr !== undefined && !(pr?.types && !pr.types.includes("opened"));
  });

  // A conservative evaluator for the small subset of expressions we use: == and != between a context
  // value, a string, true, false or null, joined by && and || with parentheses. It returns the set of
  // outcomes that are possible: a context it does not know makes the comparison undecided. Anything
  // outside the subset throws, so the test fails instead of guessing.
  type Outcomes = Set<boolean>;
  const known = (ctx: Record<string, string | null>, name: string): string | null | undefined =>
    name in ctx ? ctx[name] : undefined;
  function evaluate(source: string, ctx: Record<string, string | null>): Outcomes {
    const text = source.replace(/^\s*\$\{\{|\}\}\s*$/g, "").trim();
    const tokens =
      text.match(/'[^']*'|==|!=|&&|\|\||\(|\)|[A-Za-z_][\w.-]*|\S/g)?.map((t) => t) ?? [];
    let pos = 0;
    const peek = () => tokens[pos];
    const take = () => tokens[pos++];
    const operand = (): string | null | undefined | "?" => {
      const t = take();
      if (t === undefined) throw new Error(`unexpected end of: ${source}`);
      if (t.startsWith("'")) return t.slice(1, -1);
      if (t === "true" || t === "false") return t;
      if (t === "null") return null;
      if (/^[A-Za-z_][\w.-]*$/.test(t)) {
        const v = known(ctx, t);
        return v === undefined ? "?" : v;
      }
      throw new Error(`cannot parse ${t} in: ${source}`);
    };
    const atom = (): Outcomes => {
      if (peek() === "(") {
        take();
        const inner = or();
        if (take() !== ")") throw new Error(`missing ) in: ${source}`);
        return inner;
      }
      const a = operand();
      const op = take();
      if (op !== "==" && op !== "!=") throw new Error(`expected == or != in: ${source}`);
      const b = operand();
      if (a === "?" || b === "?") return new Set([true, false]);
      return new Set([op === "==" ? a === b : a !== b]);
    };
    const combine = (x: Outcomes, y: Outcomes, f: (p: boolean, q: boolean) => boolean) =>
      new Set([...x].flatMap((p) => [...y].map((q) => f(p, q))));
    const and = (): Outcomes => {
      let r = atom();
      while (peek() === "&&") {
        take();
        r = combine(r, atom(), (p, q) => p && q);
      }
      return r;
    };
    function or(): Outcomes {
      let r = and();
      while (peek() === "||") {
        take();
        r = combine(r, and(), (p, q) => p || q);
      }
      return r;
    }
    const result = or();
    if (pos !== tokens.length) throw new Error(`trailing input in: ${source}`);
    return result;
  }
  const condition = (job: Job): string => (typeof job.if === "string" ? job.if : "true == true");
  const DRAFT = "github.event.pull_request.draft";
  const ctxFor = (event: string, draft: "true" | "false" | null) => ({
    "github.event_name": event,
    [DRAFT]: draft,
  });

  it("the evaluator knows the expressions it is used for", () => {
    const safe = "github.event_name != 'pull_request' || github.event.pull_request.draft == false";
    expect(evaluate(safe, ctxFor("pull_request", "true"))).toEqual(new Set([false]));
    expect(evaluate(safe, ctxFor("pull_request", "false"))).toEqual(new Set([true]));
    expect(evaluate(safe, ctxFor("push", null))).toEqual(new Set([true]));
    // A bare draft test is false on a push (the draft field is null there), which is what we must not ship.
    expect(evaluate("github.event.pull_request.draft == false", ctxFor("push", null))).toEqual(
      new Set([false]),
    );
    expect(evaluate("vars.X == 'true' && " + safe, ctxFor("push", null))).toEqual(
      new Set([true, false]),
    );
    expect(() => evaluate("contains(github.ref, 'x')", ctxFor("push", null))).toThrow();
  });

  it("every workflow that runs on a pull request lists ready_for_review, so a ready pull request gets CI at once", () => {
    expect(prWorkflows.map((w) => w.f).sort()).toEqual(["ci.yml", "docs.yml", "pr-checks.yml"]);
    for (const { f, wf } of prWorkflows) {
      const types = (wf.on.pull_request as { types?: string[] } | null)?.types ?? [];
      for (const t of ["opened", "synchronize", "reopened", "ready_for_review"])
        expect(types, `${f} types`).toContain(t);
    }
    // The labels and edits that pr-gate and pr-body reacted to are kept by the merged job.
    const types = (
      prWorkflows.find((w) => w.f === "pr-checks.yml")?.wf.on.pull_request as { types: string[] }
    ).types;
    expect(types).toEqual(expect.arrayContaining(["edited", "labeled", "unlabeled"]));
  });

  it("every job that runs on a pull request is skipped while the pull request is a draft", () => {
    for (const { f, wf } of prWorkflows)
      for (const [name, job] of Object.entries(wf.jobs))
        expect(evaluate(condition(job), ctxFor("pull_request", "true")), `${f}: ${name}`).toEqual(
          new Set([false]),
        );
  });

  it("a ready pull request still runs the jobs that were running before", () => {
    for (const { f, wf } of prWorkflows)
      for (const [name, job] of Object.entries(wf.jobs)) {
        if (/^(production)$/.test(name)) continue; // main only
        expect(
          evaluate(condition(job), ctxFor("pull_request", "false")).has(true),
          `${f}: ${name}`,
        ).toBe(true);
      }
  });

  it("the condition is true for pushes to main, merge groups, schedules, releases and manual runs", () => {
    for (const { f, wf } of prWorkflows)
      for (const [name, job] of Object.entries(wf.jobs)) {
        // preview (pull requests only) and production (main only) are gated by event on purpose.
        if (f === "docs.yml" && (name === "preview" || name === "production")) continue;
        for (const event of ["push", "merge_group", "schedule", "release", "workflow_dispatch"])
          expect(
            evaluate(condition(job), ctxFor(event, null)).has(true),
            `${f}: ${name} on ${event}`,
          ).toBe(true);
      }
  });

  it("the checks a pull request reports are exactly: test (node 22, ubuntu-latest), lint, pr-checks (and build for docs-only changes)", () => {
    const ci = workflows.find((w) => w.f === "ci.yml")?.wf;
    expect(Object.keys(ci?.jobs ?? {})).toEqual(
      expect.arrayContaining(["test", "lint", "docs-examples", "pack"]),
    );
    expect(ci?.jobs.test?.name).toBe("test (node ${{ matrix.node }}, ${{ matrix.os }})");
    expect(ci?.jobs.pack?.name).toBe("pack and smoke (node 22)");
    const { include } = (() => {
      const m =
        /fromJSON\(github\.event_name == 'pull_request' && github\.head_ref != 'changeset-release\/main' && '(.*?)' \|\|/.exec(
          readFileSync(join(dir, "ci.yml"), "utf8"),
        );
      return JSON.parse(m?.[1] ?? "{}") as { include: { os: string; node: string }[] };
    })();
    expect(include.map((m) => `test (node ${m.node}, ${m.os})`)).toEqual([
      "test (node 22, ubuntu-latest)",
    ]);
    expect(Object.keys(workflows.find((w) => w.f === "pr-checks.yml")?.wf.jobs ?? {})).toEqual([
      "pr-checks",
    ]);
  });
});

describe("generated files are regenerated, not committed on branches", () => {
  type Step = {
    name?: string;
    run?: string;
    uses?: string;
    if?: string;
    with?: Record<string, unknown>;
  };
  type Job = {
    name?: string;
    if?: string;
    "timeout-minutes"?: number;
    permissions?: Record<string, string>;
    steps: Step[];
  };
  type Wf = {
    on: Record<string, unknown>;
    permissions?: Record<string, string>;
    concurrency?: { group: string; "cancel-in-progress": boolean };
    jobs: Record<string, Job>;
  };
  const load = (f: string): Wf => parse(readFileSync(join(dir, f), "utf8")) as Wf;
  const runs = (job: Job): string[] => job.steps.flatMap((s) => (s.run ? [s.run] : []));
  const index = (job: Job, pattern: RegExp): number => runs(job).findIndex((r) => pattern.test(r));

  it("ci.yml: every job that builds or tests regenerates first, in the checkout, and never in --check mode", () => {
    const ci = load("ci.yml");
    for (const name of ["test", "docs-examples", "pack"]) {
      const job = ci.jobs[name] as Job;
      const gen = index(job, /^pnpm gen:all --no-surface$/);
      expect(gen, `${name} runs pnpm gen:all --no-surface`).toBeGreaterThan(-1);
      expect(gen, `${name}: after install`).toBeGreaterThan(index(job, /pnpm install/));
      expect(gen, `${name}: before build`).toBeLessThan(index(job, /^pnpm build$/));
    }
    const lint = ci.jobs.lint as Job;
    const lintRuns = runs(lint).join("\n");
    expect(lintRuns).toMatch(/pnpm gen:all --base FETCH_HEAD/);
    // The committed copy is no longer compared with the generated one.
    for (const checkCmd of [
      "docs:flags:check",
      "gen:checks --check",
      "gen:adapters --check",
      "gen:skill --check",
      "surface --check",
    ])
      expect(lintRuns, checkCmd).not.toContain(checkCmd);
    // What is still checked on the branch's own files.
    for (const keep of [
      "pnpm lint",
      "pnpm format:check",
      "pnpm schema:check",
      "pnpm docs:changelog --check",
      "pnpm adr:check",
      "pnpm community:check",
      "pnpm since --base FETCH_HEAD",
    ])
      expect(lintRuns, keep).toContain(keep);
    // The base is fetched before gen:all asks for it, and lint runs on the regenerated tree.
    expect(index(lint, /git fetch --depth=1 origin/)).toBeLessThan(index(lint, /pnpm gen:all/));
    expect(index(lint, /pnpm gen:all/)).toBeLessThan(index(lint, /^pnpm lint$/));
  });

  it("ci.yml stays read-only: the job that writes lives in its own workflow, so CI and the release gate never see it", () => {
    const text = readFileSync(join(dir, "ci.yml"), "utf8");
    expect(text).not.toMatch(/contents: write/);
    expect(text).not.toContain("regenerate.yml");
  });

  it("docs.yml regenerates before it checks and builds the docs", () => {
    const build = load("docs.yml").jobs.build as Job;
    const gen = index(build, /^pnpm gen:all --no-surface$/);
    expect(gen).toBeGreaterThan(index(build, /pnpm install/));
    expect(gen).toBeLessThan(index(build, /^pnpm docs:check$/));
  });

  describe("regenerate.yml", () => {
    const wf = load("regenerate.yml");
    const text = readFileSync(join(dir, "regenerate.yml"), "utf8");
    const job = Object.values(wf.jobs)[0] as Job;

    it("runs on pushes to main only: no pull request, no pull_request_target, no schedule", () => {
      expect(Object.keys(wf.on)).toEqual(["push"]);
      expect(wf.on.push).toEqual({ branches: ["main"] });
    });

    it("has one job, and only that job may write: contents: write there, contents: read for the rest", () => {
      expect(Object.keys(wf.jobs)).toHaveLength(1);
      expect(wf.permissions).toEqual({ contents: "read" });
      expect(job.permissions).toEqual({ contents: "write" });
      expect(text.match(/: write\b/g)).toHaveLength(1);
    });

    it("is serialised in one concurrency group and never cancels a run in progress", () => {
      expect(wf.concurrency).toEqual({
        group: "regenerate-generated-files",
        "cancel-in-progress": false,
      });
    });

    it("cannot loop on its own commit: skips the bot and the commit message it writes", () => {
      expect(job.if).toContain("github.actor != 'github-actions[bot]'");
      expect(job.if).toContain(
        "startsWith(github.event.head_commit.message, 'chore: regenerate generated files')",
      );
    });

    it("checks out main with the token, installs from the lockfile, and runs the script (nothing else commits)", () => {
      const checkout = job.steps.find((s) => s.uses?.startsWith("actions/checkout@"));
      expect(checkout?.with?.ref).toBe("main");
      expect(runs(job)).toEqual([
        "pnpm install --frozen-lockfile",
        "pnpm exec tsx scripts/regenerate-generated.ts",
      ]);
      expect(text).not.toMatch(/git (push|commit|config)/);
      expect(text).not.toContain("--force");
    });

    it("has a timeout of at most 15 minutes, reads no secret and uses no personal token", () => {
      expect(job["timeout-minutes"]).toBeLessThanOrEqual(15);
      expect(text).not.toMatch(/secrets\./);
    });

    it("says in a comment what the owner must allow, so a red run explains itself", () => {
      expect(text).toContain("bypass actor");
    });
  });

  it("the required checks keep their job names: the new workflow adds none", () => {
    const names = Object.values(load("regenerate.yml").jobs).map((j) => j.name ?? "");
    for (const n of names) expect(n).not.toMatch(/^(test|lint|pr-checks)\b/);
    expect((load("ci.yml").jobs.lint as Job).name).toBeUndefined(); // job id "lint"
    expect((load("ci.yml").jobs.test as Job).name).toBe(
      "test (node ${{ matrix.node }}, ${{ matrix.os }})",
    );
  });

  it(".gitattributes marks the files a script owns as generated, so a pull request's diff collapses them", () => {
    const attrs = readFileSync(
      fileURLToPath(new URL("../../.gitattributes", import.meta.url)),
      "utf8",
    );
    for (const f of [
      "docs/checks.data.json",
      "docs/check-ids.lock.json",
      "packages/app/src/check-titles.ts",
      "public-surface.lock.json",
      "docs/adapter-pages.generated.ts",
      "packages/core/src/adapters/entries.generated.ts",
      "packages/core/src/adapters/__tests__/contracts.generated.ts",
    ])
      expect(attrs).toMatch(
        new RegExp(`^${f.replace(/[./]/g, "\\$&")} linguist-generated=true$`, "m"),
      );
    // Files that hold hand-written text beside a generated block are not marked: their hand edits must stay visible.
    for (const f of ["README.md", "docs/options.md", "skills/gaugeline/SKILL.md"])
      expect(attrs).not.toContain(`${f} linguist-generated`);
    expect(attrs).toContain("* text=auto eol=lf");
  });
});
