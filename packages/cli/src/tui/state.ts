import type { CheckRegistry, Result } from "@gaugeline/core";

/** One row of the left pane: a finding, or a check that could not be checked. */
export interface Item {
  group: "high" | "medium" | "low" | "could-not-check";
  checkId: string;
  title: string;
  evidence: string;
  url: string;
  why?: string;
  fix?: string;
}

export interface ViewState {
  items: Item[];
  passed: number;
  cursor: number;
  expanded: boolean;
  filter: string;
  filtering: boolean;
  /** The reason being typed for a dismissal, or undefined when not dismissing. */
  dismissing?: string;
  /** Keys of dismissed items ("checkId url"). */
  dismissed: ReadonlySet<string>;
  quit: boolean;
}

/** A keypress as node:readline reports it. */
export interface Key {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
}

export interface Dismissal {
  checkId: string;
  url: string;
  reason: string;
}

const GROUP_ORDER: Readonly<Record<Item["group"], number>> = {
  high: 0,
  medium: 1,
  low: 2,
  "could-not-check": 3,
};

export const GROUP_LABEL: Readonly<Record<Item["group"], string>> = {
  high: "Fix this first",
  medium: "Fix soon",
  low: "Worth knowing",
  "could-not-check": "Couldn't check",
};

const keyOf = (i: Pick<Item, "checkId" | "url">) => `${i.checkId} ${i.url}`;

export function initialState(result: Result, registry: CheckRegistry): ViewState {
  const items: Item[] = [
    ...result.findings.map((f) => {
      const c = registry.get(f.checkId);
      return {
        group: f.severity,
        checkId: f.checkId,
        title: f.title,
        evidence: f.evidence,
        url: f.url,
        ...(c ? { why: c.why, fix: c.fix } : {}),
      };
    }),
    ...result.couldNotCheck.map((c) => ({
      group: "could-not-check" as const,
      checkId: c.id,
      title: registry.get(c.id)?.title ?? c.id,
      evidence: c.reason,
      url: c.url,
    })),
  ].sort((a, b) => GROUP_ORDER[a.group] - GROUP_ORDER[b.group]);
  return {
    items,
    passed: result.passed.length,
    cursor: 0,
    expanded: false,
    filter: "",
    filtering: false,
    dismissed: new Set(),
    quit: false,
  };
}

/** The items shown: not dismissed, and matching the filter in title, check id or evidence. */
export function visible(s: ViewState): Item[] {
  const q = s.filter.toLowerCase();
  return s.items.filter(
    (i) =>
      !s.dismissed.has(keyOf(i)) &&
      (q === "" || `${i.title} ${i.checkId} ${i.evidence}`.toLowerCase().includes(q)),
  );
}

const typed = (k: Key): string | undefined =>
  !k.ctrl && k.sequence && k.sequence.length === 1 && k.sequence >= " " ? k.sequence : undefined;

/** One keypress: the next state, and a dismissal when one was confirmed. Pure. */
export function reduce(s: ViewState, k: Key): { state: ViewState; dismissed?: Dismissal } {
  const clamp = (st: ViewState) => ({
    ...st,
    cursor: Math.max(0, Math.min(st.cursor, visible(st).length - 1)),
  });
  if (k.ctrl && k.name === "c") return { state: { ...s, quit: true } };
  if (s.dismissing !== undefined) {
    if (k.name === "escape") return { state: { ...s, dismissing: undefined } as ViewState };
    if (k.name === "backspace") return { state: { ...s, dismissing: s.dismissing.slice(0, -1) } };
    if (k.name === "return") {
      const item = visible(s)[s.cursor];
      const reason = s.dismissing.trim();
      if (!item || reason === "") return { state: s };
      const dismissed = new Set(s.dismissed).add(keyOf(item));
      const next = clamp({ ...s, dismissing: undefined, dismissed, expanded: false } as ViewState);
      return { state: next, dismissed: { checkId: item.checkId, url: item.url, reason } };
    }
    const c = typed(k);
    return { state: c ? { ...s, dismissing: s.dismissing + c } : s };
  }
  if (s.filtering) {
    if (k.name === "escape" || k.name === "return") return { state: { ...s, filtering: false } };
    if (k.name === "backspace") return { state: clamp({ ...s, filter: s.filter.slice(0, -1) }) };
    const c = typed(k);
    return { state: c ? clamp({ ...s, filter: s.filter + c, cursor: 0 }) : s };
  }
  switch (k.name) {
    case "down":
    case "j":
      return { state: clamp({ ...s, cursor: s.cursor + 1, expanded: false }) };
    case "up":
    case "k":
      return { state: clamp({ ...s, cursor: s.cursor - 1, expanded: false }) };
    case "return":
      return { state: { ...s, expanded: !s.expanded } };
    case "d":
      return { state: visible(s).length > 0 ? { ...s, dismissing: "" } : s };
    case "q":
      return { state: { ...s, quit: true } };
    default:
      return k.sequence === "/" || k.name === "/"
        ? { state: { ...s, filtering: true } }
        : { state: s };
  }
}

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(" ")) {
      if (line !== "" && line.length + 1 + word.length > width) {
        out.push(line);
        line = word;
      } else line = line === "" ? word : `${line} ${word}`;
    }
    out.push(line);
  }
  return out.map((l) => (l.length > width ? `${l.slice(0, width - 1)}…` : l));
}

const cut = (s: string, w: number) => (s.length > w ? `${s.slice(0, Math.max(0, w - 1))}…` : s);

export const FOOTER = "j/k move · enter expand · / filter · d dismiss · q quit";

/** The whole screen as text: findings on the left, the selected one on the right, keys at the foot. */
export function render(s: ViewState, cols: number, rows: number): string {
  const leftW = Math.max(24, Math.floor(cols * 0.42));
  const rightW = cols - leftW - 3;
  const items = visible(s);
  const left: string[] = [];
  let group: Item["group"] | undefined;
  items.forEach((i, n) => {
    if (i.group !== group) {
      group = i.group;
      left.push(GROUP_LABEL[i.group]);
    }
    left.push(cut(`${n === s.cursor ? ">" : " "} ${i.title}`, leftW));
  });
  if (items.length === 0)
    left.push(s.items.length === 0 ? "Nothing to fix." : "Nothing matches the filter.");
  left.push("", `${s.passed} check${s.passed === 1 ? "" : "s"} passed`);
  const right: string[] = [];
  const sel = items[s.cursor];
  if (sel) {
    right.push(...wrap(sel.title, rightW), "");
    right.push(...wrap(sel.evidence, rightW));
    right.push(...wrap(`${sel.checkId} · ${sel.url}`, rightW));
    if (sel.why) right.push("", ...wrap(`Why it matters: ${sel.why}`, rightW));
    if (s.expanded && sel.fix) right.push("", ...wrap(`How to fix: ${sel.fix}`, rightW));
  }
  const body = Math.max(1, rows - 2);
  const lines: string[] = [];
  for (let r = 0; r < body; r++)
    lines.push(`${(left[r] ?? "").padEnd(leftW)} │ ${right[r] ?? ""}`.trimEnd());
  const status =
    s.dismissing !== undefined
      ? `Dismiss because: ${s.dismissing}_  (enter to save, esc to cancel)`
      : s.filtering
        ? `Filter: ${s.filter}_  (enter or esc to finish)`
        : s.filter
          ? `Filter: ${s.filter}`
          : "";
  lines.push(cut(status, cols), cut(FOOTER, cols));
  return lines.join("\n");
}
