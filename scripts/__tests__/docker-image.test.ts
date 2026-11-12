import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
// A line, with its backslash continuations joined: "RUN a \\\n && b" is one instruction.
const instructions = dockerfile
  .replace(/\\\r?\n/g, " ")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l !== "" && !l.startsWith("#"));
const of = (name: string) =>
  instructions
    .filter((l) => l.toUpperCase().startsWith(`${name} `))
    .map((l) => l.slice(name.length + 1));

describe("Dockerfile (static: nothing is built in CI)", () => {
  it("has one base image, pinned by digest", () => {
    expect(of("FROM")).toHaveLength(1);
    expect(of("FROM")[0]).toMatch(/^node:22-slim@sha256:[0-9a-f]{64}$/);
  });

  it("uses a Node version the CLI supports", () => {
    const engines = JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8"))
      .engines.node as string;
    const major = Number(/\d+/.exec(engines)?.[0]);
    expect(Number(/^node:(\d+)/.exec(of("FROM")[0] ?? "")?.[1])).toBeGreaterThanOrEqual(major);
  });

  it("links the image to this repository for the GitHub Container Registry, and states the licence", () => {
    const labels = of("LABEL").join(" ");
    expect(labels).toContain(
      'org.opencontainers.image.source="https://github.com/alvinwquach/gaugeline"',
    );
    expect(labels).toContain('org.opencontainers.image.licenses="MIT"');
    expect(dockerfile).toContain("ghcr.io/alvinwquach/gaugeline");
  });

  it("ends as a non-root user", () => {
    const users = of("USER");
    expect(users.length).toBeGreaterThan(0);
    expect(users.at(-1)).not.toMatch(/^(root|0)(:|$)/);
  });

  it("starts the CLI through an exec-form entrypoint, so signals and exit codes reach docker", () => {
    expect(of("ENTRYPOINT")).toEqual(['["gaugeline-entrypoint"]']);
    expect(of("CMD")).toEqual(['["--help"]']);
  });

  it("installs one exact release: the version is a required build argument, and install scripts are off", () => {
    const run = of("RUN").join("\n");
    expect(of("ARG")).toEqual(["GAUGELINE_VERSION", "VCS_REF=unknown"]);
    expect(run).toContain('"gaugeline@${GAUGELINE_VERSION}"');
    expect(run).toContain("--ignore-scripts");
    expect(run).not.toMatch(/gaugeline@latest/);
  });

  describe.skipIf(process.platform === "win32")(
    "the version check, run as the build runs it",
    () => {
      // The first RUN is the check on its own: it is executed here with each value.
      const check = of("RUN").find(
        (r) => r.includes("GAUGELINE_VERSION") && !r.includes("npm install"),
      );
      const verdict = (version: string | undefined) =>
        spawnSync("sh", ["-c", check ?? "exit 99"], {
          encoding: "utf8",
          env: {
            PATH: process.env.PATH ?? "",
            ...(version === undefined ? {} : { GAUGELINE_VERSION: version }),
          },
        });
      it("accepts an exact release or pre-release", () => {
        for (const v of ["1.2.3", "0.1.0", "10.20.30", "1.0.0-rc.1", "2.0.0-beta-2"])
          expect(verdict(v).status, v).toBe(0);
      });
      it("refuses everything else, with a message and a non-zero exit", () => {
        const refused = [
          undefined,
          "",
          "latest",
          "^1.0.0",
          "1.2",
          "v1.2.3",
          "npm:other@1.0.0",
          "https://evil.example/p.tgz",
          "file:../p",
          "1.2.3 --registry=https://evil.example",
          "1.2.3\n4.5.6",
          "1.2.3;id",
          "$(id)",
        ];
        for (const v of refused) {
          const r = verdict(v);
          expect(r.status, JSON.stringify(v)).not.toBe(0);
          expect(r.stderr, JSON.stringify(v)).toContain("exact release");
        }
      });
    },
  );

  it("makes /work writable by the user the container runs as", () => {
    const lines = instructions;
    const workdir = lines.findIndex((l) => l === "WORKDIR /work");
    const chown = lines.findIndex((l) => /^RUN chown (-R )?node:node \/work$/.test(l));
    const user = lines.findIndex((l) => l === "USER node");
    expect(workdir).toBeGreaterThan(-1);
    expect(chown).toBeGreaterThan(workdir);
    expect(user).toBeGreaterThan(chown);
  });

  it("labels the version and the revision from build arguments", () => {
    const labels = of("LABEL").join(" ");
    expect(labels).toContain('org.opencontainers.image.version="${GAUGELINE_VERSION}"');
    expect(labels).toContain('org.opencontainers.image.revision="${VCS_REF}"');
  });

  it("bakes in no secret, fetches nothing by URL and pipes nothing into a shell", () => {
    const env = [...of("ENV"), ...of("ARG")].join("\n");
    expect(env).not.toMatch(/KEY|TOKEN|SECRET|PASSWORD|WEBHOOK|BYPASS|AUTH/i);
    expect(dockerfile).not.toMatch(/^\s*ADD\s/m);
    expect(dockerfile).not.toMatch(/(curl|wget)[^\n]*\|\s*(sh|bash)/);
    expect(of("COPY")).toEqual([
      "--chmod=0755 docker/entrypoint.sh /usr/local/bin/gaugeline-entrypoint",
    ]);
  });

  it("needs to write nowhere but /work and /tmp (read-only friendly): its docs say how to run it", () => {
    expect(dockerfile).toContain("--read-only --tmpfs /tmp");
    expect(of("WORKDIR")).toEqual(["/work"]);
  });

  it(".dockerignore sends only the entrypoint to the build", () => {
    expect(
      readFileSync(join(root, ".dockerignore"), "utf8")
        .split("\n")
        .filter((l) => l && !l.startsWith("#")),
    ).toEqual(["*", "!docker/entrypoint.sh"]);
  });
});

describe.skipIf(process.platform === "win32")("docker/entrypoint.sh", () => {
  const dir = mkdtempSync(join(tmpdir(), "gaugeline-entry-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  // A stand-in CLI that prints what it was given and exits with the code in FAKE_EXIT.
  writeFileSync(join(dir, "gaugeline"), '#!/bin/sh\nprintf "%s\\n" "$@"\nexit "${FAKE_EXIT:-0}"\n');
  chmodSync(join(dir, "gaugeline"), 0o755);
  const entry = (args: string[], exit = "0") =>
    spawnSync("sh", [join(root, "docker/entrypoint.sh"), ...args], {
      encoding: "utf8",
      env: { PATH: `${dir}${delimiter}${process.env.PATH}`, FAKE_EXIT: exit },
    });

  it("passes every argument through untouched, spaces and quotes included", () => {
    const r = entry(["https://brightside.example/", "--format", "sarif", "a b", "it's"]);
    expect(r.stdout).toBe("https://brightside.example/\n--format\nsarif\na b\nit's\n");
  });

  it("is the CLI's exit code: 0, 1 and 2 reach docker unchanged", () => {
    for (const code of ["0", "1", "2"])
      expect(entry(["https://brightside.example/", "--ci"], code).status).toBe(Number(code));
  });

  it("with no arguments prints the CLI's help", () => {
    expect(entry([]).stdout).toBe("--help\n");
  });

  it("is a plain POSIX shell script with LF line endings", () => {
    const text = readFileSync(join(root, "docker/entrypoint.sh"), "utf8");
    expect(text.startsWith("#!/bin/sh\n")).toBe(true);
    expect(text).not.toContain("\r");
    expect(text).toContain("set -eu");
    expect(text).toContain('exec gaugeline "$@"');
  });
});
