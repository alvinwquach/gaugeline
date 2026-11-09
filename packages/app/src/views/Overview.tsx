import { useId } from "react";
import { AREA_ORDER, CHECK_TITLES, SAMPLE_NOUNS } from "../check-titles";
import type { RunState } from "../store";
import { LEVELS, LEVEL_LABEL, type Finding, type Level, type Result } from "../types";

/** How many findings "Where to start" names. */
const START_COUNT = 3;
/** The evidence line is the page's own words; this many characters of it are enough to see what it is. */
const EVIDENCE_CHARS = 200;

const LEVEL_RANK: Readonly<Record<Level, number>> = { high: 0, medium: 1, low: 2 };

/** The first three findings by level (Fix this first, then Fix soon, then Worth knowing), each level in the order of the result. */
export function whereToStart(findings: readonly Finding[]): Finding[] {
  return findings
    .map((f, i) => ({ f, i }))
    .sort((a, b) => LEVEL_RANK[a.f.severity] - LEVEL_RANK[b.f.severity] || a.i - b.i)
    .slice(0, START_COUNT)
    .map(({ f }) => f);
}

/** "30 of 112 links checked", "all 14 links checked", "the 1 link checked"; nothing for a kind with nothing found. */
export function sampleLines(sampled: Result["sampled"]): string[] {
  const lines: string[] = [];
  for (const [kind, { seen, taken }] of Object.entries(sampled)) {
    if (seen === 0) continue;
    const [one, many] = SAMPLE_NOUNS[kind] ?? [kind, kind];
    const noun = seen === 1 ? one : many;
    if (kind === "frameworkAddresses") lines.push(`${seen} ${noun} ignored (never requested)`);
    else if (taken >= seen)
      lines.push(seen === 1 ? `the 1 ${noun} checked` : `all ${seen} ${noun} checked`);
    else lines.push(`${taken} of ${seen} ${noun} checked`);
  }
  return lines;
}

/** Passed check ids as titles, grouped by area in the report's order. An id this build has no title for is listed as itself. */
function lookedRight(passed: readonly string[]): { area: string; titles: string[] }[] {
  const byArea = new Map<string, string[]>();
  for (const id of passed) {
    const [title, area] = CHECK_TITLES[id] ?? [id, "Other checks"];
    byArea.set(area, [...(byArea.get(area) ?? []), title]);
  }
  return [...AREA_ORDER, "Other checks"].flatMap((area) => {
    const titles = byArea.get(area);
    return titles ? [{ area, titles }] : [];
  });
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  );
}

/** Every value from the checked page is a text child: React escapes it, and nothing here sets HTML. */
export function Overview({ run }: { run: RunState }) {
  return (
    <>
      <h1>Overview</h1>
      <p className="subject">{run.url}</p>
      <Body run={run} />
    </>
  );
}

function Body({ run }: { run: RunState }) {
  if (run.state === "running")
    return (
      <Section title="Checking this page">
        <ul className="steps" aria-label="Progress" aria-live="polite">
          {run.steps.map((s) => (
            <li key={s.id}>{s.text}</li>
          ))}
        </ul>
      </Section>
    );
  if (run.state === "failed")
    return (
      <Section title="This check could not run">
        <p className="notice">{run.reason ?? run.loadError ?? "Loading the reason..."}</p>
      </Section>
    );
  if (!run.result) return <p className="notice">{run.loadError ?? "Loading the results..."}</p>;

  const { findings, passed, couldNotCheck, sampled } = run.result;
  const counts = LEVELS.map((level) => ({
    level,
    n: findings.filter((f) => f.severity === level).length,
  }));
  const groups = lookedRight(passed);
  const lines = sampleLines(sampled);
  return (
    <>
      <Section title="What was found">
        <ul className="levels">
          {counts.map(({ level, n }) => (
            <li key={level} className={`level level-${level}`}>
              <span className="level-count">{n}</span>
              <span className="level-label">{LEVEL_LABEL[level]}</span>
            </li>
          ))}
        </ul>
      </Section>

      {findings.length === 0 ? (
        <p className="all-clear">Nothing to fix. Every check that ran passed.</p>
      ) : (
        <Section title="Where to start">
          <ol className="start">
            {whereToStart(findings).map((f, i) => (
              <li key={`${f.checkId}-${i}`} className={`start-item level-${f.severity}`}>
                <h3>{f.title}</h3>
                <p className="meta">
                  <span className={`chip level-${f.severity}`}>{LEVEL_LABEL[f.severity]}</span>{" "}
                  <span className="where">{f.url}</span>
                </p>
                <p className="evidence">
                  {f.evidence.length > EVIDENCE_CHARS
                    ? `${f.evidence.slice(0, EVIDENCE_CHARS)}...`
                    : f.evidence}
                </p>
              </li>
            ))}
          </ol>
        </Section>
      )}

      {groups.length > 0 ? (
        <Section title="What looked right">
          <p className="muted">
            {passed.length === 1 ? "1 check passed." : `${passed.length} checks passed.`}
          </p>
          {groups.map(({ area, titles }) => (
            <div key={area} className="area">
              <h3>{area}</h3>
              <ul className="ok">
                {titles.map((t, i) => (
                  <li key={`${t}-${i}`}>{t}</li>
                ))}
              </ul>
            </div>
          ))}
        </Section>
      ) : null}

      <Section title="How much was checked">
        {lines.length === 0 ? (
          <p>Nothing was sampled: the page had no links, images or other addresses to read.</p>
        ) : (
          <ul>
            {lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        )}
      </Section>

      {couldNotCheck.length > 0 ? (
        <Section title="Could not check">
          <ul>
            {couldNotCheck.map((c, i) => (
              <li key={`${c.id}-${i}`}>
                {CHECK_TITLES[c.id]?.[0] ?? c.id}: {c.reason} ({c.url})
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </>
  );
}
