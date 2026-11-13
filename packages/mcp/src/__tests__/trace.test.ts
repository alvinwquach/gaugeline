/**
 * The MCP server's trace (AG-05): one JSON line per tool call, the shared record shape, written off the
 * call's path by a sink that never fails or leaks a call. Off unless the operator starts the server with --trace.
 */
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import {
  AGENTS_OFF_ENV,
  type AgentTraceRecord,
  agentTraceRecord,
  traceHash,
} from "@gaugeline/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HELP, parseArgs, serverOptions } from "../cli.js";
import { MCP_AGENT_ID } from "../policy.js";
import type { ServerOptions } from "../state.js";
import { createStreamTraceSink, type TraceSink } from "../trace.js";
import { connect, textOf } from "./helpers.js";

const NOW = new Date("2026-11-13T12:00:00.000Z");
// Invented secrets, built at run time so no scanner mistakes this file for a leak.
const FAKE_KEY = ["sk", "live", "TRACEFAKE00000000000000"].join("_");
const FAKE_MAIL = ["guest.list", "juniper-popup.test"].join("@");
const PAGE = `<!doctype html><html><head><title>Pop-up menu ${FAKE_MAIL}</title></head><body>Menu</body></html>`;
let site: Server;
let url = "";

beforeAll(async () => {
  site = createServer((_, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(PAGE);
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(site.address() as { port: number }).port}/?token=${FAKE_KEY}`;
});
afterAll(async () => {
  await new Promise((r) => site.close(r));
});

/** A sink that keeps the records in memory, and a way to wait until the calls' lines have landed. */
function memorySink(): TraceSink & { records: AgentTraceRecord[] } {
  const records: AgentTraceRecord[] = [];
  return { records, write: (r) => void records.push(r) };
}
const settled = () => new Promise((r) => setImmediate(r));

async function calls(
  options: ServerOptions,
  run: (call: (n: string, a?: object) => Promise<unknown>) => Promise<void>,
) {
  const c = await connect({
    allowPrivate: true,
    now: () => NOW,
    env: {},
    onDeny: () => {},
    ...options,
  });
  try {
    await run(async (name, args = {}) =>
      textOf(await c.client.callTool({ name, arguments: args as Record<string, unknown> })),
    );
    await settled();
    await settled();
  } finally {
    await c.close();
  }
}

describe("one trace line per call, the shared shape", () => {
  it("passing fixture: an allowed call leaves one record with hashes, integer latency, 0 tokens and cost", async () => {
    const sink = memorySink();
    const args = { area: "Visitors" };
    await calls({ trace: sink }, async (call) => {
      await call("list_checks", args);
    });
    expect(sink.records).toHaveLength(1);
    const r = sink.records[0]!;
    expect(r).toMatchObject({
      v: 1,
      at: NOW.toISOString(),
      agentId: MCP_AGENT_ID,
      tool: "list_checks",
      inputSha256: traceHash(args),
      latencyMs: 0,
      tokens: 0,
      costMicros: 0,
      decision: "allowed",
      reason: null,
      approverId: null,
      error: false,
    });
    expect(r.outputSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("failing fixture: a denied call leaves one record with the reason and no output hash", async () => {
    const sink = memorySink();
    await calls({ trace: sink, allowedTools: ["list_checks"] }, async (call) => {
      await call("run_check", { url, checks: ["viewport"] });
    });
    expect(sink.records.map((r) => [r.tool, r.decision, r.reason, r.outputSha256])).toEqual([
      ["run_check", "denied", "scope", null],
    ]);
  });

  it("the global kill switch is traced as a deny too, and two calls at once leave two lines", async () => {
    const sink = memorySink();
    const env: Record<string, string | undefined> = { [AGENTS_OFF_ENV]: "1" };
    await calls({ trace: sink, env }, async (call) => {
      await call("list_checks");
      delete env[AGENTS_OFF_ENV];
      await Promise.all([call("list_checks"), call("list_checks", { area: "Visitors" })]);
    });
    expect(sink.records.map((r) => r.decision).sort()).toEqual(["allowed", "allowed", "denied"]);
  });

  it("a tool error is traced as allowed with error true", async () => {
    const sink = memorySink();
    await calls({ trace: sink }, async (call) => {
      await call("explain_finding", { id: "no-such-finding-or-check" });
    });
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]).toMatchObject({ decision: "allowed", error: true, outputSha256: null });
  });
});

describe("nothing from the call or the page is stored", () => {
  it("a URL with a key in its query and a page with an email leave neither in the trace line", async () => {
    const out: string[] = [];
    const sink = createStreamTraceSink({ write: (c: string) => out.push(c) });
    await calls({ trace: sink }, async (call) => {
      await call("run_check", { url, checks: ["viewport"] });
    });
    const text = out.join("");
    expect(text.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(text)).toMatchObject({ tool: "run_check", decision: "allowed" });
    for (const s of [FAKE_KEY, FAKE_MAIL, "127.0.0.1", "token=", "Pop-up", "viewport"])
      expect(text).not.toContain(s);
  });
});

describe("the sink never fails or leaks a call", () => {
  it("a sink that throws: the call is answered as usual, with nothing from the error", async () => {
    const throwing: TraceSink = {
      write: () => {
        throw new Error(`disk full ${FAKE_KEY}`);
      },
    };
    await calls({ trace: throwing }, async (call) => {
      const r = (await call("list_checks")) as { text: string; isError: boolean };
      expect(r.isError).toBe(false);
      expect(r.text).not.toContain("disk full");
    });
  });

  it("a stream that throws: calls go on, the failures are counted", async () => {
    const sink = createStreamTraceSink({
      write: () => {
        throw new Error("EPIPE");
      },
    });
    await calls({ trace: sink }, async (call) => {
      for (let i = 0; i < 3; i++)
        expect(((await call("list_checks")) as { isError: boolean }).isError).toBe(false);
    });
    expect(sink.stats()).toEqual({ written: 0, failed: 3, dropped: 0 });
    // And on its own, outside the server's own guard.
    const rec = agentTraceRecord({
      at: NOW.toISOString(),
      agentId: MCP_AGENT_ID,
      tool: "list_checks",
      inputSha256: null,
      outputSha256: null,
      latencyMs: 0,
      tokens: 0,
      costMicros: 0,
      decision: "allowed",
    });
    expect(() => sink.write(rec)).not.toThrow();
  });

  it("a stream that cannot keep up: lines past the byte cap are dropped and counted, never buffered", () => {
    const stream = {
      writableLength: 0,
      chunks: [] as string[],
      write(c: string) {
        this.chunks.push(c);
        this.writableLength += c.length;
      },
    };
    const sink = createStreamTraceSink(stream, { maxBufferedBytes: 500 });
    const rec = agentTraceRecord({
      at: NOW.toISOString(),
      agentId: MCP_AGENT_ID,
      tool: "list_checks",
      inputSha256: null,
      outputSha256: null,
      latencyMs: 0,
      tokens: 0,
      costMicros: 0,
      decision: "allowed",
    });
    for (let i = 0; i < 10; i++) sink.write(rec);
    const { written, dropped } = sink.stats();
    expect(sink.stats().failed).toBe(0);
    expect(written + dropped).toBe(10);
    expect(dropped).toBeGreaterThan(0);
    expect(stream.writableLength).toBeLessThan(500 + 400);
  });
});

describe("the operator flag", () => {
  it("off by default; --trace sends the lines to the server's stderr", async () => {
    expect(parseArgs([], "/srv").trace).toBe(false);
    expect(parseArgs(["--trace"], "/srv").trace).toBe(true);
    const quiet = { env: {}, stderr: { write: () => true } };
    expect(serverOptions(parseArgs([], "/srv"), quiet).trace).toBeUndefined();
    const err: string[] = [];
    const io = { env: {}, stderr: { write: (c: string) => err.push(c) } };
    const options = serverOptions(parseArgs(["--trace"], "/srv"), io);
    await calls({ ...options, now: () => NOW }, async (call) => {
      await call("list_checks");
    });
    const lines = err.filter((l) => l.startsWith("{"));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      v: 1,
      agentId: MCP_AGENT_ID,
      tool: "list_checks",
    });
  });

  it("--help and docs/mcp.md both name the flag and its default", () => {
    const page = readFileSync(
      fileURLToPath(new URL("../../../../docs/mcp.md", import.meta.url)),
      "utf8",
    );
    const section = page.slice(page.indexOf("## The trace"), page.indexOf("## The agent policy"));
    expect(section).toContain("`--trace`");
    expect(section).toMatch(/off by default/i);
    expect(HELP).toContain("  --trace ");
  });
});
