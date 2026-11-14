import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { CHECK_TEXT } from "../check-titles";
import { areaOf, facetCounts, filterFindings, type Filters } from "../problems/filter";
import { buildNote } from "../problems/note";
import { formatHash, useRoute } from "../route";
import type { RunState } from "../store";
import { LEVELS, LEVEL_LABEL, type Finding, type Level } from "../types";

/** A finding with its place in the result, which is what the address names (#/<run>/problems/<index>). */
type Item = Finding & { index: number };

const NO_FILTERS: Filters = { levels: new Set(), areas: new Set() };

/** The index the address names, if it is a whole number that is a finding of this run. */
function openIndex(item: string | null, count: number): number | null {
  if (item === null || !/^\d+$/.test(item)) return null;
  const n = Number(item);
  return n < count ? n : null;
}

/** Every value from the checked page is a text child: React escapes it, and nothing here sets HTML. */
export function Problems({ run }: { run: RunState }) {
  // A new key is a new view: the filters (and the open technical lines) start over for each run.
  return <ProblemsBody key={run.id} run={run} />;
}

function ProblemsBody({ run }: { run: RunState }) {
  return (
    <>
      <h1>Problems</h1>
      <p className="subject">{run.url}</p>
      <Content run={run} />
    </>
  );
}

function Content({ run }: { run: RunState }) {
  if (run.state === "running")
    return (
      <p className="notice">
        This page is still checking. Its problems appear here when it is done.
      </p>
    );
  if (run.state === "failed")
    return <p className="notice">{run.reason ?? run.loadError ?? "This check could not run."}</p>;
  if (!run.result) return <p className="notice">{run.loadError ?? "Loading the results..."}</p>;
  if (run.result.findings.length === 0)
    return (
      <>
        <p className="all-clear">Nothing needs fixing.</p>
        <p>
          What Gaugeline looked at, and what looked right, is on the{" "}
          <a href={formatHash(run.id, "overview")}>Overview</a>.
        </p>
      </>
    );
  return <List run={run} findings={run.result.findings} />;
}

function List({ run, findings }: { run: RunState; findings: readonly Finding[] }) {
  const route = useRoute();
  const { go } = route;
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const urgencyId = useId();
  const areaId = useId();
  const items = useMemo<Item[]>(() => findings.map((f, index) => ({ ...f, index })), [findings]);
  const facets = useMemo(() => facetCounts(findings), [findings]);
  const shown = useMemo(() => filterFindings(items, filters), [items, filters]);
  const open = openIndex(route.item, findings.length);

  const close = useCallback(() => go(run.id, "problems", true), [go, run.id]);
  const toggle = useCallback(
    (index: number, isOpen: boolean) => {
      if (isOpen) go(run.id, "problems", true);
      else go(run.id, "problems", true, index);
    },
    [go, run.id],
  );

  /** Switch one choice on or off. A finding the new filters hide is closed, so the address never names one you cannot see. */
  const flip = <K extends keyof Filters>(which: K, value: string) => {
    const next = new Set<string>(filters[which] as ReadonlySet<string>);
    if (!next.delete(value)) next.add(value);
    const nextFilters = { ...filters, [which]: next } as Filters;
    setFilters(nextFilters);
    const current = open === null ? undefined : items[open];
    if (current && filterFindings([current], nextFilters).length === 0) close();
  };
  const clear = () => setFilters(NO_FILTERS);

  const groups = LEVELS.map((level) => ({
    level,
    items: shown.filter((f) => f.severity === level),
  })).filter((g) => g.items.length > 0);
  const filtering = filters.levels.size > 0 || filters.areas.size > 0;
  const noun = findings.length === 1 ? "problem" : "problems";

  return (
    <>
      <div className="filters">
        <div role="group" aria-labelledby={urgencyId} className="filter-group">
          <span id={urgencyId} className="filter-label">
            Urgency
          </span>
          {LEVELS.map((level) => (
            <FilterButton
              key={level}
              label={LEVEL_LABEL[level]}
              count={facets.levels.get(level) ?? 0}
              pressed={filters.levels.has(level)}
              className={`level-${level}`}
              onPress={() => flip("levels", level)}
            />
          ))}
        </div>
        <div role="group" aria-labelledby={areaId} className="filter-group">
          <span id={areaId} className="filter-label">
            Area
          </span>
          {[...facets.areas].map(([area, count]) => (
            <FilterButton
              key={area}
              label={area}
              count={count}
              pressed={filters.areas.has(area)}
              onPress={() => flip("areas", area)}
            />
          ))}
        </div>
        {filtering ? (
          <button type="button" className="link-button" onClick={clear}>
            Clear filters
          </button>
        ) : null}
      </div>

      <h2 className="count">
        Showing {shown.length} of {findings.length} {noun}
      </h2>

      {groups.length === 0 ? (
        <p className="notice">No problems match these filters.</p>
      ) : (
        groups.map((g) => (
          <Group key={g.level} level={g.level}>
            {g.items.map((f) => (
              <Row
                key={f.index}
                finding={f}
                index={f.index}
                url={run.url}
                open={f.index === open}
                onToggle={toggle}
              />
            ))}
          </Group>
        ))
      )}
    </>
  );
}

