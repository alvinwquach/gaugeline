import { execFileSync } from "node:child_process";
import {
  chownSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A throwaway Postgres server for the integration tests: initdb into a temporary folder, listen on
 * 127.0.0.1 on a random port, stop and delete everything afterwards. It never touches a database
 * that exists. When no server program is installed (or on Windows), `findPostgres()` is undefined
 * and the tests that need it are skipped with a message; the socket-level tests still run.
 */

export interface PostgresBin {
  dir: string;
}

const EXE = process.platform === "win32" ? ".exe" : "";

/** The folder holding initdb and pg_ctl: on PATH, or the newest /usr/lib/postgresql/<n>/bin. */
export function findPostgres(): PostgresBin | undefined {
  if (process.platform === "win32") return undefined;
  const candidates: string[] = [];
  for (const dir of (process.env.PATH ?? "").split(":")) if (dir) candidates.push(dir);
  const base = "/usr/lib/postgresql";
  if (existsSync(base)) {
    const versions = readdirSync(base)
      .filter((v) => /^\d+$/.test(v))
      .sort((a, b) => Number(b) - Number(a));
    for (const v of versions) candidates.push(join(base, v, "bin"));
  }
  for (const dir of candidates)
    if (existsSync(join(dir, `initdb${EXE}`)) && existsSync(join(dir, `pg_ctl${EXE}`)))
      return { dir };
  return undefined;
}

/** Why the integration tests are skipped, for the test title. */
export const SKIP_REASON =
  "no Postgres server program (initdb, pg_ctl) found, so the tests against a real server are skipped; the socket-level tests still prove the read-only guarantee";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const address = s.address();
      s.close(() =>
        address && typeof address !== "string"
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });
}

export interface LocalPostgres {
  port: number;
  /** The password of the superuser "postgres", for setting the tables up. */
  adminPassword: string;
  /** The server's log, to see which statements arrived. */
  log(): string;
  stop(): void;
}

export async function startLocalPostgres(bin: PostgresBin): Promise<LocalPostgres> {
  const root = typeof process.getuid === "function" && process.getuid() === 0;
  // Postgres refuses to run as root: in a sandbox that is root, run it as the postgres user.
  let asUser: string[] = [];
  let dir: string;
  let owner: { uid: number; gid: number } | undefined;
  if (root) {
    const uid = Number(execFileSync("id", ["-u", "postgres"], { encoding: "utf8" }).trim());
    const gid = Number(execFileSync("id", ["-g", "postgres"], { encoding: "utf8" }).trim());
    owner = { uid, gid };
    dir = mkdtempSync(join("/tmp", "gaugeline-pg-"));
    chownSync(dir, uid, gid);
    asUser = ["runuser", "-u", "postgres", "--"];
  } else {
    dir = mkdtempSync(join(tmpdir(), "gaugeline-pg-"));
  }
  const run = (program: string, args: string[]): string => {
    const cmd = asUser.length > 0 ? asUser : [];
    const [file, ...rest] = [...cmd, join(bin.dir, program + EXE), ...args];
    return execFileSync(file as string, rest, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
  };
  const adminPassword = ["admin", "pw", String(Date.now())].join("-");
  const pwfile = join(dir, "pw");
  writeFileSync(pwfile, `${adminPassword}\n`, { mode: 0o600 });
  if (owner) chownSync(pwfile, owner.uid, owner.gid);
  const data = join(dir, "data");
  const port = await freePort();
  const logfile = join(dir, "server.log");
  const stop = (): void => {
    try {
      run("pg_ctl", ["-D", data, "-m", "immediate", "stop"]);
    } catch {
      // Already stopped.
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  try {
    run("initdb", [
      "-D",
      data,
      "-A",
      "scram-sha-256",
      `--pwfile=${pwfile}`,
      "-U",
      "postgres",
      "-E",
      "UTF8",
      "--locale=C",
      "--no-sync",
    ]);
    run("pg_ctl", [
      "-D",
      data,
      "-o",
      `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories=${dir} -c fsync=off -c log_statement=all -c logging_collector=off`,
      "-l",
      logfile,
      "-w",
      "start",
    ]);
  } catch (err) {
    stop();
    throw err;
  }
  return {
    port,
    adminPassword,
    log: () => {
      try {
        return readFileSync(logfile, "utf8");
      } catch {
        return "";
      }
    },
    stop,
  };
}
