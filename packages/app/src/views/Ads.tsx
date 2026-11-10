import { useId, useMemo, useState } from "react";
import { formatMoney } from "../ads/money";
import { toAdsModel, type CurrencyModel, type DestinationRow, type FindingRef } from "../ads/model";
import { formatHash } from "../route";
import type { RunState } from "../store";

/**
 * The landing pages of an ads export (gaugeline open --ads): how much of the spend went to pages
 * with problems, then one row for each page with its ads, its spend and what was found. It reads the
 * model (toAdsModel), never the result, and runs no check. Every value from the export and from the
 * checked pages is a text child: React escapes it, and an address is never a link.
 */
export function Ads({ run }: { run: RunState }) {
  // A new key is a new view: the filter starts over for each run.
  return (
    <>
      <h1>Ads</h1>
      <p className="subject">{run.url}</p>
      <Content key={run.id} run={run} />
    </>
  );
}

function Content({ run }: { run: RunState }) {
  if (run.state === "running")
    return (
      <p className="notice">
        The pages in this export are still being checked. The summary appears here when that is
        done.
      </p>
    );
  if (run.state === "failed")
    return <p className="notice">{run.reason ?? run.loadError ?? "This check could not run."}</p>;
  if (run.loadError) return <p className="notice">{run.loadError}</p>;
  if (!run.result) return <p className="notice">Loading the results...</p>;
  if (!run.ads)
    return (
      <p className="notice">
        This check did not keep the list of landing pages. Open the export again to see it.
      </p>
    );
  return <Body run={run} ads={run.ads} result={run.result} />;
}

function Body({
  run,
  ads,
  result,
}: {
  run: RunState;
  ads: NonNullable<RunState["ads"]>;
  result: NonNullable<RunState["result"]>;
}) {
  const model = useMemo(() => toAdsModel(result, ads), [result, ads]);
  const { currencies } = model;
  if (currencies.every((c) => c.destinations.length === 0))
    return (
      <p className="notice">
        The export has no ads that link to a page, so there is nothing to show. Keep the link and
        amount-spent columns when you export.
      </p>
    );
  const many = currencies.length > 1;
  return (
    <>
      {many ? (
        <p className="notice">
          This export has more than one currency. Each is shown on its own: amounts in different
          currencies are never added together.
        </p>
      ) : null}
      {currencies.map((c, i) => (
        <Section key={c.currency ?? `none-${i}`} run={run} model={c} many={many} />
      ))}
      {model.unplaced.length > 0 ? (
        <p className="muted">
          {model.unplaced.length === 1
            ? "1 finding is about an address that is not one of the landing pages above."
            : `${model.unplaced.length} findings are about addresses that are not one of the landing pages above.`}{" "}
          <a href={formatHash(run.id, "problems")}>See them in Problems</a>.
        </p>
      ) : null}
    </>
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function Section({ run, model, many }: { run: RunState; model: CurrencyModel; many: boolean }) {
  const [onlyProblems, setOnlyProblems] = useState(false);
  const titleId = useId();
  const code = model.currency;
  const money = (n: number) => formatMoney(n, code, undefined);
  const problems = model.destinations.filter((d) => d.findings.length > 0);
  const shown = onlyProblems ? problems : model.destinations;
  const count = `Showing ${shown.length} of ${plural(model.destinations.length, "page", "pages")}`;
  return (
    <section aria-labelledby={titleId} className="ads-section">
      {many ? <h2>{code ?? "No currency named"}</h2> : null}
      <p
        id={titleId}
        className={`ads-summary ${model.problemSpend > 0 ? "has-problems" : "all-clear"}`}
      >
        {model.problemSpend > 0 ? (
          <>
            <strong>{money(model.problemSpend)}</strong> of {money(model.totalSpend)} went to pages
            with problems.
          </>
        ) : (
          <>
            No spend went to pages with problems. All {money(model.totalSpend)} went to pages that
            looked right.
          </>
        )}
      </p>
      <div className="filters">
        <div className="filter-group">
          <button
            type="button"
            className="filter"
            aria-pressed={onlyProblems}
            onClick={() => setOnlyProblems(!onlyProblems)}
          >
            Only pages with problems ({problems.length})
          </button>
        </div>
      </div>
      {shown.length === 0 ? (
        <>
          <p className="count">{count}</p>
          <p className="notice">No page has a problem.</p>
        </>
      ) : (
        <div className="table-wrap">
          <table className="ads-table">
            <caption>{count}</caption>
            <thead>
              <tr>
                <th scope="col">Landing page</th>
                <th scope="col" className="num">
                  Ads
                </th>
                <th scope="col" className="num">
                  Spend
                </th>
                <th scope="col">Findings</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <RowView key={row.url} row={row} runId={run.id} money={money} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function RowView({
  row,
  runId,
  money,
}: {
  row: DestinationRow;
  runId: string;
  money: (n: number) => string;
}) {
  return (
    <tr className={row.findings.length > 0 ? "row-problem" : undefined}>
      <th scope="row">
        <code dir="auto">{row.url}</code>
      </th>
      <td className="num">{row.ads}</td>
      <td className="num">{money(row.spend)}</td>
      <td>
        {row.findings.length === 0 ? (
          <span className="muted">None</span>
        ) : (
          <ul className="ads-findings">
            {row.findings.map((f) => (
              <FindingLink key={f.index} finding={f} runId={runId} />
            ))}
          </ul>
        )}
      </td>
    </tr>
  );
}

/** A finding opens in Problems (#/<run>/problems/<index>), where it can be copied as a note. */
function FindingLink({ finding, runId }: { finding: FindingRef; runId: string }) {
  return (
    <li className={`level-${finding.severity}`}>
      <a href={formatHash(runId, "problems", finding.index)}>{finding.title}</a>
    </li>
  );
}