function FilterButton({
  label,
  count,
  pressed,
  className,
  onPress,
}: {
  label: string;
  count: number;
  pressed: boolean;
  className?: string;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      className={`filter ${className ?? ""}`}
      aria-pressed={pressed}
      onClick={onPress}
    >
      {label} ({count})
    </button>
  );
}

function Group({ level, children }: { level: Level; children: React.ReactNode }) {
  const id = useId();
  const n = Array.isArray(children) ? children.length : 1;
  return (
    <section aria-labelledby={id} className={`problem-group level-${level}`}>
      <h3 id={id}>
        {LEVEL_LABEL[level]} ({n})
      </h3>
      <ul className="problems">{children}</ul>
    </section>
  );
}

/** A closed finding costs one button and one line, so a list of hundreds stays quick to filter. */
const Row = memo(function Row({
  finding,
  index,
  url,
  open,
  onToggle,
}: {
  finding: Finding;
  index: number;
  url: string;
  open: boolean;
  onToggle: (index: number, isOpen: boolean) => void;
}) {
  const panel = `problem-${index}-detail`;
  return (
    <li className={`problem level-${finding.severity}`}>
      <h4>
        <button
          type="button"
          className="finding-toggle"
          aria-expanded={open}
          aria-controls={open ? panel : undefined}
          onClick={() => onToggle(index, open)}
        >
          {finding.title}
        </button>
      </h4>
      <p className="meta">
        <span className="area-tag">{areaOf(finding)}</span>{" "}
        <span className="where">{finding.url}</span>
      </p>
      {open ? <Detail id={panel} finding={finding} url={url} /> : null}
    </li>
  );
});

type CopyState = "idle" | "copied" | "manual";

function Detail({ id, finding, url }: { id: string; finding: Finding; url: string }) {
  const text = CHECK_TEXT[finding.checkId];
  const [showTech, setShowTech] = useState(false);
  const [copy, setCopy] = useState<CopyState>("idle");
  const box = useRef<HTMLTextAreaElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const techId = `${id}-tech`;
  const noteId = `${id}-note`;

  // A finding opened from the address on load may be far down the list.
  useEffect(() => {
    const el = root.current;
    if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
  }, []);

  // The fallback shows the note already selected, so Ctrl+C is all that is left to do.
  useEffect(() => {
    if (copy !== "manual") return;
    box.current?.focus();
    box.current?.select();
  }, [copy]);

  const copyNote = async () => {
    const note = buildNote(finding, { url });
    try {
      // Missing on a page that is not a secure context and in old browsers; it can also refuse
      // (no permission, no focus), by rejecting or by throwing. Every one of those ends in the textarea.
      const clipboard: Clipboard | undefined = navigator.clipboard;
      if (!clipboard) throw new Error("no clipboard");
      await clipboard.writeText(note);
      setCopy("copied");
    } catch {
      setCopy("manual");
    }
  };

  return (
    <div className="detail" id={id} ref={root}>
      {text ? (
        <>
          <h5>What was found</h5>
          <p>{text[0]}</p>
          <h5>Why it matters</h5>
          <p>{text[1]}</p>
          <h5>How to fix it</h5>
          <p>{text[2]}</p>
        </>
      ) : (
        <p className="muted">
          This version of Gaugeline does not know this check, so it has no plain-English text for
          it. What it found is below.
        </p>
      )}
      {finding.evidence.trim() === "" ? null : (
        <>
          <h5>Evidence</h5>
          <p className="evidence">{finding.evidence}</p>
        </>
      )}
      <div className="actions">
        {text ? (
          <button
            type="button"
            aria-expanded={showTech}
            aria-controls={showTech ? techId : undefined}
            onClick={() => setShowTech(!showTech)}
          >
            {showTech ? "Hide technical detail" : "Show technical detail"}
          </button>
        ) : null}
        <button type="button" onClick={() => void copyNote()}>
          Copy note for your developer
        </button>
      </div>
      {text && showTech ? (
        <p className="tech" id={techId}>
          {text[3]}
        </p>
      ) : null}
      <p className="copy-status" aria-live="polite">
        {copy === "copied"
          ? "Note copied to the clipboard."
          : copy === "manual"
            ? "Your browser would not let Gaugeline copy it, so copy it by hand: the note is selected below. Press Ctrl+C (Cmd+C on a Mac)."
            : ""}
      </p>
      {copy === "manual" ? (
        <>
          <label htmlFor={noteId} className="sr-only">
            Note for your developer
          </label>
          <textarea
            id={noteId}
            ref={box}
            className="note-box"
            readOnly
            rows={12}
            value={buildNote(finding, { url })}
          />
        </>
      ) : null}
    </div>
  );
}
