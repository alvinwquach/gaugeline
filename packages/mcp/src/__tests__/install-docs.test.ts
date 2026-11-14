import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startFixture, type Fixture } from "@gaugeline/fixtures";
import { TOOLS } from "../registry.js";
import { jsonOf } from "./helpers.js";

/**
 * Every client snippet on docs/mcp-install.md is started here, exactly as that client would start it
 * (command, args, env), against the built bin over stdio. A snippet is a fenced block whose info string
 * carries `client=<id>`; a page edit that breaks a snippet breaks this test.
 */
const bin = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../../../docs/${rel}`, import.meta.url)), "utf8");
const page = read("mcp-install.md");
const fixtures: Fixture[] = [];
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await Promise.all(fixtures.splice(0).map((f) => f.close()));
});

interface Launch {
  command: string;
  args: string[];
  env: Record<string, string>;
}
interface Block {
  info: string;
  body: string;
}

function blocks(markdown: string): Block[] {
  const out: Block[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const open = /^```(.*)$/.exec(lines[i] ?? "");
    if (!open) continue;
    let end = i + 1;
    while (end < lines.length && !(lines[end] ?? "").startsWith("```")) end++;
    out.push({ info: open[1] ?? "", body: lines.slice(i + 1, end).join("\n") });
    i = end;
  }
  return out;
}

const clientOf = (b: Block) => /(?:^|\s)client=([a-z0-9-]+)/.exec(b.info)?.[1];

/** A JSON object of servers: `mcpServers` (Claude, Cursor, Windsurf) or `servers` (VS Code). */
function fromServersJson(body: string): Launch {
  const doc = JSON.parse(body) as Record<string, Record<string, Record<string, unknown>>>;
  const servers = doc.mcpServers ?? doc.servers;
  const entry = servers?.gaugeline;
  if (!entry) throw new Error("no gaugeline entry");
  return {
    command: String(entry.command),
    args: (entry.args as string[] | undefined) ?? [],
    env: (entry.env as Record<string, string> | undefined) ?? {},
  };
}

/** `claude mcp add [options] gaugeline -- command args...`, one line. */
function fromClaudeCodeCommand(body: string): Launch {
  const line = body
    .split("\n")
    .map((l) => l.replace(/^\$ /, "").trim())
    .find((l) => l.startsWith("claude mcp add"));
  if (!line) throw new Error("no claude mcp add line");
  const words = line.split(/\s+/);
  const dash = words.indexOf("--");
  expect(dash, "the command must come after a -- separator").toBeGreaterThan(0);
  const env: Record<string, string> = {};
  words.slice(0, dash).forEach((w, i, all) => {
    if (all[i - 1] === "--env") env[w.slice(0, w.indexOf("="))] = w.slice(w.indexOf("=") + 1);
  });
  return { command: words[dash + 1] ?? "", args: words.slice(dash + 2), env };
}

/** `code --add-mcp '{"name":"gaugeline","type":"stdio","command":"npx","args":[...]}'`. */
function fromVsCodeCommand(body: string): Launch {
  const m = /--add-mcp '(\{.*\})'/.exec(body);
  if (!m?.[1]) throw new Error("no code --add-mcp line");
  const entry = JSON.parse(m[1]) as Record<string, unknown>;
  expect(entry.name).toBe("gaugeline");
  return {
    command: String(entry.command),
    args: (entry.args as string[] | undefined) ?? [],
    env: (entry.env as Record<string, string> | undefined) ?? {},
  };
}

/** The small subset of TOML the Codex snippet uses: one table, `command`, `args`, an optional env table. */
function fromCodexToml(body: string): Launch {
  const launch: Launch = { command: "", args: [], env: {} };
  let table = "";
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      table = header[1] ?? "";
      continue;
    }
    const kv = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) throw new Error(`cannot read TOML line: ${line}`);
    const value = JSON.parse(kv[2] ?? "") as unknown;
    if (table === "mcp_servers.gaugeline" && kv[1] === "command") launch.command = String(value);
    else if (table === "mcp_servers.gaugeline" && kv[1] === "args") launch.args = value as string[];
    else if (table === "mcp_servers.gaugeline.env") launch.env[kv[1] ?? ""] = String(value);
    else throw new Error(`unexpected TOML key ${table}.${kv[1]}`);
  }
  return launch;
}

const READERS: Record<string, (body: string) => Launch> = {
  json: fromServersJson,
  toml: fromCodexToml,
};

function launchOf(b: Block): Launch {
  const id = clientOf(b) ?? "";
  if (id === "claude-code") return fromClaudeCodeCommand(b.body);
  if (id === "vscode-command") return fromVsCodeCommand(b.body);
  const lang = b.info.split(/\s+/)[0] ?? "";
  const reader = READERS[lang];
  if (!reader) throw new Error(`no reader for ${id} (${lang})`);
  return reader(b.body);
}

const snippets = blocks(page)
  .filter((b) => clientOf(b) !== undefined)
  .map((b) => ({ id: clientOf(b) ?? "", launch: launchOf(b) }));

