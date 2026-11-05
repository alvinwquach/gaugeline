import type { ProgressEvent, RequestInfo } from "@gaugeline/core";
import { paint } from "./color.js";

export type Level = "quiet" | "normal" | "verbose";

export interface Logger {
  progress(e: ProgressEvent): void;
  warn(msg: string): void;
  debug(msg: string): void;
  error(msg: string): void;
  request(info: RequestInfo): void;
}

interface Stream {
  write(chunk: string): unknown;
}

/** The exact progress wording from the docs' sample output. Each line starts with one space. */
export function progressLine(e: ProgressEvent): string | undefined {
  switch (e.step) {
    case "load-page":
      return " Loading the page without JavaScript";
    case "robots-sitemap":
      return " Reading robots.txt and the sitemap";
    case "links":
      if (e.count === 0) return undefined;
      return ` Checking ${e.count === 1 ? "1 link" : `${e.count} links`} on the page`;
    case "scripts":
      return " Scanning the site's JavaScript for leaked keys";
    case "debug":
    case "warn":
      return undefined;
    default: {
      const never: never = e;
      return never;
    }
  }
}

/** Addresses in debug lines lose their query string; headers are never printed. */
export function debugAddress(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.split("?")[0] ?? url;
  }
}

/**
 * Writes to one stream, stderr by default. There is no code path that takes stdout. A closed
 * stream (EPIPE) is ignored: losing progress must never change the exit code.
 */
export function createLogger(opts: { level: Level; stream?: Stream; color?: boolean }): Logger {
  const stream: Stream = opts.stream ?? process.stderr;
  const p = paint(opts.color === true);
  const write = (line: string) => {
    try {
      stream.write(`${line}\n`);
    } catch {
      // stderr was closed early; results on stdout and the exit code are unaffected
    }
  };
  const quiet = opts.level === "quiet";
  const verbose = opts.level === "verbose";
  const debug = (msg: string) => {
    if (verbose) write(p.grey(`debug ${msg}`));
  };
  const warn = (msg: string) => {
    if (!quiet) write(p.yellow(`warning: ${msg}`));
  };
  return {
    progress(e) {
      if (e.step === "debug") return debug(e.message);
      if (e.step === "warn") return warn(e.message);
      if (quiet) return;
      const line = progressLine(e);
      if (line !== undefined) write(p.grey(line));
    },
    warn,
    debug,
    error(msg) {
      write(msg);
    },
    request(info) {
      debug(`${info.method} ${debugAddress(info.url)} ${info.status} ${info.ms}ms`);
    },
  };
}
