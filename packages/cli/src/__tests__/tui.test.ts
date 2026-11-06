import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildResult, createPageRegistry, type Finding } from "@gaugeline/core";
import { afterEach, describe, expect, it } from "vitest";
import { applyIgnore, readIgnore } from "../ignore.js";
import { runView } from "../tui/app.js";
import { initialState, reduce, render, visible, type Key } from "../tui/state.js";
import { runBin } from "./helpers/bin.js";

const registry = createPageRegistry();
const f = (
  checkId: string,
  severity: Finding["severity"],
  title: string,
  evidence: string,
): Finding => ({
  checkId,
  severity,
  title,
  evidence,
  url: "https://shop.example/",
});
const result = buildResult({
  url: "https://shop.example/",
  startedAt: new Date(0),
  findings: [
    f(
      "canonical-elsewhere",
      "high",
      "This page tells Google to show a different page",
      "canonical -> /tools",
    ),
    f("og-image-missing", "medium", "Shared links have no picture", "no og:image"),
    f("links-via-redirect", "low", "Links go through redirects", "/old -> /new"),
  ],
  passed: ["noindex", "viewport"],
  failed: [],
  couldNotCheck: [
    { id: "broken-links", reason: "rate limited (429)", url: "https://shop.example/busy" },
  ],
});
const keys = (state: ReturnType<typeof initialState>, ...ks: Key[]) =>
  ks.reduce((s, k) => reduce(s, k).state, state);
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("tui: unit (grouping and filter)", () => {
  it("findings are grouped fix first, fix soon, worth knowing, then couldn't check", () => {
    const s = initialState(result, registry);
    expect(s.items.map((i) => [i.group, i.checkId])).toEqual([
      ["high", "canonical-elsewhere"],
      ["medium", "og-image-missing"],
      ["low", "links-via-redirect"],
      ["could-not-check", "broken-links"],
    ]);
  });

  it("/ filters by title, check id or evidence, case-insensitively; escape leaves the filter", () => {
    let s = keys(
      initialState(result, registry),
      { name: "/" },
      ...[..."PICTURE"].map((c) => ({ name: c, sequence: c })),
    );
    expect(visible(s).map((i) => i.checkId)).toEqual(["og-image-missing"]);
    s = keys(s, { name: "escape" });
    expect(s.filtering).toBe(false);
    expect(visible(s)).toHaveLength(1);
    s = keys(
      s,
      { name: "/" },
      { name: "backspace" },
      { name: "backspace" },
      { name: "backspace" },
      { name: "backspace" },
      { name: "backspace" },
      { name: "backspace" },
      { name: "backspace" },
    );
    expect(visible(s)).toHaveLength(4);
  });

  it("j/k and the arrows move; enter expands; q quits", () => {
    let s = keys(initialState(result, registry), { name: "j" }, { name: "down" });
    expect(s.cursor).toBe(2);
    s = keys(s, { name: "k" }, { name: "return" });
    expect([s.cursor, s.expanded]).toEqual([1, true]);
    expect(keys(s, { name: "q" }).quit).toBe(true);
  });

  it("d asks for a reason; enter with a reason dismisses and reports the dismissal; an empty reason doesn't", () => {
    let s = keys(initialState(result, registry), { name: "d" });
    expect(s.dismissing).toBe("");
    expect(reduce(s, { name: "return" }).dismissed).toBeUndefined();
    s = keys(s, ...[..."known"].map((c) => ({ name: c, sequence: c })));
    const r = reduce(s, { name: "return" });
    expect(r.dismissed).toEqual({
      checkId: "canonical-elsewhere",
      url: "https://shop.example/",
      reason: "known",
    });
    expect(visible(r.state).map((i) => i.checkId)).not.toContain("canonical-elsewhere");
  });
});