/**
 * What a client does with `npx -y gaugeline-mcp ...rest`: it starts the published package. Nothing is
 * published from CI, so the same arguments start the built bin instead. Any other command is refused
 * here, so a snippet cannot quietly start something this test does not understand.
 */
function asLaunched(l: Launch, extra: string[] = []) {
  expect(l.command, "a documented snippet starts the package with npx").toBe("npx");
  const rest = l.args[0] === "-y" ? l.args.slice(1) : l.args;
  expect(rest[0], "the package is gaugeline-mcp, with no version or scope").toBe("gaugeline-mcp");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !k.startsWith("npm_config_")) env[k] = v;
  for (const [k, v] of Object.entries(l.env)) env[k] = v;
  return { command: process.execPath, args: [bin, ...rest.slice(1), ...extra], env };
}

async function start(l: Launch, extra: string[] = []) {
  expect(existsSync(bin), "run pnpm build first: the built bin is under test").toBe(true);
  const client = new Client({ name: "install-docs", version: "0" });
  clients.push(client);
  await client.connect(new StdioClientTransport({ ...asLaunched(l, extra), stderr: "ignore" }));
  return client;
}

/** The tools a client sees with no flags: those whose `enabled` rule is absent or true for default options. */
const defaultTools = Object.entries(TOOLS)
  .filter(([, d]) => !d.enabled || d.enabled({}))
  .map(([n]) => n)
  .sort();

const documentedTools = (): string[] => {
  const b = blocks(page).find((x) => /(?:^|\s)tools-list(?:\s|$)/.test(x.info));
  if (!b) throw new Error("the page has no tools-list output block");
  return (JSON.parse(b.body) as string[]).slice().sort();
};

const EXPECTED_CLIENTS = [
  "claude-code",
  "claude-desktop",
  "claude-desktop-local",
  "codex",
  "cursor",
  "vscode",
  "vscode-command",
  "windsurf",
];

describe("docs/mcp-install.md snippets", () => {
  it("has a tested snippet for every client the page names", () => {
    expect(snippets.map((s) => s.id).sort()).toEqual(EXPECTED_CLIENTS);
    for (const s of snippets) expect(page).toContain(`## ${titleOf(s.id)}`);
  });

  it("documents exactly the tools the server offers by default, and the six in the tools table", () => {
    expect(documentedTools()).toEqual(defaultTools);
    const table = read("mcp.md");
    for (const name of Object.keys(TOOLS)) expect(table).toContain(`\`${name}\``);
    expect(page).toContain("`plan_check`");
  });

  it("puts no key in any snippet: an env value is empty or a ${NAME} reference", () => {
    for (const s of snippets)
      for (const [k, v] of Object.entries(s.launch.env))
        expect(v, `${s.id} env ${k}`).toMatch(/^(\$\{[A-Z][A-Z0-9_]*\})?$/);
    expect(page).not.toMatch(/Bearer\s+[A-Za-z0-9._~+/-]{12,}/);
  });

  it("starts the published package by name and never from a path on someone's disk", () => {
    for (const s of snippets) {
      expect(s.launch.command, s.id).toBe("npx");
      expect(s.launch.args.join(" "), s.id).toMatch(/^(-y )?gaugeline-mcp( --[a-z-]+( \S+)?)*$/);
    }
  });

  describe.each(EXPECTED_CLIENTS)("%s", (id) => {
    const snippet = () => {
      const s = snippets.find((x) => x.id === id);
      if (!s) throw new Error(`no snippet for ${id}`);
      return s.launch;
    };

    it("starts, completes initialize and lists the documented tools", async () => {
      const client = await start(snippet());
      expect(client.getServerVersion()?.name).toBe("gaugeline");
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(documentedTools());
      for (const t of tools) expect(t.description ?? "", t.name).toMatch(/^\[(read|draft)\]/);
    }, 60000);

    it("checks the bar fixture site, GET and HEAD only", async () => {
      const fixture = await startFixture("corner-bar");
      fixtures.push(fixture);
      // A fixture lives on a private address: the snippet that says so starts as written, the rest get the flag.
      const local = snippet().args.includes("--allow-private");
      const client = await start(snippet(), local ? [] : ["--allow-private"]);
      const run = jsonOf<{ runId: string; kind: string; summary: Record<string, number> }>(
        await client.callTool({ name: "run_check", arguments: { url: `${fixture.origin}/` } }),
      );
      expect(run.kind).toBe("read");
      expect(run.summary.passed).toBeGreaterThan(0);
      expect(fixture.total).toBeGreaterThan(0);
      expect([...fixture.methods.keys()].every((m) => m === "GET" || m === "HEAD")).toBe(true);
    }, 60000);
  });
});

const TITLES: Record<string, string> = {
  "claude-code": "Claude Code",
  "claude-desktop": "Claude Desktop",
  "claude-desktop-local": "Claude Desktop",
  codex: "Codex",
  cursor: "Cursor",
  vscode: "VS Code",
  "vscode-command": "VS Code",
  windsurf: "Windsurf",
};
function titleOf(id: string): string {
  return TITLES[id] ?? id;
}