describe("tui: integration (rendering a run)", () => {
  it("moving and expanding change the right pane; the footer shows the keys", () => {
    const s = initialState(result, registry);
    const first = render(s, 140, 24);
    expect(first).toContain("> This page tells Google to show a different page");
    expect(first).toContain("canonical -> /tools");
    expect(first).toContain("j/k move · enter expand · / filter · d dismiss · q quit");
    const moved = render(keys(s, { name: "j" }), 140, 24);
    expect(moved).toContain("no og:image");
    const expanded = render(keys(s, { name: "return" }), 140, 24);
    expect(expanded).toContain("How to fix:");
  });

  it("a run with no findings shows what was checked", () => {
    const empty = buildResult({
      url: "https://shop.example/",
      startedAt: new Date(0),
      findings: [],
      passed: ["noindex"],
      failed: [],
    });
    const out = render(initialState(empty, registry), 100, 24);
    expect(out).toContain("Nothing to fix.");
    expect(out).toContain("1 check passed");
  });

  it("the keyboard loop: a saved run is filtered and a finding dismissed with a reason, then q quits", async () => {
    const stdin = Object.assign(new EventEmitter(), {
      isTTY: true,
      setRawMode: () => undefined,
      resume: () => undefined,
      pause: () => undefined,
    });
    const out: string[] = [];
    const stdout = { isTTY: true, columns: 100, rows: 24, write: (s: string) => out.push(s) };
    const dismissed: unknown[] = [];
    const done = runView({ result, registry, stdin, stdout, onDismiss: (d) => dismissed.push(d) });
    const press = (name: string, sequence = name) =>
      stdin.emit("keypress", sequence, { name, sequence });
    press("/");
    for (const c of "redirect") press(c);
    press("return");
    press("d");
    for (const c of "fine") press(c);
    press("return");
    press("q");
    await done;
    expect(dismissed).toEqual([
      { checkId: "links-via-redirect", url: "https://shop.example/", reason: "fine" },
    ]);
    expect(out.join("")).toContain("Links go through redirects");
  });
});

describe("tui: dismissals and the ignore list", () => {
  it("a dismissal is written to gaugeline.ignore.json, and a later run leaves that finding out", () => {
    const cwd = mkdtempSync(join(tmpdir(), "gaugeline-ignore-"));
    dirs.push(cwd);
    writeFileSync(
      join(cwd, "gaugeline.ignore.json"),
      JSON.stringify({
        ignore: [
          { checkId: "og-image-missing", url: "https://shop.example/", reason: "no picture yet" },
        ],
      }),
    );
    const list = readIgnore(cwd);
    const kept = applyIgnore(result.findings, list);
    expect(kept.kept.map((x) => x.checkId)).toEqual(["canonical-elsewhere", "links-via-redirect"]);
    expect(kept.dismissed).toBe(1);
    expect(
      JSON.parse(readFileSync(join(cwd, "gaugeline.ignore.json"), "utf8")).ignore,
    ).toHaveLength(1);
  });
});

describe("tui: e2e (the built command)", () => {
  it("gaugeline view on a saved run, with keys sent to it, exits 0; piped, it falls back to the plain report", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "gaugeline-view-"));
    dirs.push(cwd);
    writeFileSync(join(cwd, "run.json"), JSON.stringify(result));
    const r = await runBin(["view", "run.json"], { NO_COLOR: "1" }, { cwd });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("✗ This page tells Google to show a different page");
    expect(r.stdout).toContain("? broken-links could not be checked: rate limited (429)");
  });

  it("a window narrower than 60 columns falls back to the plain report", async () => {
    const stdin = Object.assign(new EventEmitter(), {
      isTTY: true,
      setRawMode: () => undefined,
      resume: () => undefined,
      pause: () => undefined,
    });
    const out: string[] = [];
    const stdout = { isTTY: true, columns: 50, rows: 24, write: (s: string) => out.push(s) };
    await runView({ result, registry, stdin, stdout, onDismiss: () => undefined });
    expect(out.join("")).toContain("✗ This page tells Google to show a different page\n");
    expect(out.join("")).not.toContain("j/k move");
  });
});
